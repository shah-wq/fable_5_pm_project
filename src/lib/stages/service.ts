import type { PoolClient } from 'pg';
import { logAuditEvent } from '../audit';
import { withUser, type SessionIdentity } from '../db';
import { isStageKey, nextStage, prevStage, type StageKey } from './definitions';
import { evaluateStage, type StageBundle } from './requirements';

/**
 * Data loading + the shared move service. Everything runs through the
 * caller's session claims (withUser), so RLS scopes what each role can even
 * see; the advance button and Kanban drag both call moveProject() — one code
 * path, as the spec demands.
 */

export interface ProjectCard {
  id: string;
  code: string;
  name: string;
  address: string | null;
  stage: StageKey;
  status: string;
  systemSizeKw: number | null;
  daysInStage: number;
  missing: string[];
  clientName: string | null;
  dealerName: string | null;
  jurisdictionName: string | null;
  pmName: string | null;
  createdAt: string;
}

/** Batched load of everything evaluateStage needs, for many projects. */
export async function loadBundles(
  client: PoolClient,
  projectIds: string[]
): Promise<Map<string, StageBundle>> {
  const bundles = new Map<string, StageBundle>();
  if (projectIds.length === 0) return bundles;
  const ids = [projectIds];

  const [projects, surveys, designs, procurements, installs, inspections, permits, bom, adders, cos, docs] =
    await Promise.all([
      client.query(
        `select id, jurisdiction_id, utility_id, finance_partner_id
         from public.projects where id = any($1)`, ids),
      client.query(
        `select project_id, hoa_applies, hoa_id, survey_date, time_window, surveyor_id,
                survey_status, roof_type, roof_pitch, main_panel_adequate
         from public.stage_survey where project_id = any($1)`, ids),
      client.query(
        `select project_id, designer_id, assigned_date, due_date, adder_approval_date,
                new_contract_total, finance_notified_date, finance_acked_date,
                production_kwh, client_approval_date, pe_stamp_date
         from public.stage_design where project_id = any($1)`, ids),
      client.query(
        `select project_id, delivery_date, delivery_ok
         from public.stage_procurement where project_id = any($1)`, ids),
      client.query(
        `select project_id, crew_id, start_date, end_date, customer_confirmed,
                work_order_date, install_status, completion_date, punch_list, punch_resolved_date
         from public.stage_install where project_id = any($1)`, ids),
      client.query(
        `select project_id, inspection_date, time_window, crew_confirmed, result,
                pto_submitted_date, pto_issued_date, handoff_done
         from public.stage_inspection where project_id = any($1)`, ids),
      client.query(
        `select project_id, permit_type, status, submission_method, submitted_at,
                reference_no, approved_at
         from public.permits where project_id = any($1)`, ids),
      client.query(
        `select project_id, line_status, vendor_id, po_number, order_date
         from public.bom_items where project_id = any($1)`, ids),
      client.query(
        `select project_id, count(*)::int as n
         from public.project_adders where project_id = any($1) group by project_id`, ids),
      client.query(
        `select project_id, count(*)::int as n
         from public.change_orders where project_id = any($1) and document_id is not null
         group by project_id`, ids),
      client.query(
        `select distinct project_id, category
         from public.documents where project_id = any($1) and category is not null`, ids),
    ]);

  const by = <T extends { project_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const list = m.get(r.project_id) ?? [];
      list.push(r);
      m.set(r.project_id, list);
    }
    return m;
  };
  const surveyBy = by(surveys.rows);
  const designBy = by(designs.rows);
  const procBy = by(procurements.rows);
  const installBy = by(installs.rows);
  const inspBy = by(inspections.rows);
  const permitsBy = by(permits.rows);
  const bomBy = by(bom.rows);
  const addersBy = by(adders.rows);
  const cosBy = by(cos.rows);
  const docsBy = by(docs.rows);

  for (const p of projects.rows) {
    const s = surveyBy.get(p.id)?.[0];
    const d = designBy.get(p.id)?.[0];
    const pr = procBy.get(p.id)?.[0];
    const i = installBy.get(p.id)?.[0];
    const q = inspBy.get(p.id)?.[0];
    bundles.set(p.id, {
      project: {
        jurisdictionId: p.jurisdiction_id,
        utilityId: p.utility_id,
        financePartnerId: p.finance_partner_id,
      },
      survey: s
        ? {
            hoaApplies: s.hoa_applies,
            hoaId: s.hoa_id,
            surveyDate: s.survey_date,
            timeWindow: s.time_window,
            surveyorId: s.surveyor_id,
            surveyStatus: s.survey_status,
            roofType: s.roof_type,
            roofPitch: s.roof_pitch,
            mainPanelAdequate: s.main_panel_adequate,
          }
        : null,
      design: d
        ? {
            designerId: d.designer_id,
            assignedDate: d.assigned_date,
            dueDate: d.due_date,
            adderApprovalDate: d.adder_approval_date,
            newContractTotal: d.new_contract_total,
            financeNotifiedDate: d.finance_notified_date,
            financeAckedDate: d.finance_acked_date,
            productionKwh: d.production_kwh,
            clientApprovalDate: d.client_approval_date,
            peStampDate: d.pe_stamp_date,
          }
        : null,
      permits: (permitsBy.get(p.id) ?? []).map((r) => ({
        permitType: r.permit_type,
        status: r.status,
        submissionMethod: r.submission_method,
        submittedAt: r.submitted_at,
        referenceNo: r.reference_no,
        approvedAt: r.approved_at,
      })),
      bomLines: (bomBy.get(p.id) ?? []).map((r) => ({
        lineStatus: r.line_status,
        vendorId: r.vendor_id,
        poNumber: r.po_number,
        orderDate: r.order_date,
      })),
      procurement: pr ? { deliveryDate: pr.delivery_date, deliveryOk: pr.delivery_ok } : null,
      install: i
        ? {
            crewId: i.crew_id,
            startDate: i.start_date,
            endDate: i.end_date,
            customerConfirmed: i.customer_confirmed,
            workOrderDate: i.work_order_date,
            installStatus: i.install_status,
            completionDate: i.completion_date,
            punchList: i.punch_list,
            punchResolvedDate: i.punch_resolved_date,
          }
        : null,
      inspection: q
        ? {
            inspectionDate: q.inspection_date,
            timeWindow: q.time_window,
            crewConfirmed: q.crew_confirmed,
            result: q.result,
            ptoSubmittedDate: q.pto_submitted_date,
            ptoIssuedDate: q.pto_issued_date,
            handoffDone: q.handoff_done,
          }
        : null,
      adderCount: addersBy.get(p.id)?.[0]?.n ?? 0,
      signedChangeOrderCount: cosBy.get(p.id)?.[0]?.n ?? 0,
      docCategories: new Set((docsBy.get(p.id) ?? []).map((r) => r.category)),
    });
  }
  return bundles;
}

