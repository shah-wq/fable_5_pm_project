import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';
import { flushQuietHoursQueue, sendChatDigest } from '@/lib/chat/notify';
import { sendFeedbackDigest, sendFeedbackEmails } from '@/lib/feedback/notify';
import { optionalRows } from '@/lib/db-optional';
import { sendAppointmentReminders } from '@/lib/push/events';

/**
 * Everything time-based, in one scheduled request. Two ways in:
 *
 *  * an admin pressing the button on Admin → Settings, and
 *  * a scheduled call carrying CRON_SECRET, for a Vercel cron entry.
 *
 * It does three jobs:
 *
 *  1. the 48 h and 24 h install reminders (mobile spec §4);
 *  2. flushing chat notifications held for quiet hours (chat spec §4) — a
 *     message sent at 10pm reaches the customer at 8am rather than waking them
 *     or being dropped;
 *  3. the twice-daily digest of unanswered customer messages, when the hour
 *     matches one the admin configured.
 *
 * All three are safe to run repeatedly: reminders are deduped on date and
 * window, queued notifications are claimed in the database before sending, and
 * the digest only goes out in its configured hour.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authorised =
    secret !== undefined &&
    (request.headers.get('authorization') === `Bearer ${secret}` ||
      new URL(request.url).searchParams.get('key') === secret);

  const session = await getSession();
  if (!authorised && (!session || session.role !== 'admin' || !session.isActive)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // A cron call has no session, so it runs as the platform's own service
  // identity — same RLS role the app uses, no wider.
  const identity = session ?? {
    userId: '00000000-0000-0000-0000-000000000000',
    role: 'admin' as const,
    email: 'cron@localhost',
  };

  // 'digest' forces the digest regardless of the hour, for the admin button and
  // for testing; a cron call sends it only in a configured hour.
  const force = new URL(request.url).searchParams.get('digest') === '1';

  try {
    const result = await withUser(identity, async (client) => {
      const reminders = await sendAppointmentReminders(client);
      const queued = await flushQuietHoursQueue(client).catch(() => ({ sent: 0 }));

      // Which hours the digest goes out, in the company's own timezone — because
      // 'twice a day' means twice during the working day, not twice in UTC.
      const hours = await optionalRows<{ hour: number; wanted: string | null }>(
        client,
        'the chat digest schedule',
        `select extract(hour from (now() at time zone
                  coalesce(nullif(btrim(company_timezone), ''), 'America/Chicago')))::int as hour,
                chat_digest_hours as wanted
         from public.app_settings where id`
      );
      const wanted = (hours[0]?.wanted ?? '9,15')
        .split(',')
        .map((h) => Number(h.trim()))
        .filter((h) => Number.isInteger(h));
      const due = force || (hours[0] !== undefined && wanted.includes(hours[0].hour));
      const digest = due ? await sendChatDigest(client).catch(() => ({ sent: 0 })) : { sent: 0 };

      // Stage feedback §2: the 24-hour email fallback, which is where most
      // answers actually come from. Claimed in the database, so two overlapping
      // cron runs cannot ask the same person twice.
      const ratings = await sendFeedbackEmails(client).catch(() => ({ sent: 0 }));
      // §5's daily digest to admins, on the same schedule as the chat one.
      const ratingDigest = due
        ? await sendFeedbackDigest(client).catch(() => ({ sent: 0 }))
        : { sent: 0 };
      // §8: verbatim comments are anonymised after two years; the scores stay.
      const swept = await optionalRows<{ n: number }>(
        client,
        'the two-year comment sweep',
        `select public.sweep_feedback_comments() as n`
      ).catch(() => []);

      return {
        ...reminders,
        chatQueueSent: queued.sent,
        digestsSent: digest.sent,
        digestDue: due,
        ratingEmailsSent: ratings.sent,
        ratingDigestsSent: ratingDigest.sent,
        commentsAnonymised: Number(swept[0]?.n ?? 0),
      };
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return dbErrorResponse(e, 'Running the scheduled jobs');
  }
}
