import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';

/**
 * Registering and retiring one device. The row belongs to whoever is signed in
 * — RLS enforces that, so a customer cannot register a device against someone
 * else's account even if they forge the request body.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session || !session.isActive) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    endpoint?: string;
    p256dh?: string;
    auth?: string;
    platform?: string;
  } | null;

  const endpoint = body?.endpoint?.trim();
  const p256dh = body?.p256dh?.trim();
  const auth = body?.auth?.trim();
  if (!endpoint || !p256dh || !auth || !/^https:\/\//.test(endpoint)) {
    return NextResponse.json({ error: 'endpoint, p256dh and auth are required' }, { status: 400 });
  }
  const platform = ['web', 'ios', 'android'].includes(String(body?.platform))
    ? String(body!.platform)
    : 'web';

  try {
    await withUser(session, (client) =>
      client.query(
        // Re-subscribing the same device (a new browser session, a reinstall)
        // must update the row, not accumulate dead ones.
        `insert into public.push_subscriptions
           (user_id, endpoint, p256dh, auth, platform, user_agent)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (endpoint) do update set
           user_id = excluded.user_id,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           platform = excluded.platform,
           user_agent = excluded.user_agent,
           failure_count = 0,
           disabled_at = null,
           last_seen_at = now()`,
        [
          session.userId, endpoint, p256dh, auth, platform,
          request.headers.get('user-agent')?.slice(0, 300) ?? null,
        ]
      )
    );
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (e) {
    return dbErrorResponse(e, 'Registering this device for notifications');
  }
}

export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { endpoint?: string } | null;
  const endpoint = body?.endpoint?.trim();
  if (!endpoint) return NextResponse.json({ error: 'endpoint required' }, { status: 400 });

  try {
    // Only this device: turning notifications off on a phone must not silence
    // the customer's tablet.
    await withUser(session, (client) =>
      client.query(`delete from public.push_subscriptions where endpoint = $1`, [endpoint])
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return dbErrorResponse(e, 'Turning notifications off for this device');
  }
}