interface CardFilters {
  q?: string;
  stage?: string;
  status?: string;
  jurisdictionId?: string;
  dealerId?: string;
  includeCompleted?: boolean;
}

/** Projects + computed days-in-stage + missing items, RLS-scoped. */
export async function loadProjectCards(
  session: SessionIdentity,
  filters: CardFilters = {}
): Promise<ProjectCard[]> {
  return withUser(session, async (client) => {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };

    if (!filters.includeCompleted && !filters.status) where.push(`p.status <> 'complete'`);
    if (filters.status) add('p.status = ?::public.project_status', filters.status);
    if (filters.stage) add('p.stage = ?::public.project_stage', filters.stage);
    if (filters.jurisdictionId) add('p.jurisdiction_id = ?', filters.jurisdictionId);
    if (filters.dealerId) add('p.dealer_id = ?', filters.dealerId);
    if (filters.q) {
      add(
        `(p.name ilike ? or p.address ilike '%' || $${params.length + 1} || '%' or p.code ilike '%' || $${params.length + 1} || '%')`,
        `%${filters.q}%`
      );
    }

    const { rows } = await client.query(
      `select p.id, p.code, p.name, p.address, p.stage, p.status, p.system_size_kw,
              p.created_at,
              c.first_name || ' ' || c.last_name as client_name,
              dl.name as dealer_name,
              j.name as jurisdiction_name,
              pm.full_name as pm_name,
              coalesce((select max(e.changed_at) from public.project_stage_events e
                        where e.project_id = p.id), p.created_at) as stage_since
       from public.projects p
       left join public.clients c on c.id = p.client_id
       left join public.dealers dl on dl.id = p.dealer_id
       left join public.jurisdictions j on j.id = p.jurisdiction_id
       left join public.profiles pm on pm.id = p.assigned_pm
       ${where.length ? 'where ' + where.join(' and ') : ''}
       order by p.created_at desc
       limit 300`,
      params
    );

    const bundles = await loadBundles(
      client,
      rows.map((r) => r.id)
    );

    const now = Date.now();
    return rows.map((r) => {
      const bundle = bundles.get(r.id);
      const stage = r.stage as StageKey;
      return {
        id: r.id,
        code: r.code,
        name: r.name,
        address: r.address,
        stage,
        status: r.status,
        systemSizeKw: r.system_size_kw === null ? null : Number(r.system_size_kw),
        daysInStage: Math.max(0, Math.floor((now - new Date(r.stage_since).getTime()) / 86_400_000)),
        missing: bundle && r.status !== 'complete' ? evaluateStage(stage, bundle) : [],
        clientName: r.client_name,
        dealerName: r.dealer_name,
        jurisdictionName: r.jurisdiction_name,
        pmName: r.pm_name,
        createdAt: r.created_at,
      };
    });
  });
}

