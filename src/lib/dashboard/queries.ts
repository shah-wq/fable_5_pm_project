import type { PoolClient } from 'pg';
import { withUser, type SessionIdentity } from '../db';
import { optionalRows } from '../db-optional';
import { STAGES, STAGE_LABELS, type StageKey } from '../stages/definitions';
import {
  buildWhere,
  resolvePeriod,
  statExpr,
  totalDaysColumn,
  type DashboardFilters,
  type Range,
  type ResolvedPeriod,
} from './filters';

/**
 * Every dashboard figure, aggregated in PostgreSQL.
 *
 * Two rules run through this file.
 *
 * The first is spec §10: aggregate in SQL, never in the browser. Pulling a few
 * thousand project rows into Node to count them is slow at a few hundred and
 * impossible at a few thousand, so every function here returns the finished
 * numbers — a handful of rows — and the `group by` happens in the database.
 *
 * The second is spec §1: group by the data, never by a hardcoded list. There is
 * no list of PMs or dealers anywhere in this file. `group by m.assigned_pm`
 * means a new hire's projects join the totals the first time one is assigned,
 * and the failure mode of the alternative — a chart configured with today's five
 * names, silently dropping the sixth — cannot happen.
 *
 * Reading order matches the spec's bands: headline, funnel + workload, cycle
 * time, then dealers/PMs/attention.
 */

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

const METRICS = 'public.project_metrics m';
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const maybe = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);
/** Rounded to a whole day: half a day of "average cycle time" means nothing. */
const days = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(Number(v)));
const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);

/** The active stages: Complete is terminal and leaves the funnel (spec §1). */
export const FUNNEL_STAGES = STAGES.filter((s) => s !== 'complete');

export const AGE_BANDS = ['0-14', '15-30', '31-60', '60+'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

/**
 * Is the dashboard's schema present?
 *
 * One probe, not one guard per query. Everything the dashboard reads either
 * predates this module or arrived with it in the same migration, so a single
 * savepoint-protected look at project_metrics settles it — and the page can then
 * say "the database is behind, run this file" once, instead of drawing nine
 * empty charts and letting the reader conclude the business has no projects.
 *
 * (Called on its own, before any other query on this client: optionalRows must
 * not overlap with itself — see db-optional.ts.)
 */
export async function dashboardReady(client: PoolClient): Promise<boolean> {
  // count(*) over a limited subquery, so exactly one row comes back whether or
  // not the company has any projects: an empty database is ready, a missing view
  // is not, and optionalRows returns [] for both if the query can return none.
  // The named columns are the ones this module depends on, so a half-applied
  // 002800 (view present, columns older) is caught too — 42703 rather than 42P01.
  const rows = await optionalRows<{ n: string }>(
    client,
    'the dashboard (public.project_metrics)',
    `select count(*) as n from (
       select m.id, m.is_ageing, m.hold_overdue, m.total_days_ex_hold,
              m.age_band, m.attention_days, m.survey_done_on
       from public.project_metrics m limit 1
     ) probe`
  );
  return rows.length > 0;
}

/** PostgreSQL's idea of today, so the numbers and their caption agree (§9). */
export async function serverToday(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ today: string }>(`select current_date::text as today`);
  return rows[0].today;
}

export interface DashboardContext {
  filters: DashboardFilters;
  period: ResolvedPeriod;
  viewerId: string;
}

/** Filter WHERE + params, with the period's two bounds bound first ($1, $2). */
function scoped(
  ctx: DashboardContext,
  basis: Parameters<typeof buildWhere>[1],
  range: Range = ctx.period.current
): { clause: string; params: unknown[] } {
  const where = buildWhere(ctx.filters, basis, range, ctx.viewerId, 0);
  return { clause: where.clause, params: where.params };
}

// ---------------------------------------------------------------------------
// Band 1 — headline numbers (spec §3)
// ---------------------------------------------------------------------------

export interface Headline {
  active: number;
  activeChange: number | null;
  completed: number;
  completedPrev: number;
  avgDaysToComplete: number | null;
  avgDaysToCompletePrev: number | null;
  onHold: number;
  onHoldThreshold: number;
  needsAttention: number;
  pipelineValue: number | null;
  /** 12 weekly points: the active count at the end of each week. */
  sparkline: Array<{ date: string; count: number }>;
}

