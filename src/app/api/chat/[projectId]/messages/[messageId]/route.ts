import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { editMessage } from '@/lib/chat/service';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Editing one's own message inside the five-minute window (§3). There is no
 * DELETE here, and there is no delete policy on the table either: "this is a
 * business record, not a chat app."
 *
 * Every rule — staff only, own message only, five minutes, the 'edited' marker —
 * is enforced by edit_project_message() in the database, so a second client
 * cannot talk its way around them.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ projectId: string; messageId: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { messageId } = await params;
  if (!UUID_RE.test(messageId)) {
    return NextResponse.json({ error: 'bad message id' }, { status: 400 });
  }

  const payload = (await request.json().catch(() => null)) as { body?: string } | null;
  const body = payload?.body?.trim() ?? '';
  if (!body) return NextResponse.json({ error: 'a message cannot be empty' }, { status: 400 });
  if (body.length > 8000) {
    return NextResponse.json({ error: 'that message is too long' }, { status: 400 });
  }

  try {
    const ok = await withUser(session, (client) => editMessage(client, messageId, body));
    if (!ok) return NextResponse.json({ error: 'message not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return dbErrorResponse(e, 'Saving the edit');
  }
}
