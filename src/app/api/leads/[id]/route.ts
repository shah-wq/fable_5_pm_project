import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';

/**
 * PM review actions on a lead: mark under review, decline with a reason, or
 * convert — which creates the client + project (prefilled from the lead) and
 * links it back so the dealer sees 'Converted' with the new project.
 */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    action?: 'review' | 'convert' | 'decline';
    declinedReason?: string;
  } | null;
  if (!body?.action || !['review', 'convert', 'decline'].includes(body.action)) {
    return NextResponse.json({ error: 'action must be review, convert, or decline' }, { status: 400 });
  }
  if (body.action === 'decline' && (!body.declinedReason || body.declinedReason.trim().length < 3)) {
    return NextResponse.json({ error: 'a decline reason is required' }, { status: 400 });
  }

  const result = await withUser(session, async (client) => {
    const { rows } = await client.query(`select * from public.leads where id = $1`, [id]);
    const lead = rows[0];
    if (!lead) return { error: 'lead not found', status: 404 };
    if (['converted', 'declined'].includes(lead.status)) {
      return { error: `lead is already ${lead.status}`, status: 422 };
    }

    if (body.action === 'review') {
      await client.query(`update public.leads set status = 'under_review' where id = $1`, [id]);
      return { ok: true as const };
    }
    if (body.action === 'decline') {
      await client.query(
        `update public.leads set status = 'declined', declined_reason = $2 where id = $1`,
        [id, body.declinedReason!.trim()]
      );
      return { ok: true as const };
    }

    // Convert: client + project in one transaction, prefilled from the lead.
    const clientRow = await client.query<{ id: string }>(
      `insert into public.clients (dealer_id, first_name, last_name, email, phone)
       values ($1, $2, $3, $4, $5) returning id`,
      [lead.dealer_id, lead.customer_first, lead.customer_last, lead.customer_email, lead.customer_phone]
    );
    const rep = lead.sales_rep_name
      ? await client.query<{ id: string }>(
          `select id from public.sales_reps
           where lower(name) = lower($1) and is_active limit 1`,
          [lead.sales_rep_name]
        )
      : { rows: [] as { id: string }[] };
    const project = await client.query<{ id: string }>(
      `insert into public.projects
         (name, address, dealer_id, client_id, system_size_kw, sales_rep_id,
          cash_or_financing_id, assigned_pm, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       returning id`,
      [
        `${lead.customer_first} ${lead.customer_last}`,
        lead.address,
        lead.dealer_id,
        clientRow.rows[0].id,
        lead.estimated_size_kw,
        rep.rows[0]?.id ?? null,
        lead.cash_or_financing_id,
        session.userId,
      ]
    );
    await client.query(
      `update public.leads set status = 'converted', converted_project_id = $2 where id = $1`,
      [id, project.rows[0].id]
    );
    return { ok: true as const, projectId: project.rows[0].id };
  });

  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  await tryLogAuditEvent(session, {
    action: `lead.${body.action === 'review' ? 'under_review' : body.action === 'convert' ? 'converted' : 'declined'}`,
    entityType: 'leads',
    entityId: id,
    ...('projectId' in result && result.projectId ? { projectId: result.projectId } : {}),
    context: body.declinedReason ? { reason: body.declinedReason.trim() } : undefined,
  });

  return NextResponse.json(result);
}