export async function loadHeadline(
  client: PoolClient,
  ctx: DashboardContext,
  opts: { financial: boolean; onHoldThreshold: number }
): Promise<Headline> {
  const now = scoped(ctx, 'none');
  const inPeriod = scoped(ctx, 'completion_date');
  const prev = ctx.period.previous
    ? scoped(ctx, 'completion_date', ctx.period.previous)
    : null;

  // Current state: three of the six cards are "right now", not "in the period".
  // Active projects is a standing count — a month filter must not make it look
  // as though the business only has the projects it started this month.
  const state = await client.query(
    `select
       count(*) filter (where m.status not in ('complete', 'cancelled')) as active,
       count(*) filter (where m.status = 'on_hold') as on_hold,
       count(*) filter (where m.is_ageing) as needs_attention
       ${opts.financial
         ? `, sum(m.contract_value) filter (where m.status not in ('complete', 'cancelled')) as pipeline`
         : ''}
     from ${METRICS}
     where true${now.clause}`,
    now.params
  );

  const completedNow = await client.query(
    `select count(*) as n, ${statExpr(ctx.filters, totalDaysColumn(ctx.filters))} as avg_days
     from ${METRICS}
     where true${inPeriod.clause}`,
    inPeriod.params
  );

  const completedPrev = prev
    ? await client.query(
        `select count(*) as n, ${statExpr(ctx.filters, totalDaysColumn(ctx.filters))} as avg_days
         from ${METRICS}
         where true${prev.clause}`,
        prev.params
      )
    : null;

  const sparkline = await loadActiveSeries(client, ctx);
  const prevEnd = ctx.period.previous?.to ?? null;
  const activeAtPrevEnd = prevEnd ? await activeAt(client, ctx, prevEnd) : null;
  const active = num(state.rows[0].active);

  return {
    active,
    activeChange: activeAtPrevEnd === null ? null : active - activeAtPrevEnd,
    completed: num(completedNow.rows[0].n),
    completedPrev: completedPrev ? num(completedPrev.rows[0].n) : 0,
    avgDaysToComplete: days(completedNow.rows[0].avg_days),
    avgDaysToCompletePrev: completedPrev ? days(completedPrev.rows[0].avg_days) : null,
    onHold: num(state.rows[0].on_hold),
    onHoldThreshold: opts.onHoldThreshold,
    needsAttention: num(state.rows[0].needs_attention),
    pipelineValue: opts.financial ? maybe(state.rows[0].pipeline) : null,
    sparkline,
  };
}

/**
 * How many projects were live on a given day: created by then, and neither
 * completed nor cancelled by then. The same definition drives the sparkline and
 * the change indicator, so the last sparkline point and the "vs last period"
 * arrow can never contradict each other.
 */
async function activeAt(
  client: PoolClient,
  ctx: DashboardContext,
  date: string
): Promise<number> {
  const f = scoped(ctx, 'none');
  const { rows } = await client.query<{ n: string }>(
    `select count(*) as n
     from ${METRICS}
     where m.created_at::date <= $${f.params.length + 1}::date
       and (m.completion_date is null or m.completion_date > $${f.params.length + 1}::date)
       and (m.cancellation_date is null or m.cancellation_date > $${f.params.length + 1}::date)
       ${f.clause}`,
    [...f.params, date]
  );
  return num(rows[0].n);
}

/** Twelve weekly points ending at the period's end (§3's sparkline). */
async function loadActiveSeries(
  client: PoolClient,
  ctx: DashboardContext
): Promise<Array<{ date: string; count: number }>> {
  const f = scoped(ctx, 'none');
  const p = f.params.length;
  const { rows } = await client.query(
    `select w.d::date::text as date,
            (select count(*) from ${METRICS}
              where m.created_at::date <= w.d::date
                and (m.completion_date is null or m.completion_date > w.d::date)
                and (m.cancellation_date is null or m.cancellation_date > w.d::date)
                ${f.clause}) as n
     from generate_series($${p + 1}::date - interval '77 days', $${p + 1}::date, interval '7 days') w(d)
     order by 1`,
    [...f.params, ctx.period.current.to]
  );
  return rows.map((r) => ({ date: String(r.date), count: num(r.n) }));
}

// ---------------------------------------------------------------------------
// Band 2 — where every project is (spec §4)
// ---------------------------------------------------------------------------

export interface FunnelStage {
  stage: StageKey;
  label: string;
  count: number;
  share: number;
  bands: Record<AgeBand, number>;
  avgDaysInStage: number | null;
  oldest: { id: string; name: string; days: number } | null;
}

export interface Funnel {
  stages: FunnelStage[];
  activeTotal: number;
  onHold: number;
  cancelled: number;
}

