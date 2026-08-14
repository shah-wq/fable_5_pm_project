import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';

/**
 * Share a document with the customer, or stop sharing it. Documents default to
 * hidden when uploaded (spec §5: defaulting to visible would eventually
 * publish an internal file by accident) — this is the PM ticking what to share.
 */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as { customerVisible?: boolean } | null;
  if (typeof body?.customerVisible !== 'boolean') {
    return NextResponse.json({ error: 'customerVisible must be true or false' }, { status: 400 });
  }

  try {
    const row = await withUser(session, async (client) => {
      const { rows } = await client.query<{ project_id: string }>(
        `update public.documents set customer_visible = $2 where id = $1
         returning project_id`,
        [id, body.customerVisible]
      );
      return rows[0] ?? null;
    });
    if (!row) return NextResponse.json({ error: 'document not found' }, { status: 404 });

    await tryLogAuditEvent(session, {
      action: body.customerVisible ? 'document.shared_with_customer' : 'document.unshared',
      entityType: 'documents',
      entityId: id,
      projectId: row.project_id,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return dbErrorResponse(e, 'Updating the document');
  }
}
