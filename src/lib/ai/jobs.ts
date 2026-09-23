import type { PoolClient } from 'pg';
import { withUser, type SessionIdentity } from '../db';
import { optionalRows } from '../db-optional';
import { autoAdvance } from './advance';
import { enqueueBriefings, writeBriefing } from './briefing';
import { readDocument } from './documents';
import { aiConfigured, describeFailure } from './model';
import { draftReply } from './replies';
import { loadAiSettings } from './settings';

/**
 * Running the automation (migration 004800).
 *
 * Two ways in, both under the platform's own admin identity:
 *
 *  * the scheduled job (/api/push/reminders) calls runAutomation() every ten
 *    minutes: queue the morning briefings when it is time, auto-advance what
 *    is complete, then work the queue for as long as its budget allows;
 *  * an upload or a homeowner message calls kick() right after the write, so
 *    the reader's suggestions are usually there by the time the PM looks.
 *
 * Jobs are claimed in the database, so two overlapping runs cannot read the
 * same document twice, and a job that fails on a transient error goes back on
 * the queue with a short delay.
 */

export const AUTOMATION_IDENTITY: SessionIdentity = {
  userId: '00000000-0000-0000-0000-000000000000',
  role: 'admin',
  email: 'automation@localhost',
};

interface Job {
  id: string;
  kind: 'read_document' | 'draft_reply' | 'briefing';
  project_id: string | null;
  entity_id: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface JobsResult {
  claimed: number;
  done: number;
  failed: number;
  skipped: number;
  retried: number;
}

async function finish(
  client: PoolClient,
  id: string,
  status: string,
  result: unknown,
  error: string | null
) {
  await client
    .query('select public.finish_ai_job($1, $2, $3::jsonb, $4)', [
      id,
      status,
      result === undefined ? null : JSON.stringify(result),
      error,
    ])
    .catch(() => undefined);
}

/** Work the queue until it is empty or the time budget is spent. */
export async function processJobs(
  identity: SessionIdentity,
  opts: { budgetMs?: number; batch?: number } = {}
): Promise<JobsResult> {
  const out: JobsResult = { claimed: 0, done: 0, failed: 0, skipped: 0, retried: 0 };
  if (!aiConfigured()) return out;
  const deadline = Date.now() + (opts.budgetMs ?? 40_000);

  while (Date.now() < deadline) {
    // Each job in its own transaction: one bad document cannot roll back another's suggestions.
    const jobs = await withUser(identity, (c) =>
      optionalRows<Job>(c, 'the automation queue', 'select * from public.claim_ai_jobs($1)', [
        opts.batch ?? 3,
      ])
    );
    if (jobs.length === 0) break;
    out.claimed += jobs.length;
    for (const job of jobs) {
      if (Date.now() > deadline) {
        // Give it back untouched for the next run.
        await withUser(identity, (c) => finish(c, job.id, 'queued', undefined, null));
        continue;
      }
      try {
        const result = await withUser(identity, async (c) => {
          const settings = await loadAiSettings(c);
          switch (job.kind) {
            case 'read_document':
              return settings.documentReading
                ? readDocument(c, identity, job.entity_id, settings)
                : { skipped: 'document reading is switched off' };
            case 'draft_reply':
              return settings.replyDrafts
                ? draftReply(c, identity, job.entity_id, settings)
                : { skipped: 'reply drafts are switched off' };
            case 'briefing':
              return settings.briefings
                ? writeBriefing(c, job.payload)
                : { skipped: 'briefings are switched off' };
            default:
              return { skipped: `unknown job ${String(job.kind)}` };
          }
        });
        const skipped = (result as { skipped?: string }).skipped;
        await withUser(identity, (c) =>
          finish(c, job.id, skipped ? 'skipped' : 'done', result, skipped ?? null)
        );
        if (skipped) out.skipped += 1;
        else out.done += 1;
      } catch (e) {
        const { message, retry } = describeFailure(e);
        console.error(
          `[ai] ${job.kind} ${job.entity_id} failed (attempt ${job.attempts}):`,
          message
        );
        const again = retry && job.attempts < 3;
        await withUser(identity, (c) =>
          finish(c, job.id, again ? 'queued' : 'failed', undefined, message)
        );
        if (again) out.retried += 1;
        else out.failed += 1;
      }
    }
  }
  return out;
}

/**
 * Everything the scheduled job does for the automation. Safe to run at any
 * time: briefings are queued once per person per day, auto-advance moves only
 * what its gate passes, and the queue is claimed.
 */
export async function runAutomation(
  client: PoolClient,
  identity: SessionIdentity,
  opts: { budgetMs?: number } = {}
): Promise<{
  briefingsQueued: number;
  autoAdvanced: number;
  jobs: JobsResult;
  configured: boolean;
}> {
  const settings = await loadAiSettings(client);
  if (!settings.ready) {
    return {
      briefingsQueued: 0,
      autoAdvanced: 0,
      jobs: { claimed: 0, done: 0, failed: 0, skipped: 0, retried: 0 },
      configured: aiConfigured(),
    };
  }
  const briefingsQueued = aiConfigured()
    ? await enqueueBriefings(client, settings).catch(() => 0)
    : 0;
  const advanced = await autoAdvance(client, identity, settings).catch((e) => {
    console.error('[ai] auto-advance failed:', e?.message ?? e);
    return { checked: 0, advanced: [] as string[] };
  });
  const jobs = await processJobs(identity, opts);
  return {
    briefingsQueued,
    autoAdvanced: advanced.advanced.length,
    jobs,
    configured: aiConfigured(),
  };
}

/**
 * Run the queue right now, in the background of a request that just queued
 * something. Errors are logged, never surfaced: the upload already succeeded.
 */
export function kick(): void {
  if (!aiConfigured()) return;
  processJobs(AUTOMATION_IDENTITY, { budgetMs: 25_000, batch: 2 }).catch((e) =>
    console.error('[ai] background run failed:', e?.message ?? e)
  );
}
