import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { setFlag } from '@/lib/chat/service';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 'Mark as needs reply' (§5) — a PM flags a thread to come back to, and it stays
 * in the inbox's attention list until answered. Staff only; the customer never
 * sees that their thread has been flagged, which is why the table is staff-only
 * at the policy level too.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const { projectId } = await params;
  if (!UUID_RE.test(projectId)) {
    return NextResponse.json({ error: 'bad project id' }, { status: 400 });
  }

  const payload = (await request.json().catch(() => null)) as
    | { flagged?: boolean; note?: string }
    | null;
  const flagged = payload?.flagged !== false;
  const note = payload?.note?.trim().slice(0, 200) || null;

  try {
    await withUser(session, (client) => setFlag(client, projectId, flagged, session.userId, note));
    await tryLogAuditEvent(session, {
      action: flagged ? 'chat.flagged' : 'chat.unflagged',
      entityType: 'projects',
      entityId: projectId,
      projectId,
    });
    return NextResponse.json({ ok: true, flagged });
  } catch (e) {
    return dbErrorResponse(e, 'Flagging the conversation');
  }
}
