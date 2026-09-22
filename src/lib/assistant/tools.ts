import type Anthropic from '@anthropic-ai/sdk';
import { withUser, type SessionIdentity } from '../db';
import { optionalRows } from '../db-optional';
import { CONTACT_STAGES } from '../contacts/stage-columns';
import { parseFilters } from '../dashboard/filters';
import {
  dashboardContext,
  loadAttention,
  loadFunnel,
  loadHeadline,
  loadPmStats,
  loadSentiment,
} from '../dashboard/queries';
import { FIELD_BY_KEY } from '../reports/fields';
import { allowedKeysFor, runReport } from '../reports/run';
import { STAGES, STAGE_LABELS, isStageKey } from '../stages/definitions';
import { evaluateStage } from '../stages/requirements';
import { loadBundles, loadProjectCards, type ProjectCard } from '../stages/service';

/**
 * What the assistant can look at, and nothing else.
 *
 * Every tool reads through withUser(identity): the same claims, the same
 * row-level security and the same definer-function checks as the screens. The
 * assistant cannot see a project the person asking could not open, and a
 * dealer asking about "all projects" gets their own book. There is no tool
 * that writes: the assistant answers questions; people change things.
 *
 * Which tools are offered depends on the role, the way the navigation does —
 * a sales rep is not offered the dashboard, a dealer is not offered contacts —
 * so the model is never handed a tool that would only come back empty.
 */

export type ToolInput = Record<string, unknown>;

export interface AssistantTool {
  definition: Anthropic.Beta.BetaTool;
  /** A few words for the "working on it" line in the panel. */
  label: string;
  roles: readonly string[];
  run: (identity: SessionIdentity, input: ToolInput) => Promise<unknown>;
}

const STAFF = ['admin', 'ops', 'finance', 'sales', 'designer', 'dealer'] as const;
const OPS = ['admin', 'ops'] as const;
const SALES = ['admin', 'ops', 'sales'] as const;
const REPORTING = ['admin', 'ops', 'finance'] as const;

const str = (v: unknown, max = 200): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
const int = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const seesMoney = (role: string) => ['admin', 'ops', 'finance'].includes(role);

/** The part of a project card worth sending: small, and nothing internal. */
function cardSummary(c: ProjectCard, thresholds: Map<string, number>) {
  const threshold = thresholds.get(c.stage) ?? null;
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    customer: c.clientName,
    address: c.address,
    stage: STAGE_LABELS[c.stage] ?? c.stage,
    status: c.status,
    days_in_stage: c.daysInStage,
    ageing: threshold !== null && c.status === 'active' && c.daysInStage > threshold,
    missing_to_advance: c.missing,
    pm: c.pmName,
    dealer: c.dealerName,
    jurisdiction: c.jurisdictionName,
    system_kw: c.systemSizeKw,
    unread_customer_messages: c.unreadMessages,
    open_follow_ups: c.openFollowUps,
  };
}

async function thresholdsFor(identity: SessionIdentity): Promise<Map<string, number>> {
  const rows = await withUser(identity, (c) =>
    optionalRows<{ stage: string; attention_days: number }>(
      c,
      'the ageing thresholds',
      'select stage::text as stage, attention_days from public.stage_thresholds'
    )
  );
  return new Map(rows.map((r) => [r.stage, Number(r.attention_days)]));
}

function matches(c: ProjectCard, needle: string | null, field: string | null) {
  if (!needle) return true;
  return (field ?? '').toLowerCase().includes(needle.toLowerCase());
}

const STATUS_VALUES = ['active', 'on_hold', 'complete', 'cancelled'];

// ---------------------------------------------------------------------------

