import type { PoolClient } from 'pg';
import { logAuditEvent } from '../audit';
import { withUser, type SessionIdentity } from '../db';
import { optionalRows } from '../db-optional';
import { notifyOnHold, notifyPowerOn, notifyStageAdvanced } from '../push/events';
import { isStageKey, nextStage, prevStage, STAGE_LABELS, type StageKey } from './definitions';
import { evaluateStage, type StageBundle } from './requirements';
import { loadSummaries, postSystemMessage } from '../chat/service';
import { loadTaskCounts } from '../feedback/service';

/**
 * Data loading + the shared move service. Everything runs through the
 * caller's session claims (withUser), so RLS scopes what each role can even
 * see; the advance button and Kanban drag both call moveProject() — one code
 * path, as the spec demands.
 */

/**
 * pg returns a timestamptz as a JS Date, so a field typed `string` that is
 * assigned one straight from a row is a lie the compiler cannot catch — and it
 * stays invisible until something calls a string method on it. That is exactly
 * how the Projects tab came to throw 'a.createdAt.localeCompare is not a
 * function' as soon as there were two rows to sort: with one row the comparator
 * never ran. Convert at the boundary, once.
 */
const asIso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value ?? '');

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
  /** Needed by the dashboard's per-PM filter; the name alone is ambiguous. */
  assignedPm: string | null;
  /**
   * Unread customer messages on this project's thread (Project Chat §1). On the
   * card and in the list, because "a PM should never have to open a project to
   * discover a customer wrote three days ago".
   */
  unreadMessages: number;
  chatFlagged: boolean;
  /**
   * Open follow-ups raised by a low rating (Stage feedback §5): "in the PM's
   * task list, as a red flag on the project card in the pipeline, in the
   * Projects tab, and in the Needs attention panel on the dashboard. A PM should
   * not have to go looking."
   */
  openFollowUps: number;
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
    // 'open' is not a project_status value — it is the dashboard's definition of
    // an active project ("everything not Complete or Cancelled", Dashboard spec
    // §3), so that clicking the Active projects card lands on exactly the rows
    // that were counted. Without it the card and the list would differ by
    // however many projects are on hold.
    if (filters.status === 'open') where.push(`p.status not in ('complete', 'cancelled')`);
    else if (filters.status) add('p.status = ?::public.project_status', filters.status);
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
              p.created_at, p.assigned_pm,
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
    // One query for every card's badge. Savepoint-guarded: the chat module's
    // view arrives with a later migration, and a missing badge must not take the
    // pipeline board down.
    const chat = await loadSummaries(client, rows.map((r) => r.id));
    // Same reasoning, same guard: the follow-up count arrives with 003200, and a
    // database without it shows no flags rather than no board.
    const followUps = await loadTaskCounts(client, rows.map((r) => r.id));

    const now = Date.now();
    return rows.map((r) => {
      const bundle = bundles.get(r.id);
      const stage = r.stage as StageKey;
      const column =
        r.status === 'on_hold'
          ? 'hold'
          : r.status === 'cancelled'
            ? 'cancelled'
            : r.status === 'complete'
              ? 'complete'
              : stage;
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
        assignedPm: r.assigned_pm,
        unreadMessages: chat.get(r.id)?.unread ?? 0,
        chatFlagged: chat.get(r.id)?.flagged ?? false,
        openFollowUps: followUps.get(r.id) ?? 0,
        createdAt: asIso(r.created_at),
      };
    });
  });
}

export type MoveDirection = 'forward' | 'back' | 'hold' | 'resume' | 'cancel' | 'reinstate';

export type MoveResult =
  | { ok: true; stage: StageKey; column?: string }
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
 * Ask for a rating on the stage that just completed (Stage feedback §1).
 *
 * Every rule about *whether* to ask lives in the database function: one request
 * per stage for ever, no request on a project that is on hold or cancelled, the
 * 48-hour gap, the evening deferral for installation day, the per-stage switch
 * and the customer's own opt-out. Keeping them there rather than here means the
 * next thing that completes a stage — a bulk update, an import, an automation —
 * cannot forget one of them.
 *
 * In the same transaction as the move, so a completed stage and its request
 * cannot come apart. Failure is swallowed on purpose: a rating request is worth
 * strictly less than the stage move it accompanies, and taking the move down
 * because the request failed would be the wrong trade.
 *
 * Note which moves do NOT reach here: hold, cancel, resume, reinstate and
 * backwards moves (§1 — "an admin correcting a stage backwards does not
 * re-trigger a rating that was already asked").
 */
async function requestFeedback(
  client: PoolClient,
  projectId: string,
  completedStage: StageKey
): Promise<void> {
  await optionalRows(
    client,
    'the stage feedback request (public.request_stage_feedback)',
    `select public.request_stage_feedback($1, $2::public.project_stage)`,
    [projectId, completedStage]
  ).catch(() => undefined);
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
    if ((direction === 'hold' || direction === 'cancel') && project.status === 'complete') {
      return { ok: false as const, code: 'invalid' as const,
        message: 'The project is completed — an admin must move it back out of Complete first.' };
    }
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
      // The customer hears it from us rather than noticing the silence. Their
      // own wording, the reason, no internal notes (spec §4).
      await notifyOnHold(client, projectId, options.reason!, options.expectedResumeDate || null);
      // And the thread carries the project's timeline inline (Chat §3). A system
      // line, so it reads as a record rather than as somebody talking — and it
      // never notifies, because the push above already did.
      await postSystemMessage(
        client,
        projectId,
        `Project paused — ${options.reason}` +
          (options.expectedResumeDate ? `, expected to resume ${options.expectedResumeDate}` : ''),
        false
      ).catch(() => undefined);
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
      // Written before the status change so the line reads in order with the
      // pause above it.
      await postSystemMessage(client, projectId, 'Project resumed', false).catch(() => undefined);
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
    if (project.status === 'on_hold' || project.status === 'cancelled') {
      return { ok: false as const, code: 'invalid' as const,
        message: 'Resume or reinstate the project before moving it through the pipeline.' };
    }

    if (direction === 'back') {
      const target = prevStage(stage);
      if (!target) {
        return { ok: false as const, code: 'invalid' as const, message: 'Already at the first stage.' };
      }
      // Backing out of Complete reopens the project (closed early by mistake).
      await client.query(
        `update public.projects set stage = $2, status = 'active' where id = $1`,
        [projectId, target]
      );
      return { ok: true as const, stage: target };
    }

    if (project.status === 'complete') {
      return { ok: false as const, code: 'invalid' as const, message: 'Project is already completed.' };
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
      await notifyPowerOn(client, projectId);
      await postSystemMessage(client, projectId, 'Project complete — your system is switched on')
        .catch(() => undefined);
      // Stage feedback §1: the request is for the stage that just *completed*,
      // which at the end of the pipeline is the project itself — the final stage
      // is also where the one recommendation question is asked (§3).
      await requestFeedback(client, projectId, 'complete');
      return { ok: true as const, stage: 'complete', column: 'complete' };
    }
    await notifyStageAdvanced(client, projectId, target);
    await postSystemMessage(
      client,
      projectId,
      `Moved to ${STAGE_LABELS[target]} — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    ).catch(() => undefined);
    // Stage feedback §1: "the moment the PM presses the advance button, a
    // feedback request is created for the stage just completed" — `stage`, not
    // `target`. Asking about the stage they are only now entering would be
    // asking about nothing.
    await requestFeedback(client, projectId, stage);
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
