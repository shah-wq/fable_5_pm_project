// Explicit .ts, so node --experimental-strip-types can load this file directly
// for the unit tests (the convention in src/lib/stages).
import { STAGES, type StageKey } from '../stages/definitions.ts';

/**
 * The dashboard's global filter set (spec §2): one sticky bar whose choices
 * apply to every chart below it at once.
 *
 * Everything here is pure and validated against an allowlist. No filter value
 * ever reaches SQL as text — stage and status become enum casts on a bound
 * parameter, ids are bound as uuids, and anything unrecognised becomes null
 * rather than an error, because a stale bookmark with an old dealer id should
 * show the unfiltered dashboard rather than a stack trace.
 */

export const PERIODS = ['month', 'quarter', 'year', 'all', 'custom'] as const;
export type Period = (typeof PERIODS)[number];

export const PERIOD_LABELS: Record<Period, string> = {
  month: 'This month',
  quarter: 'This quarter',
  year: 'This year',
  all: 'All time',
  custom: 'Custom range',
};

export const STATUSES = ['active', 'on_hold', 'complete', 'cancelled'] as const;
export type StatusKey = (typeof STATUSES)[number];

export interface DashboardFilters {
  period: Period;
  /** Custom range, only read when period === 'custom'. ISO yyyy-mm-dd. */
  customFrom: string | null;
  customTo: string | null;
  pm: string | null;
  dealer: string | null;
  stage: StageKey | null;
  status: StatusKey | null;
  /** §8: the PM's 'my projects' toggle. */
  mine: boolean;
  /** §5: median is the default — one 90-day permit drags an average badly. */
  stat: 'median' | 'average';
  /** §5: recompute every duration with hold days removed. */
  exHold: boolean;
}

export type RawSearch = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined): string | null =>
  (Array.isArray(v) ? v[0] : v)?.trim() || null;

/** yyyy-mm-dd only — anything else is dropped rather than passed to Postgres. */
const isoDate = (v: string | null): string | null =>
  v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;

/** A uuid, or null. Keeps a mangled query string from reaching the database. */
const uuid = (v: string | null): string | null =>
  v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;

/**
 * This quarter, not this month.
 *
 * A solar project takes longer than a month — the seven stage durations in the
 * fixture data alone add up to around ninety days — so a one-month window
 * usually contains one or two finished stages and no completions at all. The
 * cycle-time band then reads "no data" across six of its seven columns and a
 * median over a single project, which looks like a broken dashboard rather than
 * a short date range. A quarter is roughly one project cycle, so the band has
 * something to say the first time anyone opens the page. The month is still one
 * click away.
 */
const DEFAULT_PERIOD: Period = 'quarter';

export function parseFilters(search: RawSearch): DashboardFilters {
  const period = one(search.period);
  const stage = one(search.stage);
  const status = one(search.status);
  const from = isoDate(one(search.from));
  const to = isoDate(one(search.to));

  return {
    // A custom range with no dates is just 'all time' — silently, because the
    // user is mid-way through filling the two date boxes.
    period:
      period && (PERIODS as readonly string[]).includes(period)
        ? period === 'custom' && !from && !to
          ? 'all'
          : (period as Period)
        : DEFAULT_PERIOD,
    customFrom: from,
    customTo: to,
    pm: uuid(one(search.pm)),
    dealer: uuid(one(search.dealer)),
    stage: stage && (STAGES as readonly string[]).includes(stage) ? (stage as StageKey) : null,
    status:
      status && (STATUSES as readonly string[]).includes(status) ? (status as StatusKey) : null,
    mine: one(search.mine) === '1',
    stat: one(search.stat) === 'average' ? 'average' : 'median',
    exHold: one(search.exhold) === '1',
  };
}

