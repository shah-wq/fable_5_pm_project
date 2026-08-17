import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';
import { sendAppointmentReminders } from '@/lib/push/events';

/**
 * The 48 h and 24 h install reminders (spec §4). Two ways in:
 *
 *  * an admin pressing the button on Admin → Settings, and
 *  * a scheduled call carrying CRON_SECRET, for a Vercel cron entry.
 *
 * Both are safe to run repeatedly: every reminder is deduped on the date and
 * the window, so a cron that fires hourly still sends each customer one.
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

  try {
    const result = await withUser(identity, (client) => sendAppointmentReminders(client));
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return dbErrorResponse(e, 'Sending appointment reminders');
  }
}