export async function loadFunnel(client: PoolClient, ctx: DashboardContext): Promise<Funnel> {
  const f = scoped(ctx, 'none');

  // Counts split by age band, so a bar can be coloured by how long its projects
  // have been sitting (§4). A plain funnel says seven projects are in Permit;
  // this one says whether that is a healthy queue or six weeks of silence.
  const byBand = await client.query(
    `select m.stage::text as stage, m.age_band, count(*) as n, avg(m.days_in_stage) as avg_days
     from ${METRICS}
     where m.status = 'active' and m.stage <> 'complete'${f.clause}
     group by 1, 2`,
    f.params
  );

  // The oldest project in each stage, named — the tooltip in §4 and the single
  // most actionable number on the chart.
  const oldest = await client.query(
    `select distinct on (m.stage) m.stage::text as stage, m.id, m.name, m.days_in_stage
     from ${METRICS}
     where m.status = 'active' and m.stage <> 'complete'${f.clause}
     order by m.stage, m.days_in_stage desc, m.id`,
    f.params
  );

  const side = await client.query(
    `select count(*) filter (where m.status = 'on_hold') as on_hold,
            count(*) filter (where m.status = 'cancelled') as cancelled
     from ${METRICS}
     where true${f.clause}`,
    f.params
  );

  const bandsByStage = new Map<string, Record<AgeBand, number>>();
  const totals = new Map<string, number>();
  const weighted = new Map<string, number>();
  for (const r of byBand.rows) {
    const bands =
      bandsByStage.get(r.stage) ?? ({ '0-14': 0, '15-30': 0, '31-60': 0, '60+': 0 } as Record<AgeBand, number>);
    bands[r.age_band as AgeBand] = num(r.n);
    bandsByStage.set(r.stage, bands);
    totals.set(r.stage, (totals.get(r.stage) ?? 0) + num(r.n));
    weighted.set(r.stage, (weighted.get(r.stage) ?? 0) + num(r.avg_days) * num(r.n));
  }
  const oldestByStage = new Map(
    oldest.rows.map((r) => [r.stage, { id: r.id, name: r.name, days: num(r.days_in_stage) }])
  );
  const activeTotal = [...totals.values()].reduce((a, b) => a + b, 0);

  return {
    stages: FUNNEL_STAGES.map((stage) => {
      const count = totals.get(stage) ?? 0;
      return {
        stage,
        label: STAGE_LABELS[stage],
        count,
        share: activeTotal === 0 ? 0 : count / activeTotal,
        bands:
          bandsByStage.get(stage) ??
          ({ '0-14': 0, '15-30': 0, '31-60': 0, '60+': 0 } as Record<AgeBand, number>),
        avgDaysInStage: count === 0 ? null : Math.round((weighted.get(stage) ?? 0) / count),
        oldest: oldestByStage.get(stage) ?? null,
      };
    }),
    activeTotal,
    onHold: num(side.rows[0].on_hold),
    cancelled: num(side.rows[0].cancelled),
  };
}

export interface WorkloadRow {
  key: string | null;
  label: string;
  total: number;
  byStage: Record<string, number>;
}

/**
 * Workload stacked by stage, grouped by whatever the database holds. `by` picks
 * the grouping column — both are real columns, chosen from this two-entry map
 * rather than interpolated, so no caller can turn this into arbitrary SQL.
 */