const findProjects: AssistantTool = {
  label: 'Looking up projects',
  roles: STAFF,
  definition: {
    name: 'find_projects',
    description:
      'List projects with their stage, days in stage, whether they are ageing past the stage threshold, ' +
      'what is missing before they can advance, PM, dealer and customer. Use for any question about which ' +
      'projects are where, stuck, late, missing paperwork, or belong to a PM, dealer, jurisdiction or customer. ' +
      'Returns at most `limit` rows plus the total that matched.',
    input_schema: {
      type: 'object',
      properties: {
        search: {
          type: 'string',
          description: 'Part of the project name, code (PRJ-…) or address.',
        },
        stage: { type: 'string', enum: [...STAGES], description: 'Only projects at this stage.' },
        status: {
          type: 'string',
          enum: STATUS_VALUES,
          description: 'Default: every status except complete.',
        },
        include_completed: { type: 'boolean', description: 'Include completed projects.' },
        pm: { type: 'string', description: 'Part of the assigned PM’s name.' },
        dealer: { type: 'string', description: 'Part of the dealer’s name.' },
        customer: { type: 'string', description: 'Part of the customer’s name.' },
        jurisdiction: { type: 'string', description: 'Part of the jurisdiction’s name.' },
        only_ageing: {
          type: 'boolean',
          description: 'Only active projects past their stage’s ageing threshold.',
        },
        only_blocked: {
          type: 'boolean',
          description: 'Only projects with something missing before they can advance.',
        },
        limit: { type: 'integer', description: 'Rows to return, 1–60. Default 25.' },
      },
      additionalProperties: false,
    },
  },
  async run(identity, input) {
    const stage = str(input.stage);
    const status = str(input.status);
    const cards = await loadProjectCards(identity, {
      q: str(input.search) ?? undefined,
      stage: stage && isStageKey(stage) ? stage : undefined,
      status: status && STATUS_VALUES.includes(status) ? status : undefined,
      includeCompleted: input.include_completed === true || status === 'complete',
    });
    const thresholds = await thresholdsFor(identity);
    const rows = cards
      .filter((c) => matches(c, str(input.pm), c.pmName))
      .filter((c) => matches(c, str(input.dealer), c.dealerName))
      .filter((c) => matches(c, str(input.customer), c.clientName))
      .filter((c) => matches(c, str(input.jurisdiction), c.jurisdictionName))
      .map((c) => cardSummary(c, thresholds))
      .filter((c) => input.only_ageing !== true || c.ageing)
      .filter((c) => input.only_blocked !== true || c.missing_to_advance.length > 0);
    const limit = int(input.limit, 1, 60, 25);
    return {
      total_matched: rows.length,
      scanned_limit_note:
        cards.length >= 300 ? 'Only the 300 newest projects were scanned.' : undefined,
      projects: rows.slice(0, limit),
    };
  },
};

