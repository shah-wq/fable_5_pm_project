import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';

/**
 * The PM answers or closes a customer request. The reply is shown to the
 * customer on their portal, so the thread stays on the project record rather
 * than in someone's inbox.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; requestId: string }> }
) {
  const { id, requestId } = await ctx.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    reply?: string | null;
    resolve?: boolean;
  } | null;
  const reply = body?.reply?.trim().slice(0, 2000) || null;
  if (!reply && body?.resolve !== true) {
    return NextResponse.json({ error: 'write a reply or mark it resolved' }, { status: 400 });
  }

  try {
    const updated = await withUser(session, async (client) => {
      const { rowCount } = await client.query(
        `update public.customer_requests
         set pm_reply = coalesce($3, pm_reply),
             status = case when $4 then 'resolved' else status end,
             resolved_by = case when $4 then $5 else resolved_by end,
             resolved_at = case when $4 then now() else resolved_at end
         where id = $1 and project_id = $2`,
        [requestId, id, reply, body?.resolve === true, session.userId]
      );
      return (rowCount ?? 0) > 0;
    });
    if (!updated) return NextResponse.json({ error: 'request not found' }, { status: 404 });

    await tryLogAuditEvent(session, {
      action: body?.resolve ? 'customer_request.resolved' : 'customer_request.replied',
      entityType: 'customer_requests',
      entityId: requestId,
      projectId: id,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return dbErrorResponse(e, 'Updating the request');
  }
}
