import type { PoolClient } from 'pg';
import type { SessionIdentity } from '../db';
import { STAGES, STAGE_LABELS, type StageKey } from '../stages/definitions';

/**
 * Dealer portal data layer. Every query here runs under the dealer's own
 * session claims, so RLS already scopes rows to their company's projects —
 * these helpers only add the optional rep narrowing and shape the data.
 * Nothing in this module exposes internal notes, costs, or margins.
 */

export interface DealerScope {
  /** Extra WHERE fragment (references alias p) + params, for rep scoping. */
  clause: string;
  params: unknown[];
}

/**
 * Optional per-company setting: when the dealer company has
 * reps_see_own_only on and this login's email matches a sales rep, narrow
 * every project query to that rep. Owners/managers (no matching rep) see all.
 */
export async function dealerScope(client: PoolClient, session: SessionIdentity): Promise<DealerScope> {
  const { rows } = await client.query<{ rep_id: string }>(
    `select sr.id as rep_id
     from public.dealer_users du
     join public.dealers d on d.id = du.dealer_id and d.reps_see_own_only
     join public.sales_reps sr on sr.dealer_id = d.id
       and lower(sr.email) = lower((select email from public.profiles where id = $1))
     where du.user_id = $1
     limit 1`,
    [session.userId]
  );
  if (!rows[0]) return { clause: '', params: [] };
  return { clause: ' and p.sales_rep_id = $SCOPE$', params: [rows[0].rep_id] };
}

export interface DealerProjectRow {
  id: string;
  name: string;
  address: string | null;
  systemSizeKw: number | null;
  salesRepName: string | null;
  stage: StageKey;
  status: string;
  stageStatus: string;
  daysInStage: number;
  projectTotal: number | null;
  commissionStatus: string | null;
  updatedAt: string;
}

const STAGE_STATUS_SQL = `case p.stage
  when 'survey' then s1.survey_status
  when 'design' then s2.design_status
  when 'permits' then s3.permit_status
  when 'procurement' then s4.material_status
  when 'install' then s5.install_status
  when 'inspection_pto' then s6.inspection_status
  when 'complete' then 'complete'
end`;

/** The dealer's project list — RLS keeps it to their book. */
export async function loadDealerProjects(
  client: PoolClient,
  session: SessionIdentity,
  filters: { q?: string; stage?: string; status?: string } = {}
): Promise<DealerProjectRow[]> {
  const scope = await dealerScope(client, session);
  const params: unknown[] = [...scope.params];
  const scopeClause = scope.clause.replace('$SCOPE$', `$${scope.params.length}`);

  const where: string[] = [];
  if (filters.stage && (STAGES as readonly string[]).includes(filters.stage)) {
    params.push(filters.stage);
    where.push(`p.stage = $${params.length}::public.project_stage`);
  }
  if (filters.status && ['active', 'on_hold', 'complete', 'cancelled'].includes(filters.status)) {
    params.push(filters.status);
    where.push(`p.status = $${params.length}::public.project_status`);
  }
  if (filters.q) {
    params.push(`%${filters.q}%`);
    where.push(`(p.name ilike $${params.length} or p.address ilike $${params.length})`);
  }

  const { rows } = await client.query(
    `select p.id, p.name, p.address, p.system_size_kw, p.stage, p.status,
            p.contract_value,
            sr.name as sales_rep_name,
            cm.status as commission_status,
            coalesce((select max(e.changed_at) from public.project_stage_events e
                      where e.project_id = p.id), p.created_at) as stage_since,
            greatest(p.created_at, coalesce((select max(e.changed_at)
                      from public.project_stage_events e where e.project_id = p.id),
                      p.created_at)) as updated_at,
            ${STAGE_STATUS_SQL} as stage_status
     from public.projects p
     left join public.sales_reps sr on sr.id = p.sales_rep_id
     left join public.commissions cm on cm.project_id = p.id
     left join public.stage1_survey s1 on s1.project_id = p.id
     left join public.stage2_design s2 on s2.project_id = p.id
     left join public.stage3_permit s3 on s3.project_id = p.id
     left join public.stage4_procurement s4 on s4.project_id = p.id
     left join public.stage5_install s5 on s5.project_id = p.id
     left join public.stage6_inspection s6 on s6.project_id = p.id
     where true ${scopeClause} ${where.length ? ' and ' + where.join(' and ') : ''}
     order by updated_at desc
     limit 500`,
    params
  );

  const now = Date.now();
  return rows.map((r) => {
    const stageStatus = r.stage_status ?? '—';
    return {
      id: r.id,
      name: r.name,
      address: r.address,
      systemSizeKw: r.system_size_kw === null ? null : Number(r.system_size_kw),
      salesRepName: r.sales_rep_name,
      stage: r.stage as StageKey,
      status: r.status,
      stageStatus: String(stageStatus),
      daysInStage: Math.max(0, Math.floor((now - new Date(r.stage_since).getTime()) / 86_400_000)),
      projectTotal: r.contract_value === null ? null : Number(r.contract_value),
      commissionStatus: r.commission_status,
      updatedAt: r.updated_at,
    };
  });
}

export interface DealerStats {
  active: number;
  completedThisQuarter: number;
  avgDaysToCompletion: number | null;
  commissionPending: number;
  byColumn: Array<{ key: string; label: string; count: number }>;
}

/** Dashboard stat cards + projects-by-stage counts. */
export async function loadDealerStats(
  client: PoolClient,
  session: SessionIdentity
): Promise<DealerStats> {
  const scope = await dealerScope(client, session);
  const scopeClause = scope.clause.replace('$SCOPE$', '$1');
  const params = scope.params;

  const { rows } = await client.query(
    `select
       count(*) filter (where p.status not in ('complete', 'cancelled')) as active,
       count(*) filter (where p.status = 'complete'
         and s7.completion_date >= date_trunc('quarter', current_date)) as completed_q,
       avg(s7.completion_date - p.created_at::date)
         filter (where p.status = 'complete' and s7.completion_date is not null) as avg_days,
       coalesce(sum(cm.base_amount + cm.adjustment)
         filter (where cm.status in ('pending', 'payable')), 0) as pending_commission
     from public.projects p
     left join public.stage7_complete s7 on s7.project_id = p.id
     left join public.commissions cm on cm.project_id = p.id
     where true ${scopeClause}`,
    params
  );

  const counts = await client.query(
    `select case when p.status = 'on_hold' then 'hold'
                 when p.status = 'cancelled' then 'cancelled'
                 else p.stage::text end as col, count(*) as n
     from public.projects p
     where true ${scopeClause}
     group by 1`,
    params
  );
  const byKey = new Map(counts.rows.map((r) => [r.col, Number(r.n)]));
  const byColumn = [
    ...STAGES.map((s) => ({ key: s as string, label: STAGE_LABELS[s], count: byKey.get(s) ?? 0 })),
    { key: 'hold', label: 'Hold', count: byKey.get('hold') ?? 0 },
    { key: 'cancelled', label: 'Cancelled', count: byKey.get('cancelled') ?? 0 },
  ];

  const s = rows[0];
  return {
    active: Number(s.active),
    completedThisQuarter: Number(s.completed_q),
    avgDaysToCompletion: s.avg_days === null ? null : Math.round(Number(s.avg_days)),
    commissionPending: Number(s.pending_commission),
    byColumn,
  };
}