const projectDetails: AssistantTool = {
  label: 'Reading the project',
  roles: STAFF,
  definition: {
    name: 'project_details',
    description:
      'Everything about one project: customer, site, system, dealer, PM, stage and status, what is missing ' +
      'before it can advance, its stage history with dates, change orders, documents on file, open requests to ' +
      'the customer, recent ratings and the latest activity. Use when a question is about a single project.',
    input_schema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'The project code (PRJ-…), its id, or part of its name.',
        },
      },
      required: ['project'],
      additionalProperties: false,
    },
  },
  async run(identity, input) {
    const key = str(input.project);
    if (!key) return { error: 'Say which project.' };
    return withUser(identity, async (c) => {
      const { rows } = await c.query(
        `select p.*, cl.first_name || ' ' || cl.last_name as customer, cl.email as customer_email,
                cl.phone as customer_phone, dl.name as dealer, pm.full_name as pm,
                j.name as jurisdiction, u.name as utility
           from public.projects p
           left join public.clients cl on cl.id = p.client_id
           left join public.dealers dl on dl.id = p.dealer_id
           left join public.profiles pm on pm.id = p.assigned_pm
           left join public.jurisdictions j on j.id = p.jurisdiction_id
           left join public.utilities u on u.id = p.utility_id
          where p.id::text = $1 or upper(p.code) = upper($1) or p.name ilike '%' || $1 || '%'
          order by (p.id::text = $1 or upper(p.code) = upper($1)) desc, p.created_at desc
          limit 5`,
        [key]
      );
      if (rows.length === 0) return { error: `No project matching “${key}” that you can see.` };
      if (
        rows.length > 1 &&
        !(rows[0].id === key || String(rows[0].code).toUpperCase() === key.toUpperCase())
      ) {
        return {
          ambiguous: true,
          candidates: rows.map((r) => ({
            code: r.code,
            name: r.name,
            address: r.address,
            stage: r.stage,
          })),
        };
      }
      const p = rows[0];
      const bundles = await loadBundles(c, [p.id]);
      const bundle = bundles.get(p.id);
      const stage = isStageKey(String(p.stage))
        ? (String(p.stage) as (typeof STAGES)[number])
        : 'survey';
      const history = await optionalRows(
        c,
        'stage history',
        `select changed_at::date::text as date, from_stage::text as "from", to_stage::text as "to"
           from public.project_stage_events where project_id = $1 order by changed_at`,
        [p.id]
      );
      const changeOrders = await optionalRows(
        c,
        'change orders',
        `select number, status::text, reason, amount_delta, approved_at::date::text as approved
           from public.change_orders where project_id = $1 order by number`,
        [p.id]
      );
      const documents = await optionalRows(
        c,
        'documents',
        `select category, title, created_at::date::text as added
           from public.documents where project_id = $1 order by created_at desc limit 40`,
        [p.id]
      );
      const asks = await optionalRows(
        c,
        'open customer asks',
        `select label, created_at::date::text as asked from public.customer_asks
          where project_id = $1 and fulfilled_at is null and cancelled_at is null`,
        [p.id]
      );
      const ratings = await optionalRows(
        c,
        'stage ratings',
        `select stage::text, score, comment, created_at::date::text as date
           from public.stage_feedback where project_id = $1 and score is not null
          order by created_at desc limit 6`,
        [p.id]
      );
      const activity = await optionalRows(
        c,
        'activity',
        `select occurred_at::date::text as date, action, actor_role
           from public.audit_log where project_id = $1 and action not in ('insert', 'update', 'delete')
          order by occurred_at desc limit 12`,
        [p.id]
      );
      return {
        id: p.id,
        code: p.code,
        name: p.name,
        customer: p.customer,
        customer_email: p.customer_email,
        customer_phone: p.customer_phone,
        address: p.address,
        stage: STAGE_LABELS[stage],
        status: p.status,
        hold_reason: p.hold_reason ?? undefined,
        dealer: p.dealer,
        pm: p.pm,
        jurisdiction: p.jurisdiction,
        utility: p.utility,
        system_kw: p.system_size_kw === null ? null : Number(p.system_size_kw),
        module_quantity: p.module_quantity ?? null,
        battery_quantity: p.battery_quantity ?? null,
        contract_value:
          seesMoney(identity.role) && p.contract_value !== null
            ? Number(p.contract_value)
            : undefined,
        estimated_completion_shown_to_customer: p.customer_estimate ?? null,
        created: p.created_at ? new Date(p.created_at).toISOString().slice(0, 10) : null,
        missing_to_advance: bundle && p.status !== 'complete' ? evaluateStage(stage, bundle) : [],
        stage_history: history,
        change_orders: seesMoney(identity.role)
          ? changeOrders
          : changeOrders.map(({ amount_delta: _a, ...rest }) => rest),
        documents,
        open_requests_to_customer: asks,
        recent_ratings: ratings,
        recent_activity: activity,
      };
    });
  },
};

const dashboardSummary: AssistantTool = {
  label: 'Reading the dashboard',
  roles: REPORTING,
  definition: {
    name: 'dashboard_summary',
    description:
      'The operations dashboard for a period: active, completed and on-hold counts, average days to complete, ' +
      'pipeline value (when the asker may see money), projects per stage, the needs-attention lists (ageing ' +
      'past threshold, on hold, unhappy customers) and per-PM workload with average completion days and reply time.',
    input_schema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['month', 'quarter', 'year', 'all'],
          description: 'Default: month.',
        },
      },
      additionalProperties: false,
    },
  },
  async run(identity, input) {
    const period = str(input.period) ?? 'month';
    const { ready, ctx, refs } = await dashboardContext(identity, parseFilters({ period }));
    if (!ready) return { error: 'The dashboard is not set up on this database yet.' };
    const financial =
      identity.role === 'admin' ||
      identity.role === 'finance' ||
      (identity.role === 'ops' && refs.opsSeeFinancials);
    return withUser(identity, async (c) => {
      const headline = await loadHeadline(c, ctx, {
        financial,
        onHoldThreshold: refs.onHoldThreshold,
      });
      const funnel = await loadFunnel(c, ctx);
      const attention = await loadAttention(c, ctx);
      const pms = await loadPmStats(c, ctx);
      const { sparkline: _s, ...head } = headline;
      return {
        period: ctx.period,
        headline: head,
        projects_per_stage: funnel,
        needs_attention: {
          ageing: attention.ageing.slice(0, 25),
          on_hold: attention.holds.slice(0, 25),
          unhappy_customers: (attention as { unhappy?: unknown[] }).unhappy?.slice(0, 15),
        },
        pm_workload: pms,
      };
    });
  },
};