export async function loadWorkload(
  client: PoolClient,
  ctx: DashboardContext,
  by: 'pm' | 'dealer'
): Promise<WorkloadRow[]> {
  const group =
    by === 'pm'
      ? { id: 'm.assigned_pm', name: 'm.pm_name', fallback: 'Unassigned' }
      : { id: 'm.dealer_id', name: 'm.dealer_name', fallback: 'No dealer' };
  const f = scoped(ctx, 'none');

  const { rows } = await client.query(
    `select ${group.id} as key, ${group.name} as label, m.stage::text as stage, count(*) as n
     from ${METRICS}
     where m.status = 'active' and m.stage <> 'complete'${f.clause}
     group by 1, 2, 3`,
    f.params
  );

  const byKey = new Map<string, WorkloadRow>();
  for (const r of rows) {
    const key = r.key === null ? '' : String(r.key);
    const row =
      byKey.get(key) ??
      { key: r.key, label: r.label ?? group.fallback, total: 0, byStage: {} as Record<string, number> };
    row.byStage[r.stage] = num(r.n);
    row.total += num(r.n);
    byKey.set(key, row);
  }
  // "Sorted by total descending — the person to help is at the top" (§4).
  return [...byKey.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// Band 3 — how long projects take (spec §5)
// ---------------------------------------------------------------------------

/** The seven stage durations of §5, each with the date that ends it. */
export const STAGE_DURATIONS = [
  { key: 'survey', label: 'Site Survey', days: 'survey_days', done: 'survey_done_on' },
  { key: 'design', label: 'Design', days: 'design_days', done: 'design_done_on' },
  { key: 'permits', label: 'Permit', days: 'permit_days', done: 'permit_done_on' },
  { key: 'procurement', label: 'Material', days: 'material_days', done: 'material_done_on' },
  { key: 'install', label: 'Installation', days: 'install_days', done: 'install_done_on' },
  { key: 'inspection', label: 'Inspection', days: 'inspection_days', done: 'inspection_done_on' },
  { key: 'pto', label: 'PTO', days: 'pto_days', done: 'pto_done_on' },
] as const;

export interface StageDuration {
  key: string;
  label: string;
  value: number | null;
  count: number;
}

/**
 * Average (or median) days per stage, over projects that *completed that stage*
 * in the period — which is why each column carries its own finishing date.
 *
 * The exclude-hold toggle behaves differently here than on the totals, and
 * deliberately so. Hold days are recorded per project, not per stage, so there
 * is no honest way to subtract "the hold time that happened during Permit"
 * without inventing an attribution. Instead the toggle drops projects that were
 * ever held from these seven figures, which removes the distortion §5 is worried
 * about without making up a number. The chart says so on its face.
 */
export async function loadStageDurations(
  client: PoolClient,
  ctx: DashboardContext
): Promise<StageDuration[]> {
  const f = scoped(ctx, 'none');
  const p = f.params.length;
  const from = `$${p + 1}::date`;
  const to = `$${p + 2}::date`;

  const union = STAGE_DURATIONS.map(
    (s) => `select '${s.key}' as k, m.${s.days} as d, m.${s.done} as done_on from base m`
  ).join(' union all ');

  const { rows } = await client.query(
    `with base as (
       select * from ${METRICS}
       where true${f.clause}${ctx.filters.exHold ? ' and m.hold_count = 0' : ''}
     ),
     spread as (${union})
     select k, count(*) as n,
            ${statExpr(ctx.filters, 'd')} as value
     from spread
     where d is not null and done_on is not null
       and (${from} is null or done_on >= ${from})
       and done_on <= ${to}
     group by k`,
    [...f.params, ctx.period.current.from, ctx.period.current.to]
  );

  const byKey = new Map(rows.map((r) => [r.k, r]));
  return STAGE_DURATIONS.map((s) => {
    const row = byKey.get(s.key);
    return {
      key: s.key,
      label: s.label,
      value: row ? days(row.value) : null,
      count: row ? num(row.n) : 0,
    };
  });
}

export interface TrendPoint {
  month: string;
  label: string;
  completed: number;
  value: number | null;
  /** Average days in each stage for that month's completions (§5 breakdown). */
  byStage: Record<string, number>;
}

/**
 * Completion-time trend, by month. A trend needs history to be a trend, so this
 * one ignores the period's start and always shows the twelve months ending at
 * the period's end — stated on the chart, per §9. The PM, dealer and stage
 * filters still apply.
 */
export async function loadCompletionTrend(
  client: PoolClient,
  ctx: DashboardContext
): Promise<TrendPoint[]> {
  const f = scoped(ctx, 'none');
  const p = f.params.length;
  const stat = statExpr(ctx.filters, totalDaysColumn(ctx.filters));

  const { rows } = await client.query(
    `select m.completed_month::text as month, count(*) as n, ${stat} as value,
            avg(m.survey_days) as survey, avg(m.design_days) as design,
            avg(m.permit_days) as permits, avg(m.material_days) as procurement,
            avg(m.install_days) as install, avg(m.inspection_days) as inspection,
            avg(m.pto_days) as pto
     from ${METRICS}
     where m.completion_date is not null
       and m.completion_date > (date_trunc('month', $${p + 1}::date) - interval '11 months')
       and m.completion_date <= $${p + 1}::date
       ${f.clause}
     group by 1
     order by 1`,
    [...f.params, ctx.period.current.to]
  );

  return rows.map((r) => ({
    month: String(r.month),
    label: monthLabel(String(r.month)),
    completed: num(r.n),
    value: days(r.value),
    byStage: {
      survey: num(r.survey),
      design: num(r.design),
      permits: num(r.permits),
      procurement: num(r.procurement),
      install: num(r.install),
      inspection: num(r.inspection),
      pto: num(r.pto),
    },
  }));
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-08-01' → 'Aug 26'. */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-');
  return `${MONTH_ABBR[Number(m) - 1] ?? m} ${y.slice(2)}`;
}

export interface HistogramBucket {
  label: string;
  count: number;
}

/** 0–30 / 31–60 / 61–90 / 90+ days to completion (§5). */
export async function loadTimeHistogram(
  client: PoolClient,
  ctx: DashboardContext
): Promise<HistogramBucket[]> {
  const f = scoped(ctx, 'completion_date');
  const col = totalDaysColumn(ctx.filters);
  const { rows } = await client.query(
    `select
       count(*) filter (where ${col} <= 30) as b1,
       count(*) filter (where ${col} between 31 and 60) as b2,
       count(*) filter (where ${col} between 61 and 90) as b3,
       count(*) filter (where ${col} > 90) as b4
     from ${METRICS}
     where true${f.clause}`,
    f.params
  );
  const r = rows[0];
  return [
    { label: '0–30 days', count: num(r.b1) },
    { label: '31–60', count: num(r.b2) },
    { label: '61–90', count: num(r.b3) },
    { label: '90+', count: num(r.b4) },
  ];
}

export interface ProjectionRow {
  stage: StageKey;
  label: string;
  active: number;
  /** Historical days still to come from this stage onward. Null = no history. */
  daysRemaining: number | null;
}

/**
 * Projected completion (§5): a project's current stage plus the historical
 * average of the stages it has left.
 *
 * Labelled an estimate everywhere it appears, and never presented as a promise —
 * it is built from whatever this company's own completed projects did, which
 * with three completions is not a forecast, it is a rumour. The row count is
 * carried alongside so the page can say so.
 */
export async function loadProjection(
  client: PoolClient,
  ctx: DashboardContext
): Promise<{ rows: ProjectionRow[]; basedOn: number }> {
  const f = scoped(ctx, 'none');

  // Historical averages come from all completions, not the filtered period: a
  // month with two completions cannot predict anything.
  const hist = await client.query(
    `select avg(m.survey_days) as survey, avg(m.design_days) as design,
            avg(m.permit_days) as permits, avg(m.material_days) as procurement,
            avg(m.install_days) as install, avg(m.inspection_days) as inspection,
            avg(m.pto_days) as pto,
            count(*) filter (where m.completion_date is not null) as completed
     from ${METRICS}
     where true${f.clause}`,
    f.params
  );

  const counts = await client.query(
    `select m.stage::text as stage, count(*) as n
     from ${METRICS}
     where m.status = 'active' and m.stage <> 'complete'${f.clause}
     group by 1`,
    f.params
  );
  const activeByStage = new Map(counts.rows.map((r) => [r.stage, num(r.n)]));

  const h = hist.rows[0];
  // Inspection and PTO both sit in the inspection_pto stage, so its remaining
  // time is the pair.
  const perStage: Record<string, number | null> = {
    survey: maybe(h.survey),
    design: maybe(h.design),
    permits: maybe(h.permits),
    procurement: maybe(h.procurement),
    install: maybe(h.install),
    inspection_pto:
      h.inspection === null && h.pto === null ? null : num(h.inspection) + num(h.pto),
  };

  const rows = FUNNEL_STAGES.map((stage, i) => {
    const remaining = FUNNEL_STAGES.slice(i)
      .map((s) => perStage[s])
      .filter((v): v is number => v !== null);
    return {
      stage,
      label: STAGE_LABELS[stage],
      active: activeByStage.get(stage) ?? 0,
      daysRemaining: remaining.length === 0 ? null : Math.round(remaining.reduce((a, b) => a + b, 0)),
    };
  });

  return { rows, basedOn: num(h.completed) };
}

// ---------------------------------------------------------------------------
// Band 4 — dealers, PMs and projects (spec §6)
// ---------------------------------------------------------------------------

export interface DealerRow {
  id: string;
  name: string;
  active: number;
  completed: number;
  avgDays: number | null;
  cancelled: number;
  total: number;
  cancellationRate: number;
  pipelineValue: number | null;
  byStage: Record<string, number>;
}

export async function loadDealerComparison(
  client: PoolClient,
  ctx: DashboardContext,
  opts: { financial: boolean }
): Promise<DealerRow[]> {
  const f = scoped(ctx, 'none');
  const p = f.params.length;
  const stat = statExpr(ctx.filters, totalDaysColumn(ctx.filters));
  const inPeriod = `m.completion_date is not null
    and ($${p + 1}::date is null or m.completion_date >= $${p + 1}::date)
    and m.completion_date <= $${p + 2}::date`;

  const { rows } = await client.query(
    `select m.dealer_id, m.dealer_name,
            count(*) as total,
            count(*) filter (where m.status not in ('complete', 'cancelled')) as active,
            count(*) filter (where ${inPeriod}) as completed,
            ${stat} filter (where ${inPeriod}) as avg_days,
            count(*) filter (where m.status = 'cancelled') as cancelled
            ${opts.financial
              ? `, sum(m.contract_value) filter (where m.status not in ('complete', 'cancelled')) as pipeline`
              : ''}
     from ${METRICS}
     where m.dealer_id is not null${f.clause}
     group by 1, 2
     order by active desc, total desc`,
    [...f.params, ctx.period.current.from, ctx.period.current.to]
  );

  // Stage spread per dealer (§6), one extra pass rather than a pivot.
  const spread = await client.query(
    `select m.dealer_id, m.stage::text as stage, count(*) as n
     from ${METRICS}
     where m.dealer_id is not null and m.status = 'active' and m.stage <> 'complete'${f.clause}
     group by 1, 2`,
    f.params
  );
  const byDealer = new Map<string, Record<string, number>>();
  for (const r of spread.rows) {
    const rec = byDealer.get(r.dealer_id) ?? {};
    rec[r.stage] = num(r.n);
    byDealer.set(r.dealer_id, rec);
  }

  return rows.map((r) => ({
    id: r.dealer_id,
    name: r.dealer_name ?? '—',
    active: num(r.active),
    completed: num(r.completed),
    avgDays: days(r.avg_days),
    cancelled: num(r.cancelled),
    total: num(r.total),
    cancellationRate: num(r.total) === 0 ? 0 : num(r.cancelled) / num(r.total),
    pipelineValue: opts.financial ? maybe(r.pipeline) : null,
    byStage: byDealer.get(r.dealer_id) ?? {},
  }));
}

export interface VolumeSeries {
  months: string[];
  dealers: Array<{ id: string; name: string; counts: number[] }>;
}

/** Projects created per dealer per month — who is growing and who has gone quiet. */
export async function loadDealerVolume(
  client: PoolClient,
  ctx: DashboardContext
): Promise<VolumeSeries> {
  const f = scoped(ctx, 'none');
  const p = f.params.length;
  const { rows } = await client.query(
    `select m.created_month::text as month, m.dealer_id, m.dealer_name, count(*) as n
     from ${METRICS}
     where m.dealer_id is not null
       and m.created_at >= (date_trunc('month', $${p + 1}::date) - interval '11 months')
       and m.created_at::date <= $${p + 1}::date
       ${f.clause}
     group by 1, 2, 3
     order by 1`,
    [...f.params, ctx.period.current.to]
  );

  const months = [...new Set(rows.map((r) => String(r.month)))].sort();
  const index = new Map(months.map((m, i) => [m, i]));
  const dealers = new Map<string, { id: string; name: string; counts: number[] }>();
  for (const r of rows) {
    const d =
      dealers.get(r.dealer_id) ??
      { id: r.dealer_id, name: r.dealer_name ?? '—', counts: months.map(() => 0) };
    d.counts[index.get(String(r.month))!] = num(r.n);
    dealers.set(r.dealer_id, d);
  }
  return {
    months,
    dealers: [...dealers.values()].sort(
      (a, b) =>
        b.counts.reduce((x, y) => x + y, 0) - a.counts.reduce((x, y) => x + y, 0) ||
        a.name.localeCompare(b.name)
    ),
  };
}

export interface PmRow {
  id: string | null;
  name: string;
  active: number;
  ageing: number;
  completed: number;
  avgDays: number | null;
}

export async function loadPmStats(client: PoolClient, ctx: DashboardContext): Promise<PmRow[]> {
  const f = scoped(ctx, 'none');
  const p = f.params.length;
  const stat = statExpr(ctx.filters, totalDaysColumn(ctx.filters));
  const inPeriod = `m.completion_date is not null
    and ($${p + 1}::date is null or m.completion_date >= $${p + 1}::date)
    and m.completion_date <= $${p + 2}::date`;

  const { rows } = await client.query(
    `select m.assigned_pm, m.pm_name,
            count(*) filter (where m.status not in ('complete', 'cancelled')) as active,
            count(*) filter (where m.is_ageing) as ageing,
            count(*) filter (where ${inPeriod}) as completed,
            ${stat} filter (where ${inPeriod}) as avg_days
     from ${METRICS}
     where true${f.clause}
     group by 1, 2
     order by active desc`,
    [...f.params, ctx.period.current.from, ctx.period.current.to]
  );

  return rows
    .map((r) => ({
      id: r.assigned_pm,
      name: r.pm_name ?? 'Unassigned',
      active: num(r.active),
      ageing: num(r.ageing),
      completed: num(r.completed),
      avgDays: days(r.avg_days),
    }))
    .filter((r) => r.active > 0 || r.completed > 0 || r.ageing > 0);
}

export interface MatrixRow {
  id: string;
  name: string;
  stage: StageKey;
  cells: Array<{ key: string; days: number | null }>;
}

/**
 * The stage matrix (§6): rows are projects, columns the seven stages, each cell
 * the days spent there. Reading down a column shows a systemic bottleneck;
 * reading across a row shows one troubled project.
 *
 * Capped, and the cap is reported rather than silently applied — a heat map of
 * 800 rows is not information. The oldest active projects come first, because
 * those are the rows worth scanning.
 */
export async function loadStageMatrix(
  client: PoolClient,
  ctx: DashboardContext,
  limit = 40
): Promise<{ rows: MatrixRow[]; total: number }> {
  const f = scoped(ctx, 'none');
  const p = f.params.length;
  const cols = STAGE_DURATIONS.map((s) => `m.${s.days}`).join(', ');

  const { rows } = await client.query(
    `select m.id, m.name, m.stage::text as stage, m.days_in_stage, ${cols},
            count(*) over () as total
     from ${METRICS}
     where m.status not in ('cancelled')${f.clause}
     order by m.days_in_stage desc, m.name
     limit $${p + 1}`,
    [...f.params, limit]
  );

  return {
    total: rows.length > 0 ? num(rows[0].total) : 0,
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      stage: r.stage as StageKey,
      cells: STAGE_DURATIONS.map((s) => ({
        key: s.key,
        days: r[s.days] === null ? null : num(r[s.days]),
      })),
    })),
  };
}

