import {
  FIELD_BY_KEY,
  JOIN_SQL,
  type JoinKey,
  type ReportField,
} from './fields';
import type { DateGrain, ReportDefinition, ReportFilter } from './definition';

/**
 * Definition → parameterised SQL. Every identifier comes from the field
 * registry and every user value is a bound parameter, so nothing the user
 * types reaches the query text: this function is the security boundary of the
 * report module (spec §9). Queries still run through the caller's session
 * claims, so RLS narrows rows on top of whatever scope was asked for.
 */

export interface BuiltQuery {
  sql: string;
  params: unknown[];
  countSql: string;
  countParams: unknown[];
  /** Output columns in order, with the field behind each. */
  columns: Array<{ key: string; label: string; field: ReportField; grain?: DateGrain }>;
}

/** Wraps a date expression in its grain: month/quarter/year truncation. */
function grained(sql: string, grain?: DateGrain): string {
  if (!grain || grain === 'day') return sql;
  return `date_trunc('${grain}', (${sql})::timestamptz)::date`;
}

function relativeWindow(range: string): { from: string; to: string } | null {
  // Expressed as SQL date expressions, not values: no user input involved.
  switch (range) {
    case 'last_7_days': return { from: `current_date - interval '7 days'`, to: 'current_date' };
    case 'last_30_days': return { from: `current_date - interval '30 days'`, to: 'current_date' };
    case 'last_90_days': return { from: `current_date - interval '90 days'`, to: 'current_date' };
    case 'this_month': return { from: `date_trunc('month', current_date)`, to: 'current_date' };
    case 'this_quarter': return { from: `date_trunc('quarter', current_date)`, to: 'current_date' };
    case 'this_year': return { from: `date_trunc('year', current_date)`, to: 'current_date' };
    case 'year_to_date': return { from: `date_trunc('year', current_date)`, to: 'current_date' };
    default: return null;
  }
}