const pmReport: AssistantTool = {
  label: 'Building the PM report',
  roles: OPS,
  definition: {
    name: 'pm_report',
    description:
      'A PM report: for each project manager (or one, by name), their active projects grouped by stage, with ' +
      'days in stage, what is blocking each one, which are ageing past threshold, unread customer messages and ' +
      'open follow-ups — plus totals. Use for "PM report", "what is on X’s plate", "who is overloaded".',
    input_schema: {
      type: 'object',
      properties: {
        pm: { type: 'string', description: 'Part of one PM’s name. Omit for every PM.' },
      },
      additionalProperties: false,
    },
  },
  async run(identity, input) {
    const cards = await loadProjectCards(identity, {});
    const thresholds = await thresholdsFor(identity);
    const who = str(input.pm);
    const byPm = new Map<string, ReturnType<typeof cardSummary>[]>();
    for (const c of cards) {
      if (c.status === 'cancelled') continue;
      if (who && !matches(c, who, c.pmName)) continue;
      const k = c.pmName ?? 'Unassigned';
      if (!byPm.has(k)) byPm.set(k, []);
      byPm.get(k)!.push(cardSummary(c, thresholds));
    }
    return {
      pms: [...byPm.entries()].map(([pm, projects]) => ({
        pm,
        active: projects.filter((p) => p.status === 'active').length,
        on_hold: projects.filter((p) => p.status === 'on_hold').length,
        ageing: projects.filter((p) => p.ageing).length,
        blocked: projects.filter((p) => p.missing_to_advance.length > 0).length,
        unread_customer_messages: projects.reduce((n, p) => n + p.unread_customer_messages, 0),
        open_follow_ups: projects.reduce((n, p) => n + p.open_follow_ups, 0),
        projects: projects
          .sort((a, b) => b.days_in_stage - a.days_in_stage)
          .slice(0, 40)
          .map(({ pm: _pm, ...rest }) => rest),
      })),
    };
  },
};

const REPORT_FIELD_HELP =
  'Field keys come from the report builder; the list of keys available to this user is in the system prompt.';