/** The filter set as a query string, for links that keep the current view. */
export function filterQuery(
  f: DashboardFilters,
  override: Partial<Record<string, string | null>> = {}
): string {
  const params = new URLSearchParams();
  if (f.period !== DEFAULT_PERIOD) params.set('period', f.period);
  if (f.period === 'custom') {
    if (f.customFrom) params.set('from', f.customFrom);
    if (f.customTo) params.set('to', f.customTo);
  }
  if (f.pm) params.set('pm', f.pm);
  if (f.dealer) params.set('dealer', f.dealer);
  if (f.stage) params.set('stage', f.stage);
  if (f.status) params.set('status', f.status);
  if (f.mine) params.set('mine', '1');
  if (f.stat !== 'median') params.set('stat', f.stat);
  if (f.exHold) params.set('exhold', '1');

  // null removes the key; undefined means "leave it as it is".
  for (const [key, value] of Object.entries(override)) {
    if (value === null) params.delete(key);
    else if (value !== undefined) params.set(key, value);
  }
  return params.toString();
}

/**
 * A link into the Projects tab carrying the parts of the dashboard filter it
 * understands. §3: "A number nobody can drill into is a number nobody trusts",
 * so every card and every bar has one of these behind it.
 */
export function projectsLink(
  f: DashboardFilters,
  override: { stage?: string | null; status?: string | null } = {}
): string {
  const params = new URLSearchParams();
  const stage = override.stage === undefined ? f.stage : override.stage;
  const status = override.status === undefined ? f.status : override.status;
  if (stage) params.set('stage', stage);
  if (status) params.set('status', status);
  if (f.dealer) params.set('dealer', f.dealer);
  const qs = params.toString();
  return qs ? `/projects?${qs}` : '/projects';
}

// ---------------------------------------------------------------------------
// The resolved period
// ---------------------------------------------------------------------------

export interface Range {
  /** null = open-ended (all time). */
  from: string | null;
  to: string;
}

export interface ResolvedPeriod {
  current: Range;
  /** The same span immediately before, for the change indicators (§3). */
  previous: Range | null;
  /** Human wording, printed on every chart (§9). */
  label: string;
}

const DAY = 86_400_000;
/** Parsed as UTC so no local timezone can shift a date by a day. */
const parse = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);
const format = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** '3 Aug 2026' — short, unambiguous, and the same in every locale. */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]?.slice(0, 3) ?? m} ${y}`;
}

/**
 * Turn a filter set plus today's date into the current and previous ranges.
 *
 * `today` is passed in rather than read from the clock so that this is a pure
 * function, and so the caller can hand it the date PostgreSQL believes it is —
 * the numbers and the label then cannot disagree about which month it is, which
 * is the sort of off-by-one that makes a whole dashboard look wrong at midnight.
 */
export function resolvePeriod(f: DashboardFilters, today: string): ResolvedPeriod {
  const [y, m] = today.split('-').map(Number);

  if (f.period === 'all') {
    return { current: { from: null, to: today }, previous: null, label: 'All time' };
  }

  let from: string;
  let to = today;
  let label: string;

  if (f.period === 'custom') {
    from = f.customFrom ?? f.customTo ?? today;
    to = f.customTo ?? today;
    if (parse(from) > parse(to)) [from, to] = [to, from];
    label = `${shortDate(from)} – ${shortDate(to)}`;
  } else if (f.period === 'year') {
    from = `${y}-01-01`;
    label = `${y}`;
  } else if (f.period === 'quarter') {
    const qStart = Math.floor((m - 1) / 3) * 3 + 1;
    from = `${y}-${String(qStart).padStart(2, '0')}-01`;
    label = `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  } else {
    from = `${y}-${String(m).padStart(2, '0')}-01`;
    label = `${MONTHS[m - 1]} ${y}`;
  }

  // The previous period is the same number of days ending the day before this
  // one starts. Calendar months differ in length, and comparing a 31-day month
  // against a 28-day one would invent a 10% change out of nothing.
  const span = Math.round((parse(to) - parse(from)) / DAY) + 1;
  const prevTo = format(parse(from) - DAY);
  const prevFrom = format(parse(from) - span * DAY);

  return { current: { from, to }, previous: { from: prevFrom, to: prevTo }, label };
}

