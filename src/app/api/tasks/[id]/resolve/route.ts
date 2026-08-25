import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { requireRole } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { dbErrorResponse } from '@/lib/db-error';

/**
 * Close a follow-up with the note §5 requires.
 *
 * The note is checked in the database too — this route is convenience, not the
 * rule. A task closed with an empty note would be a task that was never closed,
 * just hidden.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await requireRole(['admin', 'ops'], '/tasks');

  const body = (await request.json().catch(() => null)) as { note?: string } | null;
  const note = (body?.note ?? '').trim();
  if (note.length < 3) {
    return NextResponse.json(
      { error: 'Say what you did — a line is enough, and it is what makes this worth reading later.' },
      { status: 400 }
    );
  }

  try {
    await withUser(session, (client) =>
      client.query(`select public.resolve_project_task($1, $2)`, [id, note])
    );
    await tryLogAuditEvent(session, {
      action: 'task.resolved',
      entityType: 'project_tasks',
      entityId: id,
      context: { note },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return dbErrorResponse(error, 'Closing the follow-up');
  }
}