const runReportTool: AssistantTool = {
  label: 'Running a report',
  roles: REPORTING,
  definition: {
    name: 'run_report',
    description:
      'Run the report builder: choose columns, optional group-by and summaries, filters and stages, and get ' +
      'rows with totals. The flexible tool for counts, averages, sums, turnaround times and breakdowns by ' +
      'dealer, PM, jurisdiction, month or stage. ' +
      REPORT_FIELD_HELP,
    input_schema: {
      type: 'object',
      properties: {
        columns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              grain: { type: 'string', enum: ['day', 'month', 'quarter', 'year'] },
            },
            required: ['field'],
          },
        },
        group_by: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              grain: { type: 'string', enum: ['day', 'month', 'quarter', 'year'] },
            },
            required: ['field'],
          },
        },
        summarise: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              agg: { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max', 'median'] },
            },
            required: ['field', 'agg'],
          },
        },
        filters: {
          type: 'array',
          description:
            'Each {field, op, value?, value2?, values?}. Ops by type — text: contains, not_contains, equals, ' +
            'is_empty, not_empty; status: is, is_not, is_any_of (values), is_empty, not_empty; number/currency: ' +
            'eq, ne, gt, gte, lt, lte, between (value, value2), is_empty, not_empty; date: before, after, between ' +
            '(yyyy-mm-dd), relative (value: last_7_days, last_30_days, this_month, last_month, this_quarter, ' +
            'this_year), is_empty, not_empty; boolean: is_true, is_false.',
          items: { type: 'object' },
        },
        stages: { type: 'array', items: { type: 'string', enum: [...STAGES] } },
        stage_mode: { type: 'string', enum: ['currently_in', 'passed_through'] },
        include_hold: { type: 'boolean' },
        include_cancelled: { type: 'boolean' },
        sort: {
          type: 'object',
          properties: { field: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } },
        },
        limit: { type: 'integer', description: 'Rows, 1–100. Default 50.' },
      },
      required: ['columns'],
      additionalProperties: false,
    },
  },
  async run(identity, input) {
    const allowed = allowedKeysFor(identity, false);
    const unknown = [
      ...((input.columns as Array<{ field?: unknown }>) ?? []),
      ...((input.group_by as Array<{ field?: unknown }>) ?? []),
      ...((input.summarise as Array<{ field?: unknown }>) ?? []),
      ...((input.filters as Array<{ field?: unknown }>) ?? []),
    ]
      .map((c) => String(c?.field ?? ''))
      .filter((k) => k && !allowed.has(k));
    if (unknown.length) {
      return {
        error: `Unknown or not permitted field keys: ${[...new Set(unknown)].join(', ')}. Use keys from the list.`,
      };
    }
    const definition = {
      columns: input.columns,
      groupBy: input.group_by ?? [],
      summarise: input.summarise ?? [],
      filters: input.filters ?? [],
      stages: input.stages ?? [],
      stageMode: input.stage_mode === 'passed_through' ? 'passed_through' : 'currently_in',
      includeHold: input.include_hold !== false,
      includeCancelled: input.include_cancelled === true,
      recordScope: { type: 'all' },
      sort: input.sort,
    };
    const { result } = await runReport(identity, definition, {
      limit: int(input.limit, 1, 100, 50),
    });
    return {
      columns: result.columns,
      rows: result.rows,
      total_rows: result.totalRows,
      truncated: result.truncated,
      groups: result.groups,
      totals: result.totals,
    };
  },
};

const findContacts: AssistantTool = {
  label: 'Looking up contacts',
  roles: SALES,
  definition: {
    name: 'find_contacts',
    description:
      'Contacts (people) in the CRM with their contact stage, owner, dealer, days in stage and last contact. ' +
      'Use for sales questions: who is quoted, who has not been called, a person’s details.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Part of a name, email or phone.' },
        contact_stage: { type: 'string', enum: [...CONTACT_STAGES] },
        owner: { type: 'string', description: 'Part of the owner’s name.' },
        not_contacted_for_days: {
          type: 'integer',
          description: 'Only people not contacted for at least this many days.',
        },
        limit: { type: 'integer', description: '1–60. Default 25.' },
      },
      additionalProperties: false,
    },
  },
  async run(identity, input) {
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replaceAll('?', `$${params.length}`));
    };
    const q = str(input.search);
    if (q)
      add(
        `(c.first_name || ' ' || c.last_name ilike '%' || ? || '%' or c.email ilike '%' || ? || '%' or c.phone ilike '%' || ? || '%')`,
        q
      );
    const stage = str(input.contact_stage);
    if (stage && (CONTACT_STAGES as readonly string[]).includes(stage))
      add('c.contact_stage = ?', stage);
    const owner = str(input.owner);
    if (owner) add(`o.full_name ilike '%' || ? || '%'`, owner);
    if (input.not_contacted_for_days !== undefined) {
      add(
        `coalesce(c.last_contacted_at, c.created_at) < now() - make_interval(days => ?)`,
        int(input.not_contacted_for_days, 0, 3650, 14)
      );
    }
    const limit = int(input.limit, 1, 60, 25);
    const rows = await withUser(identity, (c) =>
      optionalRows(
        c,
        'contacts',
        `select c.first_name || ' ' || c.last_name as name, c.email, c.phone, c.contact_stage,
                o.full_name as owner, d.name as dealer,
                c.mailing_city as city,
                (current_date - coalesce(c.contact_stage_at, c.created_at)::date) as days_in_stage,
                c.last_contacted_at::date::text as last_contacted
           from public.clients c
           left join public.profiles o on o.id = c.owner_id
           left join public.dealer_directory() d on d.id = c.dealer_id
          where not coalesce(c.is_archived, false)${where.length ? ' and ' + where.join(' and ') : ''}
          order by c.created_at desc
          limit ${limit + 1}`,
        params
      )
    );
    return { contacts: rows.slice(0, limit), more: rows.length > limit };
  },
};