// ---------------------------------------------------------------------------
// SQL fragments
// ---------------------------------------------------------------------------

/** Which date column the period restricts, per chart. */
export type DateBasis =
  | 'none'
  | 'created_at'
  | 'completion_date'
  | 'cancellation_date'
  | 'survey_done_on'
  | 'design_done_on'
  | 'permit_done_on'
  | 'material_done_on'
  | 'install_done_on'
  | 'inspection_done_on'
  | 'pto_done_on';

export interface Where {
  /** Always starts with a space and 'and', for appending to `where true`. */
  clause: string;
  params: unknown[];
}

/**
 * The WHERE for one chart over public.project_metrics (alias `m`).
 *
 * The date basis differs per chart on purpose: 'completed this period' counts by
 * completion date, 'created per month' by creation date, and the funnel — a
 * picture of where everything is right now — by nothing at all. Sharing one
 * date column across all of them is the classic way a dashboard ends up
 * reporting a funnel that only contains projects created this month.
 *
 * `viewerId` supports the 'my projects' toggle; the caller passes their own id.
 */
export function buildWhere(
  f: DashboardFilters,
  basis: DateBasis,
  range: Range,
  viewerId: string,
  startIndex = 0
): Where {
  const params: unknown[] = [];
  const parts: string[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    parts.push(sql.replace('?', `$${startIndex + params.length}`));
  };

  if (f.pm) add('m.assigned_pm = ?', f.pm);
  else if (f.mine) add('m.assigned_pm = ?', viewerId);
  if (f.dealer) add('m.dealer_id = ?', f.dealer);
  if (f.stage) add('m.stage = ?::public.project_stage', f.stage);
  if (f.status) add('m.status = ?::public.project_status', f.status);

  if (basis !== 'none') {
    if (range.from) add(`m.${basis} >= ?::date`, range.from);
    add(`m.${basis} <= ?::date`, range.to);
    // A row with no date in that column is not "in the period" — it simply has
    // not reached that milestone yet.
    parts.push(`m.${basis} is not null`);
  }

  return { clause: parts.length ? ' and ' + parts.join(' and ') : '', params };
}

/** The duration column to read, honouring the exclude-hold toggle (§5). */
export function totalDaysColumn(f: DashboardFilters): string {
  return f.exHold ? 'm.total_days_ex_hold' : 'm.total_days';
}

/**
 * avg or median of `column`, per the toggle. Median is `percentile_cont`, which
 * needs a numeric input — the day counters are integers, hence the cast.
 */
export function statExpr(f: DashboardFilters, column: string): string {
  return f.stat === 'average'
    ? `avg(${column})`
    : `percentile_cont(0.5) within group (order by (${column})::numeric)`;
}

/** 'Median' / 'Average', for the chart's own caption. */
export function statLabel(f: DashboardFilters): string {
  return f.stat === 'average' ? 'Average' : 'Median';
}

/**
 * The one-line caption §9 requires on every chart: a screenshot of a chart ends
 * up in an email, and it has to still make sense there.
 */
export function captionFor(
  period: ResolvedPeriod,
  f: DashboardFilters,
  names: { pm?: string | null; dealer?: string | null }
): string {
  const bits = [period.label];
  if (f.mine && !f.pm) bits.push('my projects');
  if (names.pm) bits.push(`PM: ${names.pm}`);
  if (names.dealer) bits.push(`Dealer: ${names.dealer}`);
  if (f.stage) bits.push(`stage: ${f.stage.replace('_', ' ')}`);
  if (f.status) bits.push(`status: ${f.status.replace('_', ' ')}`);
  if (f.exHold) bits.push('hold time excluded');
  return bits.join(' · ');
}
