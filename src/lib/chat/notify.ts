import type { PoolClient } from 'pg';
import { sendEmail } from '../email';
import { withUser, type SessionIdentity } from '../db';
import { optionalRows } from '../db-optional';
import { notifyProject } from '../push/send';
import { siteUrl } from '../site';

/**
 * Telling the other side a message arrived (spec §4).
 *
 * "Chat only works if both sides find out a message arrived — but neither party
 * is sitting in the app waiting." So:
 *
 *  - the customer gets a push if they have the app, and an email otherwise;
 *  - quiet hours are respected — nothing pushed between 9pm and 8am local, held
 *    for the morning instead of dropped;
 *  - the PM gets the unread badges that are already everywhere, plus an email
 *    only if they asked for one per message (most want the twice-daily digest,
 *    which the cron endpoint sends);
 *  - system messages never notify, and neither party is notified about their own
 *    message.
 *
 * Nothing in here is allowed to throw into the caller. The message is already
 * written by the time this runs; an SMTP host being down must not turn a
 * delivered message into an error the sender sees.
 */

export interface ChatNotification {
  projectId: string;
  messageId: string;
  body: string;
  internal: boolean;
  fromStaff: boolean;
}

/** One line of the message, for a push body or an email subject. */
function preview(body: string, max = 140): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export async function notifyNewChatMessage(
  session: SessionIdentity,
  message: ChatNotification
): Promise<void> {
  // §4: internal notes notify nobody. They are not part of the conversation the
  // customer is in, and the staff member who wrote one does not need telling.
  if (message.internal) return;

  await withUser(session, async (client) => {
    if (message.fromStaff) {
      await notifyCustomer(client, message).catch(() => undefined);
    } else {
      await notifyStaff(client, message).catch(() => undefined);
    }
  }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// The customer's side
// ---------------------------------------------------------------------------

async function notifyCustomer(client: PoolClient, message: ChatNotification): Promise<void> {
  const quiet = await optionalRows<{ until: string | null }>(
    client,
    'chat quiet hours (public.chat_quiet_until)',
    `select public.chat_quiet_until() as until`
  );
  const holdUntil = quiet[0]?.until ?? null;

  if (holdUntil) {
    // §4: queued to the morning. Held rather than dropped — a message sent at
    // 10pm is exactly the one somebody wants to see at 8am, and notifications
    // that silently vanish are how people learn to stop trusting an app.
    await optionalRows(
      client,
      'the chat notification queue',
      `select public.queue_chat_notification($1, $2::timestamptz)`,
      [message.messageId, holdUntil]
    );
    return;
  }

  await deliverToCustomer(client, message.projectId, message.body);
}

/**
 * Push if we can reach a device, email if we cannot. Shared with the cron
 * endpoint that flushes the quiet-hours queue.
 */
export async function deliverToCustomer(
  client: PoolClient,
  projectId: string,
  body: string
): Promise<{ pushed: number; emailed: boolean }> {
  const result = await notifyProject(client, {
    projectId,
    category: 'chat_message',
    // Every message is news, so there is nothing to dedupe against.
    dedupeKey: null,
    title: 'A message from your project manager',
    body: preview(body),
    url: '/portal/messages',
  }).catch(() => ({ sent: 0 }));

  const pushed = result.sent;
  // §4: "email otherwise". A customer with no device registered would otherwise
  // never learn a message arrived.
  if (pushed > 0) return { pushed, emailed: false };

  const rows = await optionalRows<{ email: string | null; first_name: string | null }>(
    client,
    "the customer's email for chat",
    `select cl.email, cl.first_name
     from public.projects p
     join public.clients cl on cl.id = p.client_id
     where p.id = $1 and cl.email is not null and not coalesce(cl.email_opt_out, false)`,
    [projectId]
  );
  const to = rows[0]?.email;
  if (!to) return { pushed, emailed: false };

  const link = `${siteUrl()}/portal/messages`;
  await sendEmail({
    to,
    subject: 'A message about your solar project',
    // §4: the email contains the message text and a deep link into the thread.
    text:
      `${rows[0]?.first_name ? `Hi ${rows[0].first_name},` : 'Hello,'}\n\n` +
      `Your project manager has sent you a message:\n\n` +
      `${body}\n\n` +
      `Reply here: ${link}\n\n` +
      // Inbound email is not parsed in this version (see the module notes), so
      // saying so plainly is what stops a reply being lost in a no-reply inbox.
      `Please reply using the link above rather than replying to this email — ` +
      `this mailbox is not monitored.\n`,
  }).catch(() => undefined);

  return { pushed, emailed: true };
}

// ---------------------------------------------------------------------------
// The PM's side
// ---------------------------------------------------------------------------

/**
 * §4: "Unread badges everywhere, plus an email digest. An immediate email per
 * message is optional per PM."
 *
 * The badges need nothing sent — they are a count the pages already read. So the
 * only thing to do here is the optional immediate email, for the PM who asked
 * for it.
 */
async function notifyStaff(client: PoolClient, message: ChatNotification): Promise<void> {
  const rows = await optionalRows<{
    email: string | null;
    full_name: string | null;
    project_name: string;
    customer_name: string | null;
  }>(
    client,
    'the assigned PM for a chat email',
    `select pr.email, pr.full_name, p.name as project_name,
            nullif(btrim(coalesce(cl.first_name, '') || ' ' || coalesce(cl.last_name, '')), '')
              as customer_name
     from public.projects p
     join public.profiles pr on pr.id = p.assigned_pm
     left join public.clients cl on cl.id = p.client_id
     where p.id = $1
       and pr.chat_email_each_message
       and pr.is_active and pr.deleted_at is null
       and pr.email is not null`,
    [message.projectId]
  );
  const pm = rows[0];
  if (!pm?.email) return;

  await sendEmail({
    to: pm.email,
    subject: `${pm.customer_name ?? 'A customer'} replied — ${pm.project_name}`,
    text:
      `${pm.customer_name ?? 'The customer'} wrote on ${pm.project_name}:\n\n` +
      `${message.body}\n\n` +
      `Reply: ${siteUrl()}/projects/${message.projectId}/chat\n`,
  }).catch(() => undefined);
}

/**
 * The twice-daily digest of unanswered customer messages (§4). Called by the
 * cron endpoint, which is also what flushes the quiet-hours queue — one
 * scheduled request, everything time-based in one place.
 */
export async function sendChatDigest(client: PoolClient): Promise<{ sent: number }> {
  const rows = await optionalRows<{
    email: string;
    full_name: string | null;
    threads: string;
  }>(
    client,
    'the chat digest',
    `select pr.email, pr.full_name,
            string_agg(
              format('· %s (%s) — waiting %s hours: %s',
                     p.name, p.code,
                     round(extract(epoch from (now() - s.last_customer_at)) / 3600.0)::text,
                     left(regexp_replace(coalesce(last.body, ''), '\\s+', ' ', 'g'), 120)),
              E'\\n' order by s.last_customer_at)
              as threads
     from public.project_chat_summary s
     join public.projects p on p.id = s.project_id
     join public.profiles pr on pr.id = p.assigned_pm
     left join lateral (
       select m.body from public.project_messages m
       where m.project_id = s.project_id and m.sender_role = 'customer'
       order by m.created_at desc limit 1
     ) last on true
     where s.last_customer_at is not null
       and (s.last_staff_at is null or s.last_staff_at < s.last_customer_at)
       and pr.is_active and pr.deleted_at is null and pr.email is not null
     group by pr.email, pr.full_name`
  );

  let sent = 0;
  for (const row of rows) {
    await sendEmail({
      to: row.email,
      subject: 'Customers waiting for a reply',
      text:
        `${row.full_name ? `${row.full_name},` : 'Hello,'}\n\n` +
        `These customers have written and not yet had a reply:\n\n` +
        `${row.threads}\n\n` +
        `Open the inbox: ${siteUrl()}/messages\n`,
    })
      .then(() => {
        sent += 1;
      })
      .catch(() => undefined);
  }
  return { sent };
}

/**
 * Send the notifications that were held for quiet hours. Claimed in the database
 * first, so two overlapping cron runs cannot double-send.
 */
export async function flushQuietHoursQueue(client: PoolClient): Promise<{ sent: number }> {
  const due = await optionalRows<{ q_project: string; q_body: string }>(
    client,
    'the quiet-hours queue',
    `select q_project, q_body from public.claim_due_chat_notifications(100)`
  );

  let sent = 0;
  for (const row of due) {
    const result = await deliverToCustomer(client, row.q_project, row.q_body).catch(() => null);
    if (result && (result.pushed > 0 || result.emailed)) sent += 1;
  }
  return { sent };
}
