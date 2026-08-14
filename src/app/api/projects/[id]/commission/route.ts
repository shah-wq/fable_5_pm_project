import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';

/**
 * Admin sets the project's commission — base, adjustment, status flow
 * (pending → payable → paid) and its dates. Nothing here is automatic, and
 * the audit_row trigger records every change (a revised amount is never a
 * surprise: the history is queryable).
 */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (session.role !== 'admin' || !session.isActive) {
    return NextResponse.json({ error: 'only an admin sets commissions' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    baseAmount?: number;
    adjustment?: number;
    status?: string;
    payableDate?: string | null;
    paidDate?: string | null;
    notes?: string | null;
  } | null;

  const base = Number(body?.baseAmount ?? 0);
  const adjustment = Number(body?.adjustment ?? 0);
  const status = body?.status ?? 'pending';
  if (!Number.isFinite(base) || !Number.isFinite(adjustment)) {
    return NextResponse.json({ error: 'invalid amounts' }, { status: 400 });
  }
  if (!['pending', 'payable', 'paid'].includes(status)) {
    return NextResponse.json({ error: 'status must be pending, payable, or paid' }, { status: 400 });
  }
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const payable = body?.payableDate && DATE_RE.test(body.payableDate) ? body.payableDate : null;
  const paid = body?.paidDate && DATE_RE.test(body.paidDate) ? body.paidDate : null;
  if (status === 'paid' && !paid) {
    return NextResponse.json({ error: 'a paid commission needs its payment date' }, { status: 400 });
  }

  const saved = await withUser(session, async (client) => {
    const project = await client.query(`select id from public.projects where id = $1`, [id]);
    if (!project.rows[0]) return false;
    await client.query(
      `insert into public.commissions
         (project_id, base_amount, adjustment, status, payable_date, paid_date, notes)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (project_id) do update set
         base_amount = excluded.base_amount, adjustment = excluded.adjustment,
         status = excluded.status, payable_date = excluded.payable_date,
         paid_date = excluded.paid_date, notes = excluded.notes`,
      [id, base, adjustment, status, payable, paid, body?.notes?.trim() || null]
    );
    return true;
  });

  if (!saved) return NextResponse.json({ error: 'project not found' }, { status: 404 });

  await tryLogAuditEvent(session, {
    action: 'commission.updated',
    entityType: 'commissions',
    entityId: id,
    projectId: id,
    context: { base, adjustment, status },
  });
  return NextResponse.json({ ok: true });
}