export interface RecentRow {
  id: string;
  name: string;
  dealerName: string | null;
  pmName: string | null;
  date: string | null;
  totalDays: number | null;
}

export async function loadRecent(
  client: PoolClient,
  ctx: DashboardContext,
  which: 'completed' | 'created'
): Promise<RecentRow[]> {
  const f = scoped(ctx, 'none');
  const p = f.params.length;
  const order =
    which === 'completed'
      ? 'm.completion_date desc nulls last, m.name'
      : 'm.created_at desc, m.name';
  const extra = which === 'completed' ? ' and m.completion_date is not null' : '';

  const { rows } = await client.query(
    `select m.id, m.name, m.dealer_name, m.pm_name,
            ${which === 'completed' ? 'm.completion_date::text' : 'm.created_at::date::text'} as date,
            ${totalDaysColumn(ctx.filters)} as total_days
     from ${METRICS}
     where true${extra}${f.clause}
     order by ${order}
     limit $${p + 1}`,
    [...f.params, 10]
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    dealerName: r.dealer_name,
    pmName: r.pm_name,
    date: iso(r.date),
    totalDays: maybe(r.total_days),
  }));
}

// ---------------------------------------------------------------------------
// Section 7 — needs attention
// ---------------------------------------------------------------------------

export interface AttentionRow {
  id: string;
  name: string;
  clientName: string | null;
  stage: StageKey;
  stageLabel: string;
  days: number;
  threshold: number;
  pmName: string | null;
  dealerName: string | null;
}

