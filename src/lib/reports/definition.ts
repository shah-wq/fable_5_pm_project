import { AGGREGATIONS, type Aggregation } from './fields';

/**
 * The report definition — what the canvas produces and what gets saved. It is
 * plain JSON: the builder never sends SQL, and the generator only ever reads
 * field *keys* from this shape (spec §9, 'never build SQL from user strings').
 */

export const DATE_GRAINS = ['day', 'month', 'quarter', 'year'] as const;
export type DateGrain = (typeof DATE_GRAINS)[number];

export const RELATIVE_RANGES = [
  'last_7_days', 'last_30_days', 'last_90_days',
  'this_month', 'this_quarter', 'this_year', 'year_to_date',
] as const;
export type RelativeRange = (typeof RELATIVE_RANGES)[number];

export const TEXT_OPS = ['contains', 'not_contains', 'equals', 'is_empty', 'not_empty'] as const;
export const STATUS_OPS = ['is', 'is_not', 'is_any_of', 'is_empty', 'not_empty'] as const;
export const NUMBER_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'not_empty'] as const;
export const DATE_OPS = ['before', 'after', 'between', 'relative', 'is_empty', 'not_empty'] as const;
export const BOOLEAN_OPS = ['is_true', 'is_false'] as const;

export type FilterOp =
  | (typeof TEXT_OPS)[number]
  | (typeof STATUS_OPS)[number]
  | (typeof NUMBER_OPS)[number]
  | (typeof DATE_OPS)[number]
  | (typeof BOOLEAN_OPS)[number];

export interface ReportFilter {
  field: string;
  op: FilterOp;
  /** Single value (text/number/date) or the low end of a between. */
  value?: string | number | null;
  /** High end of a between. */
  value2?: string | number | null;
  /** is_any_of. */
  values?: string[];
  /** relative date windows. */
  relative?: RelativeRange;
}

export interface ReportColumn {
  field: string;
  /** Renamed header; falls back to the field label. */
  label?: string;
  /** Date columns can be shown/grouped by month, quarter or year. */
  grain?: DateGrain;
}

export interface ReportGroup {
  field: string;
  grain?: DateGrain;
}

export interface ReportSummary {
  field: string;
  agg: Aggregation;
}

export const RECORD_SCOPES = ['all', 'mine', 'dealer', 'rep', 'pm'] as const;
export type RecordScopeType = (typeof RECORD_SCOPES)[number];

export interface ReportDefinition {
  columns: ReportColumn[];
  groupBy: ReportGroup[];
  filters: ReportFilter[];
  summarise: ReportSummary[];
  /** Stage keys included; empty means every stage. */
  stages: string[];
  /** Currently sitting in those stages, or ever passed through them. */
  stageMode: 'currently_in' | 'passed_through';
  includeHold: boolean;
  includeCancelled: boolean;
  dateRange?: {
    field: string;
    mode: 'relative' | 'fixed';
    relative?: RelativeRange;
    from?: string;
    to?: string;
  };
  recordScope: { type: RecordScopeType; id?: string };
  sort?: { field: string; dir: 'asc' | 'desc' };
  /** Free-text PM/hold/cancellation notes (permission-gated). */
  includeInternalNotes?: boolean;
}