export function buildReportQuery(
  definition: ReportDefinition,
  options: { userId: string; limit: number; allowedFieldKeys: Set<string> }
): BuiltQuery {
  const params: unknown[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const needed = new Set<JoinKey>();
  const field = (key: string): ReportField | null => {
    if (!options.allowedFieldKeys.has(key)) return null;
    const f = FIELD_BY_KEY.get(key);
    if (!f) return null;
    for (const j of f.needs ?? []) needed.add(j);
    return f;
  };

  // --- SELECT list: group columns first, then the chosen columns ------------
  const columns: BuiltQuery['columns'] = [];
  const selects: string[] = [];
  const seen = new Set<string>();

  const push = (f: ReportField, grain: DateGrain | undefined, label: string) => {
    const alias = `c${columns.length}`;
    if (seen.has(`${f.key}:${grain ?? ''}`)) return;
    seen.add(`${f.key}:${grain ?? ''}`);
    selects.push(`${grained(f.sql, grain)} as "${alias}"`);
    columns.push({ key: alias, label, field: f, grain });
  };

  for (const g of definition.groupBy) {
    const f = field(g.field);
    if (f) push(f, g.grain, f.label);
  }
  for (const c of definition.columns) {
    const f = field(c.field);
    if (f) push(f, c.grain, c.label?.trim() || f.label);
  }
  // A report with nothing chosen still shows something recognisable.
  if (columns.length === 0) {
    const fallback = field('customer.full');
    if (fallback) push(fallback, undefined, fallback.label);
  }
  // Row identity for drill-through links, never displayed as a column.
  selects.push('p.id as "row_id"');

  // --- WHERE ----------------------------------------------------------------
  const where: string[] = [];

  // Stage scope: currently sitting in vs ever passed through.
  if (definition.stages.length > 0) {
    const list = bind(definition.stages);
    if (definition.stageMode === 'passed_through') {
      where.push(
        `(p.stage::text = any(${list}) or exists (
            select 1 from public.project_stage_events e
            where e.project_id = p.id and e.to_stage::text = any(${list})))`
      );
    } else {
      where.push(`p.stage::text = any(${list})`);
    }
  }

  if (!definition.includeHold) where.push(`p.status <> 'on_hold'`);
  if (!definition.includeCancelled) where.push(`p.status <> 'cancelled'`);

  // Date range, anchored on the field the user picked.
  if (definition.dateRange) {
    const anchor = field(definition.dateRange.field);
    if (anchor) {
      const expr = `(${anchor.sql})::date`;
      if (definition.dateRange.mode === 'relative' && definition.dateRange.relative) {
        const win = relativeWindow(definition.dateRange.relative);
        if (win) where.push(`${expr} between (${win.from})::date and (${win.to})::date`);
      } else {
        if (definition.dateRange.from) where.push(`${expr} >= ${bind(definition.dateRange.from)}::date`);
        if (definition.dateRange.to) where.push(`${expr} <= ${bind(definition.dateRange.to)}::date`);
      }
    }
  }

  // Record scope. RLS already limits non-admins; this narrows further.
  switch (definition.recordScope.type) {
    case 'mine':
      where.push(`p.assigned_pm = ${bind(options.userId)}`);
      break;
    case 'dealer':
      if (definition.recordScope.id) where.push(`p.dealer_id = ${bind(definition.recordScope.id)}`);
      break;
    case 'rep':
      if (definition.recordScope.id) where.push(`p.sales_rep_id = ${bind(definition.recordScope.id)}`);
      break;
    case 'pm':
      if (definition.recordScope.id) where.push(`p.assigned_pm = ${bind(definition.recordScope.id)}`);
      break;
    default:
      break;
  }

  for (const filter of definition.filters) {
    const clause = filterClause(filter, field, bind);
    if (clause) where.push(clause);
  }

  // --- ORDER BY: group levels first so subtotals fall in the right places --
  const order: string[] = [];
  for (const g of definition.groupBy) {
    const f = field(g.field);
    if (f) order.push(`${grained(f.sql, g.grain)} asc nulls last`);
  }
  if (definition.sort) {
    const f = field(definition.sort.field);
    if (f) order.push(`${f.sql} ${definition.sort.dir === 'asc' ? 'asc' : 'desc'} nulls last`);
  }
  order.push('p.created_at desc');

  // --- FROM: only the joins the chosen fields actually need ----------------
  const joins = JOIN_SQL.filter((j) => needed.has(j.key)).map((j) => j.sql).join('\n  ');
  const from = `from public.projects p\n  ${joins}`;
  const whereSql = where.length ? `where ${where.join('\n    and ')}` : '';

  const limit = Math.max(1, Math.min(options.limit, 20000));

  return {
    sql: `select ${selects.join(',\n       ')}
${from}
${whereSql}
order by ${order.join(', ')}
limit ${limit}`,
    params,
    countSql: `select count(*)::int as n\n${from}\n${whereSql}`,
    countParams: params,
    columns,
  };
}

function filterClause(
  filter: ReportFilter,
  resolve: (key: string) => ReportField | null,
  bind: (value: unknown) => string
): string | null {
  const f = resolve(filter.field);
  if (!f) return null;
  const expr = `(${f.sql})`;

  switch (filter.op) {
    case 'is_empty':
      return `${expr} is null`;
    case 'not_empty':
      return `${expr} is not null`;
    case 'contains':
      return filter.value ? `${expr}::text ilike ${bind(`%${filter.value}%`)}` : null;
    case 'not_contains':
      return filter.value ? `(${expr}::text is null or ${expr}::text not ilike ${bind(`%${filter.value}%`)})` : null;
    case 'equals':
    case 'is':
      return filter.value === null || filter.value === undefined
        ? null
        : `${expr}::text = ${bind(String(filter.value))}`;
    case 'is_not':
      return filter.value === null || filter.value === undefined
        ? null
        : `(${expr}::text is null or ${expr}::text <> ${bind(String(filter.value))})`;
    case 'is_any_of':
      return filter.values?.length ? `${expr}::text = any(${bind(filter.values)})` : null;
    case 'is_true':
      return `${expr} is true`;
    case 'is_false':
      return `coalesce(${expr}, false) is false`;
    case 'eq': case 'ne': case 'gt': case 'gte': case 'lt': case 'lte': {
      if (filter.value === null || filter.value === undefined || filter.value === '') return null;
      const ops: Record<string, string> = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
      return `${expr} ${ops[filter.op]} ${bind(Number(filter.value))}`;
    }
    case 'between': {
      if (f.type === 'date') {
        if (!filter.value || !filter.value2) return null;
        return `${expr}::date between ${bind(String(filter.value))}::date and ${bind(String(filter.value2))}::date`;
      }
      if (filter.value === null || filter.value2 === null) return null;
      return `${expr} between ${bind(Number(filter.value))} and ${bind(Number(filter.value2))}`;
    }
    case 'before':
      return filter.value ? `${expr}::date < ${bind(String(filter.value))}::date` : null;
    case 'after':
      return filter.value ? `${expr}::date > ${bind(String(filter.value))}::date` : null;
    case 'relative': {
      const win = filter.relative ? relativeWindow(filter.relative) : null;
      return win ? `${expr}::date between (${win.from})::date and (${win.to})::date` : null;
    }
    default:
      return null;
  }
}
