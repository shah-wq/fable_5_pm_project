import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { dbErrorResponse } from '@/lib/db-error';
import { loadFeed } from '@/lib/notify/feed';

/** The caller's feed. Every signed-in role has one; RLS keeps it theirs. */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session || !session.isActive) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const url = new URL(request.url);
  try {
    const feed = await withUser(session, (c) =>
      loadFeed(c, {
        limit: Number(url.searchParams.get('limit') ?? 30) || 30,
        unreadOnly: url.searchParams.get('unread') === '1',
      })
    );
    return NextResponse.json(feed);
  } catch (e) {
    return dbErrorResponse(e, 'Loading notifications');
  }
}

/** Mark read: {ids: [...]} for some, {all: true} for everything. */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session || !session.isActive) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { ids?: unknown; all?: unknown } | null;
  const ids = Array.isArray(body?.ids)
    ? body.ids.map((v) => String(v)).filter((v) => /^\d+$/.test(v))
    : null;
  if (!ids?.length && body?.all !== true) return NextResponse.json({ error: 'ids or all' }, { status: 400 });
  try {
    const { rows } = await withUser(session, (c) =>
      c.query<{ n: number }>('select public.mark_notifications_read($1::bigint[]) as n', [ids?.length ? ids : null])
    );
    return NextResponse.json({ marked: rows[0]?.n ?? 0 });
  } catch (e) {
    return dbErrorResponse(e, 'Marking notifications read');
  }
}