export interface HoldRow {
  id: string;
  name: string;
  clientName: string | null;
  stage: StageKey;
  heldSince: string | null;
  expectedResume: string | null;
  holdDays: number;
  pmName: string | null;
}

export interface CancelledRow {
  id: string;
  name: string;
  date: string | null;
  cancelledFrom: string | null;
  reason: string | null;
  dealerName: string | null;
}

/**
 * The attention lists (§7) — the part of the dashboard that gets used most, and
 * the thing that replaces the Watchdog in a version with no automation layer.
 * Every row links straight through to the project's stage form.
 */
export async function loadAttention(
  client: PoolClient,
  ctx: DashboardContext
): Promise<{ ageing: AttentionRow[]; holds: HoldRow[]; cancelled: CancelledRow[] }> {
  const f = scoped(ctx, 'none');

  const ageing = await client.query(
    `select m.id, m.name, m.client_name, m.stage::text as stage, m.days_in_stage,
            m.attention_days, m.pm_name, m.dealer_name
     from ${METRICS}
     where m.is_ageing${f.clause}
     order by m.days_in_stage desc, m.name
     limit 50`,
    f.params
  );

  const holds = await client.query(
    `select m.id, m.name, m.client_name, m.stage::text as stage,
            m.open_hold_started::text as held_since,
            m.expected_resume_date::text as expected_resume,
            m.hold_days, m.pm_name
     from ${METRICS}
     where m.hold_overdue${f.clause}
     order by m.expected_resume_date nulls first, m.hold_days desc
     limit 50`,
    f.params
  );

  const cancelled = await client.query(
    `select m.id, m.name, m.cancellation_date::text as date,
            m.cancelled_from::text as cancelled_from, m.cancel_reason, m.dealer_name
     from ${METRICS}
     where m.cancellation_date is not null${f.clause}
     order by m.cancellation_date desc, m.name
     limit 10`,
    f.params
  );

  return {
    ageing: ageing.rows.map((r) => ({
      id: r.id,
      name: r.name,
      clientName: r.client_name,
      stage: r.stage as StageKey,
      stageLabel: STAGE_LABELS[r.stage as StageKey] ?? r.stage,
      days: num(r.days_in_stage),
      threshold: num(r.attention_days),
      pmName: r.pm_name,
      dealerName: r.dealer_name,
    })),
    holds: holds.rows.map((r) => ({
      id: r.id,
      name: r.name,
      clientName: r.client_name,
      stage: r.stage as StageKey,
      heldSince: iso(r.held_since),
      expectedResume: iso(r.expected_resume),
      holdDays: num(r.hold_days),
      pmName: r.pm_name,
    })),
    cancelled: cancelled.rows.map((r) => ({
      id: r.id,
      name: r.name,
      date: iso(r.date),
      cancelledFrom: r.cancelled_from,
      reason: r.cancel_reason,
      dealerName: r.dealer_name,
    })),
  };
}

