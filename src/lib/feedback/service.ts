import type { PoolClient } from 'pg';
import { optionalRows } from '../db-optional';
import { STAGE_LABELS, isStageKey, type StageKey } from '../stages/definitions';

/**
 * The stage-feedback data layer.
 *
 * Every read degrades to nothing when migration 003200 has not been pasted yet:
 * a rating request that cannot be loaded means no sheet, which is exactly the
 * right behaviour — the portal keeps working and nobody is asked anything.
 *
 * Every write goes through the database functions, which own all of §4's
 * guardrails. This file decides what to *show*, never who may answer.
 */

export interface PendingRequest {
  id: string;
  projectId: string;
  stage: StageKey;
  stageLabel: string;
  /** True once 'Not now' was tapped: the sheet becomes a quiet card (§2). */
  dismissed: boolean;
  /** The final stage also asks the recommendation question (§3). */
  askNps: boolean;
}

export interface ReasonChip {
  key: string;
  label: string;
}

/**
 * The one request this customer should be shown, if any.
 *
 * Not due yet (§1's evening deferral, §4's 48-hour gap), already answered, or
 * closed after two unanswered attempts — all of those produce nothing. Oldest
 * first, so a customer who has two waiting is asked about the earlier stage
 * first and the sheet never jumps around.
 */
export async function loadPendingRequest(
  client: PoolClient,
  projectId: string
): Promise<PendingRequest | null> {
  // No join to app_settings here, deliberately. That table is admin/ops only, so
  // joining it as the customer returns nothing at all — which is how the sheet
  // first came to never appear. Whether to ask the recommendation question is a
  // company setting, not a fact about this customer's project, and the safe
  // default when it cannot be read is to ask it at the final stage.
  const rows = await optionalRows<{
    id: string;
    project_id: string;
    stage: string;
    dismissed_at: string | null;
  }>(
    client,
    'the stage feedback request (public.stage_feedback)',
    `select f.id, f.project_id, f.stage::text as stage, f.dismissed_at
       from public.stage_feedback f
      where f.project_id = $1
        and f.responded_at is null
        and f.closed_at is null
        and f.send_after <= now()
      order by f.requested_at
      limit 1`,
    [projectId]
  );
  const row = rows[0];
  if (!row || !isStageKey(row.stage)) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    stage: row.stage,
    stageLabel: STAGE_LABELS[row.stage],
    dismissed: row.dismissed_at !== null,
    askNps: row.stage === 'complete',
  };
}

/**
 * The reason chips for one stage (§3): the configured list, filtered to the ones
 * that make sense here. "A survey has no pricing chip; an install has no permit
 * chip." An empty stage list on a chip means it applies everywhere.
 */
export async function loadReasonChips(
  client: PoolClient,
  stage: StageKey
): Promise<ReasonChip[]> {
  return optionalRows<ReasonChip>(
    client,
    'the feedback reason chips (public.feedback_reasons)',
    `select key, label
       from public.feedback_reasons
      where is_active
        and (cardinality(stages) = 0 or $1::public.project_stage = any(stages))
      order by sort_order, label`,
    [stage]
  );
}

/** Record the score. One statement, on tap, before any Send (§9). */
export async function recordScore(
  client: PoolClient,
  projectId: string,
  stage: StageKey,
  score: number,
  channel: 'portal' | 'app'
): Promise<boolean> {
  const rows = await optionalRows<{ id: string | null }>(
    client,
    'recording a rating (public.record_stage_feedback)',
    `select public.record_stage_feedback($1, $2::public.project_stage, $3, $4) as id`,
    [projectId, stage, score, channel]
  );
  return Boolean(rows[0]?.id);
}

/** Step two: the reasons and the optional comment. */
export async function recordDetail(
  client: PoolClient,
  projectId: string,
  stage: StageKey,
  tags: string[],
  comment: string | null
): Promise<boolean> {
  const rows = await optionalRows<{ id: string | null }>(
    client,
    'recording rating detail (public.detail_stage_feedback)',
    `select public.detail_stage_feedback($1, $2::public.project_stage, $3::text[], $4) as id`,
    [projectId, stage, tags, comment]
  );
  return Boolean(rows[0]?.id);
}

/** The recommendation question, final stage only (§3). */
export async function recordNps(
  client: PoolClient,
  projectId: string,
  stage: StageKey,
  nps: number
): Promise<boolean> {
  const rows = await optionalRows<{ id: string | null }>(
    client,
    'recording a recommendation score (public.record_stage_nps)',
    `select public.record_stage_nps($1, $2::public.project_stage, $3) as id`,
    [projectId, stage, nps]
  );
  return Boolean(rows[0]?.id);
}

