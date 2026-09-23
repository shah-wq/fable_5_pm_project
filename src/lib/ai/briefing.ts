import type { PoolClient } from 'pg';
import { ask } from '../assistant/run';
import type { SessionIdentity } from '../db';
import { optionalRows } from '../db-optional';
import type { AiSettings } from './settings';

/**
 * The morning briefing: Ask SolarFlow's PM report, written for one project
 * manager at the hour the admin chose, and delivered as the daily_briefing
 * notification (in the feed and by email, per Admin → Notifications).
 *
 * The assistant runs under the PM's own identity, so the briefing can only
 * contain what that person could have looked up themselves.
 */

export const BRIEFING_PROMPT =
  'Write my morning briefing. Use the PM report for my own projects only. Lead with the two or three things most worth doing today, then: projects ageing past threshold and why they are stuck, anything blocked on the customer, unread customer messages, and what is scheduled in the next seven days. Be concrete — name projects by code and customer. Keep it under 250 words. Plain text with short lines, no headings, no tables.';

/** The hour it is now in the company's timezone. */
export function localHour(timezone: string, now = new Date()): number {
  try {
    const s = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: timezone,
    }).format(now);
    return Number(s) % 24;
  } catch {
    return now.getUTCHours();
  }
}

/** Today's date in the company's timezone, YYYY-MM-DD. */
export function localDate(timezone: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Queue a briefing for every project manager with work, when the hour is
 * right. Each (person, date) is queued once however often the job runs.
 */
export async function enqueueBriefings(client: PoolClient, settings: AiSettings): Promise<number> {
  if (!settings.briefings) return 0;
  if (localHour(settings.timezone) !== settings.briefingHour) return 0;
  const date = localDate(settings.timezone);
  const pms = await client.query<{ id: string }>(
    `select pr.id from public.profiles pr
      where pr.role in ('admin', 'ops') and pr.is_active and pr.deleted_at is null
        and (pr.role = 'admin' or exists (select 1 from public.projects p
                                            where p.assigned_pm = pr.id and p.status in ('active', 'on_hold')))`
  );
  let queued = 0;
  for (const pm of pms.rows) {
    const rows = await optionalRows<{ id: string | null }>(
      client,
      'queueing a briefing',
      `select public.enqueue_ai_job('briefing', null, $1, $2::jsonb) as id`,
      [`${pm.id}:${date}`, JSON.stringify({ user_id: pm.id, date })]
    );
    if (rows[0]?.id) queued += 1;
  }
  return queued;
}

/** Write one person's briefing and raise their notification. */
export async function writeBriefing(
  client: PoolClient,
  payload: { user_id?: unknown; date?: unknown }
): Promise<{ words: number; skipped?: string }> {
  const userId = typeof payload.user_id === 'string' ? payload.user_id : null;
  const date =
    typeof payload.date === 'string' ? payload.date : new Date().toISOString().slice(0, 10);
  if (!userId) return { words: 0, skipped: 'no recipient' };
  const { rows } = await client.query<{
    email: string | null;
    role: string;
    full_name: string | null;
  }>(
    `select email, role::text as role, full_name from public.profiles
      where id = $1 and is_active and deleted_at is null and role in ('admin', 'ops')`,
    [userId]
  );
  const pm = rows[0];
  if (!pm) return { words: 0, skipped: 'not an active project manager' };

  const identity: SessionIdentity & { name?: string | null } = {
    userId,
    email: pm.email,
    role: pm.role as SessionIdentity['role'],
    name: pm.full_name,
  };
  const { answer } = await ask(
    identity,
    [{ role: 'user', content: BRIEFING_PROMPT }],
    () => undefined
  );
  const summary = answer.trim().slice(0, 6000);
  await client.query(
    `select public.raise_notification('daily_briefing', $1, null, $2::jsonb, $3)`,
    [
      userId,
      JSON.stringify({
        date,
        summary,
        headline:
          summary
            .split('\n')
            .find((l) => l.trim())
            ?.slice(0, 200) ?? '',
      }),
      `briefing:${date}`,
    ]
  );
  return { words: summary.split(/\s+/).filter(Boolean).length };
}