const findDeals: AssistantTool = {
  label: 'Looking up deals',
  roles: SALES,
  definition: {
    name: 'find_deals',
    description:
      'Sales deals with stage, customer, system size, price, probability, expected close, next action and ' +
      'owner — and a count and value per stage. Use for pipeline and forecast questions on the sales side.',
    input_schema: {
      type: 'object',
      properties: {
        search: {
          type: 'string',
          description: 'Part of the customer’s name, the address or the deal code.',
        },
        stage: {
          type: 'string',
          enum: [
            'new',
            'contacted',
            'qualified',
            'proposal',
            'negotiation',
            'contract_out',
            'won',
            'lost',
          ],
        },
        owner: { type: 'string' },
        limit: { type: 'integer', description: '1–60. Default 25.' },
      },
      additionalProperties: false,
    },
  },
  async run(identity, input) {
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replaceAll('?', `$${params.length}`));
    };
    const q = str(input.search);
    if (q)
      add(
        `(concat_ws(' ', d.customer_first, d.customer_last) ilike '%' || ? || '%' or d.address ilike '%' || ? || '%' or d.code ilike '%' || ? || '%')`,
        q
      );
    const stage = str(input.stage);
    if (stage) add('d.stage = ?', stage);
    const owner = str(input.owner);
    if (owner) add(`o.full_name ilike '%' || ? || '%'`, owner);
    const limit = int(input.limit, 1, 60, 25);
    return withUser(identity, async (c) => {
      const deals = await optionalRows(
        c,
        'deals',
        `select d.code, concat_ws(' ', d.customer_first, d.customer_last) as customer, d.address, d.stage,
                d.system_size_kw, d.contract_value, d.gross_price, d.probability,
                d.expected_close_date::text as expected_close, d.next_action, d.next_action_at::text as next_action_at,
                o.full_name as owner, (current_date - d.stage_entered_at::date) as days_in_stage
           from public.deals d left join public.profiles o on o.id = d.owner_id
          ${where.length ? 'where ' + where.join(' and ') : ''}
          order by d.updated_at desc limit ${limit + 1}`,
        params
      );
      const byStage = await optionalRows(
        c,
        'deals by stage',
        `select stage, count(*)::int as deals, sum(coalesce(contract_value, gross_price))::numeric(14,2) as value,
                sum(coalesce(contract_value, gross_price) * coalesce(probability, 0) / 100.0)::numeric(14,2) as weighted
           from public.deals group by stage order by stage`
      );
      return { by_stage: byStage, deals: deals.slice(0, limit), more: deals.length > limit };
    });
  },
};

const customerFeedback: AssistantTool = {
  label: 'Reading customer feedback',
  roles: OPS,
  definition: {
    name: 'customer_feedback',
    description:
      'Customer ratings after each stage: average score and response rate per stage and per party, and recent ' +
      'comments. Use for customer satisfaction questions.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async run(identity) {
    return withUser(identity, (c) => loadSentiment(c));
  },
};

export const ALL_TOOLS: AssistantTool[] = [
  findProjects,
  projectDetails,
  dashboardSummary,
  pmReport,
  runReportTool,
  findContacts,
  findDeals,
  customerFeedback,
];

export function toolsFor(role: string): AssistantTool[] {
  return ALL_TOOLS.filter((t) => t.roles.includes(role));
}

/** The report fields this role may use, compactly, for the system prompt. */
export function reportFieldCatalog(identity: SessionIdentity): string {
  const keys = [...allowedKeysFor(identity, false)];
  return keys
    .map((k) => FIELD_BY_KEY.get(k))
    .filter((f): f is NonNullable<typeof f> => Boolean(f))
    .map((f) => `${f.key} | ${f.label} | ${f.type}${f.groupable ? ' | group' : ''}`)
    .join('\n');
}

/** Tool output, bounded: a runaway result must not fill the context window. */
export function serialiseResult(value: unknown, max = 40_000): string {
  const text = JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
  return text.length > max
    ? `${text.slice(0, max)}… [truncated — ask for fewer rows or narrower filters]`
    : text;
}
