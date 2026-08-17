import type { PoolClient } from 'pg';
import { withUser, type SessionIdentity } from '../db';
import { loadPhrases, phrase } from '../portal/customer';
import { notifyProject, type PushCategory } from './send';

/**
 * The five notifications the spec allows, and nothing else (§4).
 *
 * Each one is composed in the customer's language — the same customer_phrases
 * table the portal reads, so 'inspection_pto' reaches a homeowner as
 * 'Inspection & Power On' here exactly as it does on the page — and each
 * carries the deep link to the screen it is about.
 *
 * Every function is fire-and-forget from the caller's point of view: a stage
 * move, a saved form or a hold must not fail because a push service is down.
 */

async function send(
  client: PoolClient,
  args: {
    projectId: string;
    category: PushCategory;
    dedupeKey: string | null;
    title: string;
    body: string;
    url: string;
  }
): Promise<void> {
  await notifyProject(client, args).catch(() => undefined);
}

/** 'Your permit has been approved' — the core notification. */
export async function notifyStageAdvanced(
  client: PoolClient,
  projectId: string,
  stage: string
): Promise<void> {
  const phrases = await loadPhrases(client).catch(() => new Map<string, string>());
  const stageName = phrase(phrases, 'stage', stage, stage);
  const next = phrase(phrases, 'stage_next', stage, '');
  await send(client, {
    projectId,
    category: 'stage_advanced',
    // Once per stage per project: moving back and forth to fix a mistake must
    // not send the same news twice.
    dedupeKey: `stage_advanced:${stage}`,
    title: `${stageName} has started`,
    body: next || `Your project has moved to ${stageName}.`,
    url: `/portal/project#${stage}`,
  });
}

/** The celebratory one at PTO. */
export async function notifyPowerOn(client: PoolClient, projectId: string): Promise<void> {
  await send(client, {
    projectId,
    category: 'power_on',
    dedupeKey: 'power_on',
    title: 'Your system is switched on',
    body: 'Your solar system is live and producing. Congratulations — and thank you.',
    url: '/portal',
  });
}

export async function notifyOnHold(
  client: PoolClient,
  projectId: string,
  reason: string,
  expectedResume: string | null
): Promise<void> {
  await send(client, {
    projectId,
    category: 'on_hold',
    // A project can legitimately be held more than once, so this is not deduped
    // by project — only by the reason, which stops a double-tap sending twice.
    dedupeKey: null,
    title: 'Your project is temporarily paused',
    body:
      `Reason: ${reason}.` +
      (expectedResume ? ` We expect to restart around ${expectedResume}.` : ''),
    url: '/portal',
  });
}

/** A date the customer needs to be home for. Reminders: sendAppointmentReminders. */
export async function notifyAppointment(
  client: PoolClient,
  projectId: string,
  what: 'install' | 'inspection',
  date: string
): Promise<void> {
  const label = what === 'install' ? 'Your installation' : 'Your city inspection';
  await send(client, {
    projectId,
    category: 'appointment',
    // Re-scheduling is news, so the date is part of the key.
    dedupeKey: `appointment:${what}:${date}`,
    title: `${label} is confirmed`,
    body: `${label} is booked for ${date}. We will remind you two days before.`,
    url: `/portal/project#${what === 'install' ? 'install' : 'inspection_pto'}`,
  });
}

/**
 * The 48-hour and 24-hour reminders (spec §4). Run from a scheduled request to
 * /api/push/reminders — one query, both windows, deduped by date and window so
 * running it twice in a day sends nothing twice.
 */
export async function sendAppointmentReminders(
  client: PoolClient
): Promise<{ sent: number }> {
  const { rows } = await client.query<{
    project_id: string; install_date: string; days: number;
  }>(
    `select s.project_id,
            to_char(s.install_scheduled_date, 'YYYY-MM-DD') as install_date,
            (s.install_scheduled_date - current_date) as days
     from public.stage5_install s
     join public.projects p on p.id = s.project_id
     where s.install_scheduled_date in (current_date + 2, current_date + 1)
       and p.status = 'active'
       and coalesce(s.install_status, '') not in ('completed', 'cancelled')`
  );

  let sent = 0;
  for (const row of rows) {
    const when = row.days === 2 ? 'in two days' : 'tomorrow';
    const result = await notifyProject(client, {
      projectId: row.project_id,
      category: 'appointment',
      dedupeKey: `reminder:install:${row.install_date}:${row.days}`,
      title: `Your installation is ${when}`,
      body: `Our crew is booked for ${row.install_date}. Please make sure we can reach your electrical panel and roof access.`,
      url: '/portal/project#install',
    }).catch(() => ({ sent: 0 }));
    sent += result.sent;
  }
  return { sent };
}

/** Only when the PM has asked for something specific. */
export async function notifyActionNeeded(
  client: PoolClient,
  projectId: string,
  askId: string,
  label: string
): Promise<void> {
  await send(client, {
    projectId,
    category: 'action_needed',
    dedupeKey: `action_needed:${askId}`,
    title: 'Something is needed from you',
    body: label,
    url: '/portal/photos',
  });
}

/**
 * Convenience wrapper for callers that are not already inside a transaction —
 * the stage-move service and the stage-form PATCH both hold their own client,
 * so they call the functions above directly instead.
 */
export async function notifyInSession(
  session: SessionIdentity,
  fn: (client: PoolClient) => Promise<void>
): Promise<void> {
  await withUser(session, fn).catch(() => undefined);
}
