import type { PoolClient } from 'pg';
import { optionalRows } from '../db-optional';
import { STAGE_LABELS, type StageKey } from '../stages/definitions';
import { AGE_BANDS, FUNNEL_STAGES, type AgeBand } from '../dashboard/queries';
import { dealerScope } from './portal';
import type { SessionIdentity } from '../db';

/**
 * The dealer's reduced dashboard (Dashboard spec §8): "their projects by stage,
 * their average completion time, their ageing list. Scoped by row-level
 * security, never a filter."
 *
 * That last clause is literal. These queries read public.project_metrics, the
 * same view the admin dashboard reads, and public.projects' own RLS policy is
 * what limits the rows to this dealer's book — there is no `where dealer_id =`
 * anywhere below, and therefore nothing to forget. The one filter that IS applied
 * is the dealer company's own reps_see_own_only setting, which is a business rule
 * inside the dealer's data rather than a security boundary.
 *
 * Everything is savepoint-guarded: this page has worked since the dealer-portal
 * module, and must keep working on a database that has not run 002800 yet.
 */

export interface DealerAgeing {
  id: string;
  name: string;
  stage: StageKey;
  stageLabel: string;
  days: number;
  threshold: number;
}

export interface DealerStageSpread {
  stage: StageKey;
  label: string;
  count: number;
  bands: Record<AgeBand, number>;
}

export interface DealerDashboard {
  /** false when the database has not caught up — the caller falls back. */
  available: boolean;
  spread: DealerStageSpread[];
  activeTotal: number;
  ageing: DealerAgeing[];
  medianDaysToComplete: number | null;
  completedTotal: number;
}

export async function loadDealerDashboard(
  client: PoolClient,
  session: SessionIdentity
): Promise<DealerDashboard> {
  const scope = await dealerScope(client, session);
  const clause = scope.clause.replace('$SCOPE$', '$1').replace('p.sales_rep_id', 'm.sales_rep_id');
  const params = scope.params;

  const empty: DealerDashboard = {
    available: false,
    spread: [],
    activeTotal: 0,
    ageing: [],
    medianDaysToComplete: null,
    completedTotal: 0,
  };

  const bands = await optionalRows<{ stage: string; age_band: string; n: string }>(
    client,
    "the dealer dashboard's stage spread (public.project_metrics)",
    `select m.stage::text as stage, m.age_band, count(*) as n
     from public.project_metrics m
     where m.status = 'active' and m.stage <> 'complete' ${clause}
     group by 1, 2`,
    params
  );
  // A dealer with no active projects still has a dashboard; a missing view does
  // not. The completion query settles which of the two this is.
  const completion = await optionalRows<{ median: string | null; n: string }>(
    client,
    "the dealer dashboard's completion time (public.project_metrics)",
    `select percentile_cont(0.5) within group (order by m.total_days::numeric) as median,
            count(*) filter (where m.completion_date is not null) as n
     from public.project_metrics m
     where m.completion_date is not null ${clause}`,
    params
  );
  if (completion.length === 0) return empty;

  const ageing = await optionalRows<{
    id: string;
    name: string;
    stage: string;
    days_in_stage: string;
    attention_days: string;
  }>(
    client,
    "the dealer dashboard's ageing list (public.project_metrics)",
    `select m.id, m.name, m.stage::text as stage, m.days_in_stage, m.attention_days
     from public.project_metrics m
     where m.is_ageing ${clause}
     order by m.days_in_stage desc, m.name
     limit 25`,
    params
  );

  const byStage = new Map<string, Record<AgeBand, number>>();
  for (const r of bands) {
    const rec =
      byStage.get(r.stage) ??
      ({ '0-14': 0, '15-30': 0, '31-60': 0, '60+': 0 } as Record<AgeBand, number>);
    rec[r.age_band as AgeBand] = Number(r.n);
    byStage.set(r.stage, rec);
  }

  const spread = FUNNEL_STAGES.map((stage) => {
    const rec =
      byStage.get(stage) ??
      ({ '0-14': 0, '15-30': 0, '31-60': 0, '60+': 0 } as Record<AgeBand, number>);
    return {
      stage,
      label: STAGE_LABELS[stage],
      count: AGE_BANDS.reduce((n, b) => n + rec[b], 0),
      bands: rec,
    };
  });

  return {
    available: true,
    spread,
    activeTotal: spread.reduce((n, s) => n + s.count, 0),
    ageing: ageing.map((r) => ({
      id: r.id,
      name: r.name,
      stage: r.stage as StageKey,
      stageLabel: STAGE_LABELS[r.stage as StageKey] ?? r.stage,
      days: Number(r.days_in_stage),
      threshold: Number(r.attention_days),
    })),
    medianDaysToComplete:
      completion[0].median === null ? null : Math.round(Number(completion[0].median)),
    completedTotal: Number(completion[0].n),
  };
}