export type MoveResult =
  | { ok: true; stage: StageKey | 'completed' }
  | { ok: false; code: 'not_found' | 'forbidden' | 'invalid'; message: string; missing?: string[] };

/**
 * THE move service — both the advance button and the board drag call this.
 * Forward: one stage, gated by evaluateStage; the last stage completes the
 * project. Backward: admin only, one stage, mandatory reason, logged.
 */
export async function moveProject(
  session: SessionIdentity,
  projectId: string,
  direction: 'forward' | 'back',
  options: { via: 'button' | 'drag'; reason?: string }
): Promise<MoveResult> {
  if (!['admin', 'ops'].includes(session.role)) {
    return { ok: false, code: 'forbidden', message: 'Only the PM or an admin moves projects.' };
  }
  if (direction === 'back') {
    if (session.role !== 'admin') {
      return { ok: false, code: 'forbidden', message: 'Only an admin can move a project backwards.' };
    }
    if (!options.reason || options.reason.trim().length < 5) {
      return { ok: false, code: 'invalid', message: 'A reason is required to move a project backwards.' };
    }
  }

  return withUser(session, async (client) => {
    const { rows } = await client.query(
      `select id, stage, status from public.projects where id = $1`,
      [projectId]
    );
    const project = rows[0];
    if (!project) return { ok: false as const, code: 'not_found' as const, message: 'Project not found.' };
    if (project.status === 'complete') {
      return { ok: false as const, code: 'invalid' as const, message: 'Project is already completed.' };
    }
    const stage = project.stage as StageKey;
    if (!isStageKey(stage)) {
      return { ok: false as const, code: 'invalid' as const, message: `Unknown stage ${stage}` };
    }

    if (direction === 'back') {
      const target = prevStage(stage);
      if (!target) {
        return { ok: false as const, code: 'invalid' as const, message: 'Already at the first stage.' };
      }
      await client.query(`update public.projects set stage = $2 where id = $1`, [projectId, target]);
      return { ok: true as const, stage: target };
    }

    const bundles = await loadBundles(client, [projectId]);
    const bundle = bundles.get(projectId);
    const missing = bundle ? evaluateStage(stage, bundle) : ['Project data unavailable'];
    if (missing.length > 0) {
      return {
        ok: false as const,
        code: 'invalid' as const,
        message: 'Required items are missing for this stage.',
        missing,
      };
    }

    const target = nextStage(stage);
    if (target) {
      await client.query(`update public.projects set stage = $2 where id = $1`, [projectId, target]);
      return { ok: true as const, stage: target };
    }
    await client.query(`update public.projects set status = 'complete' where id = $1`, [projectId]);
    return { ok: true as const, stage: 'completed' as const };
  }).then(async (result) => {
    if (result.ok) {
      await logAuditEvent(session, {
        action:
          direction === 'back'
            ? 'stage.moved_back'
            : result.stage === 'completed'
              ? 'project.completed'
              : 'stage.advanced',
        entityType: 'projects',
        entityId: projectId,
        projectId,
        context: {
          via: options.via,
          to: result.stage,
          ...(options.reason ? { reason: options.reason } : {}),
        },
      }).catch(() => undefined);
    }
    return result;
  });
}
