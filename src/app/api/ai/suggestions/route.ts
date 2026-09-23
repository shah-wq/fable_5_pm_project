import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { dbErrorResponse } from '@/lib/db-error';
import { decideSuggestion, loadSuggestions } from '@/lib/ai/documents';
import { isStageKey } from '@/lib/stages/definitions';

const ROLES = ['admin', 'ops'];

/** Pending suggestions for a project (and optionally one stage). */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!ROLES.includes(session.role) || !session.isActive)
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const url = new URL(request.url);
  const projectId = url.searchParams.get('project') ?? undefined;
  const stage = url.searchParams.get('stage');
  try {
    const items = await withUser(session, (c) =>
      loadSuggestions(c, { projectId, stage: stage && isStageKey(stage) ? stage : undefined })
    );
    return NextResponse.json({ items });
  } catch (e) {
    return dbErrorResponse(e, 'Loading suggestions');
  }
}

/** Accept ({accept: true}: the value is written to the form) or reject one suggestion. */
export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!ROLES.includes(session.role) || !session.isActive)
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const body = (await request.json().catch(() => null)) as {
    id?: unknown;
    accept?: unknown;
  } | null;
  const id = typeof body?.id === 'string' || typeof body?.id === 'number' ? String(body.id) : null;
  if (!id || !/^\d+$/.test(id) || typeof body?.accept !== 'boolean') {
    return NextResponse.json({ error: 'id and accept are required' }, { status: 400 });
  }
  try {
    const result = await decideSuggestion(session, id, body.accept);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (e) {
    return dbErrorResponse(e, 'Deciding the suggestion');
  }
}
