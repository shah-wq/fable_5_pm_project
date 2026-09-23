import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { dbErrorResponse } from '@/lib/db-error';
import { decideDraft, loadDrafts } from '@/lib/ai/replies';

const ROLES = ['admin', 'ops'];

/** Reply drafts waiting on a project (?project=), or everywhere this person may see. */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!ROLES.includes(session.role) || !session.isActive)
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const projectId = new URL(request.url).searchParams.get('project') ?? undefined;
  try {
    const items = await withUser(session, (c) => loadDrafts(c, projectId));
    return NextResponse.json({ items });
  } catch (e) {
    return dbErrorResponse(e, 'Loading reply drafts');
  }
}

/** {id, action: 'send', body?} sends it (edited or not) as this person; {id, action: 'dismiss'} drops it. */
export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!ROLES.includes(session.role) || !session.isActive)
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const body = (await request.json().catch(() => null)) as {
    id?: unknown;
    action?: unknown;
    body?: unknown;
  } | null;
  const id = typeof body?.id === 'string' || typeof body?.id === 'number' ? String(body.id) : null;
  const action = body?.action === 'send' || body?.action === 'dismiss' ? body.action : null;
  if (!id || !/^\d+$/.test(id) || !action)
    return NextResponse.json({ error: 'id and action are required' }, { status: 400 });
  try {
    const result = await decideDraft(
      session,
      id,
      action,
      typeof body?.body === 'string' ? body.body : undefined
    );
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (e) {
    return dbErrorResponse(e, 'Deciding the draft');
  }
}
