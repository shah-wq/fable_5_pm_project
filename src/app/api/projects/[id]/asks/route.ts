import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';
import { notifyActionNeeded } from '@/lib/push/events';

/**
 * The PM asking the customer for something — a utility bill, a meter photo, a
 * shot of where the crew can park. One row, and both surfaces render it: the
 * portal's 'Anything needed from you' card and the app's Photos tab prompt.
 *
 * Creating an ask is the only thing that sends an 'action needed' push, which
 * is what keeps that category honest: it fires when a person actually asked
 * for something, never on a status change.
 */
const KINDS = ['photo', 'document', 'information'];

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    kind?: string;
    label?: string;
    detail?: string;
  } | null;

  const label = body?.label?.trim().slice(0, 200);
  if (!label) {
    return NextResponse.json(
      { error: 'Say what you need, in words the customer will understand.' },
      { status: 400 }
    );
  }
  const kind = KINDS.includes(String(body?.kind)) ? String(body!.kind) : 'photo';

  try {
    const askId = await withUser(session, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into public.customer_asks (project_id, kind, label, detail, requested_by)
         values ($1, $2, $3, $4, $5)
         returning id`,
        [id, kind, label, body?.detail?.trim().slice(0, 1000) || null, session.userId]
      );
      const created = rows[0]?.id ?? null;
      if (created) await notifyActionNeeded(client, id, created, label);
      return created;
    });

    if (!askId) return NextResponse.json({ error: 'project not found' }, { status: 404 });
    await tryLogAuditEvent(session, {
      action: 'customer.ask_created',
      entityType: 'customer_asks',
      entityId: askId,
      projectId: id,
      context: { label },
    });
    return NextResponse.json({ id: askId }, { status: 201 });
  } catch (e) {
    return dbErrorResponse(e, 'Asking the customer for something');
  }
}

/** Withdraw an ask the customer no longer needs to act on. */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as { askId?: string } | null;
  if (!body?.askId) return NextResponse.json({ error: 'askId required' }, { status: 400 });

  try {
    await withUser(session, (client) =>
      client.query(
        `update public.customer_asks set cancelled_at = now()
         where id = $1 and project_id = $2 and fulfilled_at is null`,
        [body.askId, id]
      )
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return dbErrorResponse(e, 'Withdrawing the request');
  }
}
