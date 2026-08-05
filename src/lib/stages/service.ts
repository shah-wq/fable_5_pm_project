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
  /** Board column: 'hold' / 'cancelled' for side stages, else the stage. */
  column: string;
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

  const [projects, s1, s2, s3, s4, s5, s6, fin, docs] = await Promise.all([
    client.query(`select id, finance_partner_id from public.projects where id = any($1)`, ids),
    client.query(`select * from public.stage1_survey where project_id = any($1)`, ids),
    client.query(`select * from public.stage2_design where project_id = any($1)`, ids),
    client.query(`select * from public.stage3_permit where project_id = any($1)`, ids),
    client.query(`select * from public.stage4_procurement where project_id = any($1)`, ids),
    client.query(`select * from public.stage5_install where project_id = any($1)`, ids),
    client.query(`select * from public.stage6_inspection where project_id = any($1)`, ids),
    client.query(`select * from public.finance_milestones where project_id = any($1)`, ids),
    client.query(
      `select distinct project_id, category
       from public.documents where project_id = any($1) and category is not null`, ids),
  ]);

  const byProject = <T extends { project_id: string }>(rows: T[]) =>
    new Map(rows.map((r) => [r.project_id, r]));
  const m1 = byProject(s1.rows);
  const m2 = byProject(s2.rows);
  const m3 = byProject(s3.rows);
  const m4 = byProject(s4.rows);
  const m5 = byProject(s5.rows);
  const m6 = byProject(s6.rows);
  const mf = byProject(fin.rows);
  const docsBy = new Map<string, Set<string>>();
  for (const r of docs.rows) {
    const set = docsBy.get(r.project_id) ?? new Set<string>();
    set.add(r.category);
    docsBy.set(r.project_id, set);
  }

  for (const p of projects.rows) {
    bundles.set(p.id, {
      financePartnerId: p.finance_partner_id,
      survey: m1.get(p.id) ?? null,
      design: m2.get(p.id) ?? null,
      permits: m3.get(p.id) ?? null,
      procurement: m4.get(p.id) ?? null,
      install: m5.get(p.id) ?? null,
      inspection: m6.get(p.id) ?? null,
      finance: mf.get(p.id) ?? null,
      docCategories: docsBy.get(p.id) ?? new Set(),
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
      const column =
        r.status === 'on_hold' ? 'hold' : r.status === 'cancelled' ? 'cancelled' : stage;
      return {
        id: r.id,
        code: r.code,
        name: r.name,
        address: r.address,
        stage,
        status: r.status,
        column,
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

export type MoveDirection = 'forward' | 'back' | 'hold' | 'resume' | 'cancel' | 'reinstate';

export type MoveResult =
  | { ok: true; stage: StageKey | 'completed'; column?: string }
  | { ok: false; code: 'not_found' | 'forbidden' | 'invalid'; message: string; missing?: string[] };

export interface MoveOptions {
  via: 'button' | 'drag';
  reason?: string;
  /** Side-stage detail (hold / cancel). */
  notes?: string;
  expectedResumeDate?: string | null;
  refundRequired?: boolean;
  equipmentReturnRequired?: boolean;
}

/**
 * THE move service — the advance button, the board drag, and the header
 * Hold/Cancel/Resume buttons all call this. Forward/back run one stage,
 * gated by evaluateStage (forward) or requiring an admin + reason (back).
 * hold/cancel bypass validation entirely (a separate path, by design) and
 * only need their own reason fields; resume/reinstate restore the origin
 * stage with every field intact.
 */
export async function moveProject(
  session: SessionIdentity,
  projectId: string,
  direction: MoveDirection,
  options: MoveOptions
): Promise<MoveResult> {
  if (!['admin', 'ops'].includes(session.role)) {
    return { ok: false, code: 'forbidden', message: 'Only the PM or an admin moves projects.' };
  }
  if (direction === 'back' && session.role !== 'admin') {
    return { ok: false, code: 'forbidden', message: 'Only an admin can move a project backwards.' };
  }
  if ((direction === 'back' || direction === 'reinstate') &&
      (!options.reason || options.reason.trim().length < 5)) {
    return { ok: false, code: 'invalid', message: 'A reason is required for this move.' };
  }
  if ((direction === 'hold' || direction === 'cancel') &&
      (!options.reason || !options.notes || options.notes.trim().length < 3)) {
    return { ok: false, code: 'invalid', message: 'A reason and notes are required.' };
  }
  if (direction === 'reinstate' && session.role !== 'admin') {
    return { ok: false, code: 'forbidden', message: 'Only an admin can reinstate a cancelled project.' };
  }

  return withUser(session, async (client): Promise<MoveResult> => {
    const { rows } = await client.query(
      `select id, stage, status from public.projects where id = $1`,
      [projectId]
    );
    const project = rows[0];
    if (!project) return { ok: false as const, code: 'not_found' as const, message: 'Project not found.' };
    const stage = project.stage as StageKey;
    if (!isStageKey(stage)) {
      return { ok: false as const, code: 'invalid' as const, message: `Unknown stage ${stage}` };
    }

    // --- Side stages: never blocked by field validation ----------------------
    if (direction === 'hold') {
      if (project.status === 'on_hold') {
        return { ok: false as const, code: 'invalid' as const, message: 'Already on hold.' };
      }
      await client.query(
        `insert into public.project_holds
           (project_id, reason, notes, expected_resume_date, stage_held_from, created_by)
         values ($1, $2, $3, $4, $5, $6)`,
        [projectId, options.reason, options.notes, options.expectedResumeDate || null, stage, session.userId]
      );
      await client.query(`update public.projects set status = 'on_hold' where id = $1`, [projectId]);
      return { ok: true as const, stage, column: 'hold' };
    }
    if (direction === 'cancel') {
      await client.query(
        `insert into public.project_cancellation
           (project_id, reason, notes, stage_cancelled_from, refund_required,
            refund_status, equipment_return_required, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (project_id) do update set
           reason = excluded.reason, notes = excluded.notes,
           stage_cancelled_from = excluded.stage_cancelled_from,
           refund_required = excluded.refund_required,
           refund_status = excluded.refund_status,
           equipment_return_required = excluded.equipment_return_required,
           reinstated_at = null`,
        [projectId, options.reason, options.notes, stage, options.refundRequired ?? false,
         options.refundRequired ? 'pending' : 'not_required', options.equipmentReturnRequired ?? false,
         session.userId]
      );
      await client.query(`update public.projects set status = 'cancelled' where id = $1`, [projectId]);
      return { ok: true as const, stage, column: 'cancelled' };
    }
    if (direction === 'resume') {
      if (project.status !== 'on_hold') {
        return { ok: false as const, code: 'invalid' as const, message: 'Project is not on hold.' };
      }
      await client.query(
        `update public.project_holds set resume_date = current_date
         where project_id = $1 and resume_date is null`,
        [projectId]
      );
      await client.query(`update public.projects set status = 'active' where id = $1`, [projectId]);
      return { ok: true as const, stage };
    }
    if (direction === 'reinstate') {
      if (project.status !== 'cancelled') {
        return { ok: false as const, code: 'invalid' as const, message: 'Project is not cancelled.' };
      }
      await client.query(
        `update public.project_cancellation set reinstated_at = now() where project_id = $1`,
        [projectId]
      );
      await client.query(`update public.projects set status = 'active' where id = $1`, [projectId]);
      return { ok: true as const, stage };
    }

    // --- Normal flow ----------------------------------------------------------
    if (project.status === 'complete') {
      return { ok: false as const, code: 'invalid' as const, message: 'Project is already completed.' };
    }
    if (project.status === 'on_hold' || project.status === 'cancelled') {
      return { ok: false as const, code: 'invalid' as const,
        message: 'Resume or reinstate the project before moving it through the pipeline.' };
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
    if (!target) {
      return { ok: false as const, code: 'invalid' as const, message: 'Already at the final stage.' };
    }
    await client.query(`update public.projects set stage = $2 where id = $1`, [projectId, target]);
    // Entering Complete finishes the project and seeds its completion record.
    if (target === 'complete') {
      await client.query(`update public.projects set status = 'complete' where id = $1`, [projectId]);
      await client.query(
        `insert into public.stage7_complete (project_id, completion_date)
         values ($1, current_date) on conflict (project_id) do nothing`,
        [projectId]
      );
      return { ok: true as const, stage: 'complete', column: 'complete' };
    }
    return { ok: true as const, stage: target };
  }).then(async (result) => {
    if (result.ok) {
      const action =
        direction === 'back' ? 'stage.moved_back'
        : direction === 'hold' ? 'project.held'
        : direction === 'resume' ? 'project.resumed'
        : direction === 'cancel' ? 'project.cancelled'
        : direction === 'reinstate' ? 'project.reinstated'
        : result.stage === 'complete' ? 'project.completed'
        : 'stage.advanced';
      await logAuditEvent(session, {
        action,
        entityType: 'projects',
        entityId: projectId,
        projectId,
        context: {
          via: options.via,
          to: result.column ?? result.stage,
          ...(options.reason ? { reason: options.reason } : {}),
        },
      }).catch(() => undefined);
    }
    return result;
  });
}