// ---------------------------------------------------------------------------
// Reference lists for the filter bar
// ---------------------------------------------------------------------------

export interface DashboardRefs {
  pms: Array<{ id: string; name: string }>;
  dealers: Array<{ id: string; name: string }>;
  onHoldThreshold: number;
  opsSeeFinancials: boolean;
}

export async function loadRefs(client: PoolClient, role: string): Promise<DashboardRefs> {
  // profiles and app_settings are admin/ops-only by policy, so a finance or
  // dealer reader gets empty lists rather than an error — and neither of them is
  // offered a by-PM filter to begin with.
  const staff = ['admin', 'ops'].includes(role);

  const pms = staff
    ? (
        await client.query(
          `select id, coalesce(full_name, email) as name from public.profiles
           where role in ('admin', 'ops') and is_active and deleted_at is null order by 2`
        )
      ).rows
    : [];
  const dealers = (await client.query(`select id, name from public.dealers order by name`)).rows;
  const settings = staff
    ? (
        await client.query(
          `select on_hold_alert_threshold, ops_see_financials from public.app_settings where id`
        )
      ).rows[0]
    : null;

  return {
    pms,
    dealers,
    onHoldThreshold: settings ? num(settings.on_hold_alert_threshold) : 5,
    opsSeeFinancials: settings ? Boolean(settings.ops_see_financials) : false,
  };
}

// ---------------------------------------------------------------------------
// The finance slice (spec §8)
// ---------------------------------------------------------------------------

export interface FinanceView {
  pipelineValue: number | null;
  invoiced: number;
  paid: number;
  completed: number;
  completedPrev: number;
  avgDays: number | null;
  volume: Array<{ month: string; label: string; completed: number; value: number | null }>;
  milestones: Array<{ label: string; received: number; pending: number; na: number }>;
}

/**
 * Finance sees money and volume, not workload. This reads
 * public.project_financial_metrics — a whitelisted view that has no assigned_pm
 * and no per-stage day counters, so the "no workload or stage-detail charts"
 * rule in §8 is enforced by what the query can reach, not by which components
 * the page chooses to render.
 */
