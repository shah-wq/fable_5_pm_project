import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';

/** Delete a saved report (owner or admin — RLS enforces the same rule). */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops', 'finance'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  try {
    const deleted = await withUser(session, async (client) => {
      const { rowCount } = await client.query(
        `delete from public.report_definitions where id = $1 and not is_template`,
        [id]
      );
      return (rowCount ?? 0) > 0;
    });
    if (!deleted) {
      return NextResponse.json(
        { error: 'Not deleted — a report can only be deleted by its owner, and templates cannot be deleted.' },
        { status: 403 }
      );
    }
    await tryLogAuditEvent(session, {
      action: 'report.deleted',
      entityType: 'report_definitions',
      entityId: id,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return dbErrorResponse(e, 'Deleting the report');
  }
}
