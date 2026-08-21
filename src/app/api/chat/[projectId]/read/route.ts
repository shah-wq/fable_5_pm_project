import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { markRead } from '@/lib/chat/service';
import { withUser } from '@/lib/db';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "I have read the other side's messages." Called on every thread open, so it
 * answers 200 even when it did nothing — a failed read receipt must never look
 * like a failure to the person reading.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { projectId } = await params;
  if (!UUID_RE.test(projectId)) {
    return NextResponse.json({ error: 'bad project id' }, { status: 400 });
  }
  const marked = await withUser(session, (client) => markRead(client, projectId)).catch(() => 0);
  return NextResponse.json({ marked });
}