export async function loadFinanceView(
  client: PoolClient,
  ctx: DashboardContext
): Promise<FinanceView> {
  const dealer = ctx.filters.dealer;
  const dealerClause = dealer ? ' and f.dealer_id = $1' : '';
  const base: unknown[] = dealer ? [dealer] : [];
  const p = base.length;

  const totals = await client.query(
    `select sum(f.contract_value) filter (where f.status not in ('complete', 'cancelled')) as pipeline,
            coalesce(sum(f.amount_invoiced), 0) as invoiced,
            coalesce(sum(f.amount_paid), 0) as paid
     from public.project_financial_metrics f
     where true${dealerClause}`,
    base
  );

  const completions = async (range: Range) => {
    const { rows } = await client.query(
      `select count(*) as n,
              ${ctx.filters.stat === 'average'
                ? 'avg(f.total_days)'
                : 'percentile_cont(0.5) within group (order by f.total_days::numeric)'} as value
       from public.project_financial_metrics f
       where f.completion_date is not null
         and ($${p + 1}::date is null or f.completion_date >= $${p + 1}::date)
         and f.completion_date <= $${p + 2}::date
         ${dealerClause}`,
      [...base, range.from, range.to]
    );
    return rows[0];
  };

  const nowRow = await completions(ctx.period.current);
  const prevRow = ctx.period.previous ? await completions(ctx.period.previous) : null;

  const trend = await client.query(
    `select f.completed_month::text as month, count(*) as n,
            ${ctx.filters.stat === 'average'
              ? 'avg(f.total_days)'
              : 'percentile_cont(0.5) within group (order by f.total_days::numeric)'} as value
     from public.project_financial_metrics f
     where f.completion_date is not null
       and f.completion_date > (date_trunc('month', $${p + 1}::date) - interval '11 months')
       and f.completion_date <= $${p + 1}::date
       ${dealerClause}
     group by 1 order by 1`,
    [...base, ctx.period.current.to]
  );

  // Milestone-payment status: how many projects have each milestone in hand.
  // 'received'/'approved' both mean money has landed; 'na' is a legitimate
  // answer (a cash deal has no finance milestones) and must not read as a gap.
  const ms = await client.query(
    `select
       count(*) filter (where f.down_payment_status = 'received') as dp_ok,
       count(*) filter (where f.down_payment_status not in ('received')) as dp_open,
       count(*) filter (where f.cash_m1_status = 'received') as m1_ok,
       count(*) filter (where f.cash_m1_status = 'na') as m1_na,
       count(*) filter (where f.cash_m1_status not in ('received', 'na')) as m1_open,
       count(*) filter (where f.cash_m2_status = 'received') as m2_ok,
       count(*) filter (where f.cash_m2_status = 'na') as m2_na,
       count(*) filter (where f.cash_m2_status not in ('received', 'na')) as m2_open,
       count(*) filter (where f.cash_m3_status = 'received') as m3_ok,
       count(*) filter (where f.cash_m3_status = 'na') as m3_na,
       count(*) filter (where f.cash_m3_status not in ('received', 'na')) as m3_open,
       count(*) filter (where f.m1_status = 'approved') as f1_ok,
       count(*) filter (where f.m1_status = 'na') as f1_na,
       count(*) filter (where f.m1_status not in ('approved', 'na')) as f1_open,
       count(*) filter (where f.m2_status = 'approved') as f2_ok,
       count(*) filter (where f.m2_status = 'na') as f2_na,
       count(*) filter (where f.m2_status not in ('approved', 'na')) as f2_open
     from public.project_financial_metrics f
     where f.status not in ('cancelled')${dealerClause}`,
    base
  );
  const m = ms.rows[0];

  return {
    pipelineValue: maybe(totals.rows[0].pipeline),
    invoiced: num(totals.rows[0].invoiced),
    paid: num(totals.rows[0].paid),
    completed: num(nowRow.n),
    completedPrev: prevRow ? num(prevRow.n) : 0,
    avgDays: days(nowRow.value),
    volume: trend.rows.map((r) => ({
      month: String(r.month),
      label: monthLabel(String(r.month)),
      completed: num(r.n),
      value: days(r.value),
    })),
    milestones: [
      { label: 'Down payment', received: num(m.dp_ok), pending: num(m.dp_open), na: 0 },
      { label: 'Cash M1', received: num(m.m1_ok), pending: num(m.m1_open), na: num(m.m1_na) },
      { label: 'Cash M2', received: num(m.m2_ok), pending: num(m.m2_open), na: num(m.m2_na) },
      { label: 'Cash M3', received: num(m.m3_ok), pending: num(m.m3_open), na: num(m.m3_na) },
      { label: 'Finance M1', received: num(m.f1_ok), pending: num(m.f1_open), na: num(m.f1_na) },
      { label: 'Finance M2', received: num(m.f2_ok), pending: num(m.f2_open), na: num(m.f2_na) },
    ],
  };
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

/**
 * Resolve today's date from the database and build the shared context. Kept
 * separate from the band loaders so the page can hand the same period to all of
 * them and no two charts can disagree about which month it is.
 */
export async function dashboardContext(
  session: SessionIdentity,
  filters: DashboardFilters
): Promise<{ ready: boolean; ctx: DashboardContext; refs: DashboardRefs }> {
  return withUser(session, async (client) => {
    const ready = await dashboardReady(client);
    const today = await serverToday(client);
    const refs = ready
      ? await loadRefs(client, session.role)
      : { pms: [], dealers: [], onHoldThreshold: 5, opsSeeFinancials: false };
    return {
      ready,
      refs,
      ctx: { filters, period: resolvePeriod(filters, today), viewerId: session.userId },
    };
  });
}