export const EMPTY_DEFINITION: ReportDefinition = {
  columns: [],
  groupBy: [],
  filters: [],
  summarise: [],
  stages: [],
  stageMode: 'currently_in',
  includeHold: true,
  includeCancelled: false,
  recordScope: { type: 'all' },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalizes whatever arrived over the wire into a definition whose every
 * value is of a known shape. Unknown fields are dropped rather than rejected
 * so a report saved with a field the caller may not see still runs.
 */
export function sanitizeDefinition(
  raw: unknown,
  allowedFieldKeys: Set<string>
): ReportDefinition {
  const r = (raw ?? {}) as Record<string, unknown>;
  const ok = (key: unknown) => typeof key === 'string' && allowedFieldKeys.has(key);
  const grain = (g: unknown): DateGrain | undefined =>
    typeof g === 'string' && (DATE_GRAINS as readonly string[]).includes(g) ? (g as DateGrain) : undefined;

  const columns: ReportColumn[] = Array.isArray(r.columns)
    ? r.columns
        .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
        .filter((c) => ok(c.field))
        .slice(0, 60)
        .map((c) => ({
          field: String(c.field),
          label: typeof c.label === 'string' ? c.label.slice(0, 80) : undefined,
          grain: grain(c.grain),
        }))
    : [];

  const groupBy: ReportGroup[] = Array.isArray(r.groupBy)
    ? r.groupBy
        .filter((g): g is Record<string, unknown> => !!g && typeof g === 'object')
        .filter((g) => ok(g.field))
        .slice(0, 3) // up to three levels of nesting
        .map((g) => ({ field: String(g.field), grain: grain(g.grain) }))
    : [];

  const ALL_OPS = new Set<string>([
    ...TEXT_OPS, ...STATUS_OPS, ...NUMBER_OPS, ...DATE_OPS, ...BOOLEAN_OPS,
  ]);
  const filters: ReportFilter[] = Array.isArray(r.filters)
    ? r.filters
        .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
        .filter((f) => ok(f.field) && typeof f.op === 'string' && ALL_OPS.has(f.op))
        .slice(0, 30)
        .map((f) => ({
          field: String(f.field),
          op: f.op as FilterOp,
          value: typeof f.value === 'number' ? f.value
            : typeof f.value === 'string' ? f.value.slice(0, 200) : null,
          value2: typeof f.value2 === 'number' ? f.value2
            : typeof f.value2 === 'string' ? f.value2.slice(0, 200) : null,
          values: Array.isArray(f.values)
            ? f.values.map((v) => String(v).slice(0, 200)).slice(0, 50)
            : undefined,
          relative: typeof f.relative === 'string'
            && (RELATIVE_RANGES as readonly string[]).includes(f.relative)
            ? (f.relative as RelativeRange) : undefined,
        }))
    : [];

  const summarise: ReportSummary[] = Array.isArray(r.summarise)
    ? r.summarise
        .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
        .filter((s) => ok(s.field) && typeof s.agg === 'string'
          && (AGGREGATIONS as readonly string[]).includes(s.agg))
        .slice(0, 20)
        .map((s) => ({ field: String(s.field), agg: s.agg as Aggregation }))
    : [];

  const STAGE_KEYS = new Set([
    'survey', 'design', 'permits', 'procurement', 'install', 'inspection_pto', 'complete',
  ]);
  const stages = Array.isArray(r.stages)
    ? r.stages.map(String).filter((s) => STAGE_KEYS.has(s))
    : [];

  const rawRange = (r.dateRange ?? null) as Record<string, unknown> | null;
  const dateRange = rawRange && ok(rawRange.field)
    ? {
        field: String(rawRange.field),
        mode: rawRange.mode === 'fixed' ? ('fixed' as const) : ('relative' as const),
        relative: typeof rawRange.relative === 'string'
          && (RELATIVE_RANGES as readonly string[]).includes(rawRange.relative)
          ? (rawRange.relative as RelativeRange) : undefined,
        from: typeof rawRange.from === 'string' && DATE_RE.test(rawRange.from) ? rawRange.from : undefined,
        to: typeof rawRange.to === 'string' && DATE_RE.test(rawRange.to) ? rawRange.to : undefined,
      }
    : undefined;

  const rawScope = (r.recordScope ?? {}) as Record<string, unknown>;
  const scopeType = typeof rawScope.type === 'string'
    && (RECORD_SCOPES as readonly string[]).includes(rawScope.type)
    ? (rawScope.type as RecordScopeType) : 'all';
  const scopeId = typeof rawScope.id === 'string' && UUID_RE.test(rawScope.id) ? rawScope.id : undefined;

  const rawSort = (r.sort ?? null) as Record<string, unknown> | null;
  const sort = rawSort && ok(rawSort.field)
    ? { field: String(rawSort.field), dir: rawSort.dir === 'asc' ? ('asc' as const) : ('desc' as const) }
    : undefined;

  return {
    columns,
    groupBy,
    filters,
    summarise,
    stages,
    stageMode: r.stageMode === 'passed_through' ? 'passed_through' : 'currently_in',
    includeHold: r.includeHold !== false,
    includeCancelled: r.includeCancelled === true,
    dateRange,
    recordScope: { type: scopeType, id: scopeId },
    sort,
    includeInternalNotes: r.includeInternalNotes === true,
  };
}