/** 'Not now' (§2) — never blocking, and never a refusal to ask again. */
export async function dismiss(
  client: PoolClient,
  projectId: string,
  stage: StageKey
): Promise<void> {
  await optionalRows(
    client,
    'dismissing a rating request (public.dismiss_stage_feedback)',
    `select public.dismiss_stage_feedback($1, $2::public.project_stage)`,
    [projectId, stage]
  );
}

// ---------------------------------------------------------------------------
// Staff surfaces
// ---------------------------------------------------------------------------

export interface OpenTask {
  id: string;
  projectId: string;
  projectName: string;
  projectCode: string;
  title: string;
  suggested: string | null;
  detail: string | null;
  createdAt: string;
  ageDays: number;
  pmName: string | null;
  stage: StageKey | null;
  score: number | null;
}

/**
 * The PM's task list (§5). Oldest first: a low rating that has sat for a week is
 * the one that has stopped being a rating and started being a complaint.
 */
export async function loadOpenTasks(
  client: PoolClient,
  opts: { mine?: string | null; includeResolved?: boolean } = {}
): Promise<OpenTask[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (!opts.includeResolved) where.push('t.resolved_at is null');
  if (opts.mine) {
    params.push(opts.mine);
    where.push(`t.assigned_to = $${params.length}`);
  }
  const rows = await optionalRows<{
    id: string;
    project_id: string;
    project_name: string;
    project_code: string;
    title: string;
    suggested: string | null;
    detail: string | null;
    created_at: string;
    age_days: string;
    pm_name: string | null;
    stage: string | null;
    score: number | null;
  }>(
    client,
    'the follow-up task list (public.project_tasks)',
    `select t.id, t.project_id, p.name as project_name, p.code as project_code,
            t.title, t.suggested, t.detail, t.created_at,
            floor(extract(epoch from (now() - t.created_at)) / 86400.0) as age_days,
            coalesce(pr.full_name, pr.email) as pm_name,
            f.stage::text as stage, f.score
       from public.project_tasks t
       join public.projects p on p.id = t.project_id
       left join public.profiles pr on pr.id = t.assigned_to
       left join public.stage_feedback f on f.task_id = t.id
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by t.resolved_at is not null, t.created_at
      limit 200`,
    params
  );
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    projectName: r.project_name,
    projectCode: r.project_code,
    title: r.title,
    suggested: r.suggested,
    detail: r.detail,
    createdAt: String(r.created_at),
    ageDays: Number(r.age_days),
    pmName: r.pm_name,
    stage: r.stage && isStageKey(r.stage) ? r.stage : null,
    score: r.score === null ? null : Number(r.score),
  }));
}

/** Open follow-ups per project, for the badges on the pipeline and the list. */
export async function loadTaskCounts(
  client: PoolClient,
  projectIds: string[]
): Promise<Map<string, number>> {
  if (projectIds.length === 0) return new Map();
  const rows = await optionalRows<{ project_id: string; n: string }>(
    client,
    'open follow-up counts (public.project_tasks)',
    `select project_id, count(*) as n
       from public.project_tasks
      where resolved_at is null and project_id = any($1::uuid[])
      group by project_id`,
    [projectIds]
  );
  return new Map(rows.map((r) => [r.project_id, Number(r.n)]));
}

export interface ProjectCsat {
  responses: number;
  avgScore: number | null;
  worstScore: number | null;
  openLowScores: number;
}

/** The rolling rating for one project — the card, and the dealer's own view. */
export async function loadProjectCsat(
  client: PoolClient,
  projectIds: string[]
): Promise<Map<string, ProjectCsat>> {
  if (projectIds.length === 0) return new Map();
  const rows = await optionalRows<{
    project_id: string;
    responses: string;
    avg_score: string | null;
    worst_score: number | null;
    low_scores: string;
  }>(
    client,
    'the rolling rating (public.project_csat)',
    `select project_id, responses, avg_score, worst_score, low_scores
       from public.project_csat where project_id = any($1::uuid[])`,
    [projectIds]
  );
  return new Map(
    rows.map((r) => [
      r.project_id,
      {
        responses: Number(r.responses),
        avgScore: r.avg_score === null ? null : Number(r.avg_score),
        worstScore: r.worst_score === null ? null : Number(r.worst_score),
        openLowScores: Number(r.low_scores),
      },
    ])
  );
}
