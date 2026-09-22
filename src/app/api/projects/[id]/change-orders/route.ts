import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { isUuid } from '@/lib/crm/coerce';
import { esignErrorResponse } from '@/lib/esign/errors';
import { listEnvelopes, loadSettings, readiness } from '@/lib/esign/service';

const ROLES = ['admin', 'ops'];

export interface ChangeOrderView {
  id: string;
  number: number;
  status: string;
  reason: string | null;
  description: string | null;
  amountDelta: number;
  requiresSignature: boolean;
  documentId: string | null;
  approvedAt: string | null;
  createdAt: string;
}

/** The project's change orders, each with its signature history. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!ROLES.includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  try {
    const out = await withUser(session, async (c) => {
      const { rows } = await c.query(
        `select co.*, p.contract_value,
                nullif(btrim(concat_ws(' ', cl.first_name, cl.last_name)), '') as client_name,
                cl.email as client_email
           from public.projects p
           left join public.change_orders co on co.project_id = p.id
           left join public.clients cl on cl.id = p.client_id
          where p.id = $1
          order by co.number desc nulls last`,
        [id]
      );
      if (rows.length === 0) return null;
      const orders: ChangeOrderView[] = rows
        .filter((r) => r.id)
        .map((r) => ({
          id: r.id,
          number: r.number,
          status: String(r.status),
          reason: r.reason,
          description: r.description,
          amountDelta: Number(r.amount_delta),
          requiresSignature: r.requires_customer_signature !== false,
          documentId: r.document_id,
          approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null,
          createdAt: new Date(r.created_at).toISOString(),
        }));
      let envelopes: Awaited<ReturnType<typeof listEnvelopes>> = [];
      let ready = {
        ready: false,
        reason: 'E-signature needs migration 004400 — Admin → Database → Apply.' as string | null,
      };
      try {
        await c.query('savepoint esign');
        envelopes = await listEnvelopes(c, { changeOrderIds: orders.map((o) => o.id) });
        ready = readiness(await loadSettings(c), 'change_order');
        await c.query('release savepoint esign');
      } catch (e) {
        await c.query('rollback to savepoint esign');
        const code = (e as { code?: string }).code;
        if (code !== '42P01' && code !== '42883') throw e;
      }
      return {
        orders,
        envelopes,
        ...ready,
        contractValue: rows[0].contract_value === null ? null : Number(rows[0].contract_value),
        signer: { name: rows[0].client_name ?? null, email: rows[0].client_email ?? null },
      };
    });
    if (!out) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(out);
  } catch (e) {
    return esignErrorResponse(e, 'Loading change orders');
  }
}

/** Raise a change order, as a draft. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!ROLES.includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const body = (await request.json().catch(() => null)) as {
    reason?: unknown;
    description?: unknown;
    amountDelta?: unknown;
    requiresSignature?: unknown;
  } | null;
  const amount = Number(body?.amountDelta);
  if (body?.amountDelta === '' || body?.amountDelta == null || !Number.isFinite(amount)) {
    return NextResponse.json(
      { error: 'Enter the amount the contract changes by — 0 when the price stays the same.' },
      { status: 400 }
    );
  }
  if (Math.abs(amount) > 10_000_000) {
    return NextResponse.json(
      { error: 'That amount is not believable for a change order.' },
      { status: 400 }
    );
  }
  try {
    const { rows } = await withUser(session, (c) =>
      c.query<{ id: string }>('select public.create_change_order($1, $2, $3, $4, $5) as id', [
        id,
        typeof body?.reason === 'string' ? body.reason.slice(0, 300) : '',
        typeof body?.description === 'string' ? body.description.slice(0, 4000) : null,
        amount,
        body?.requiresSignature !== false,
      ])
    );
    return NextResponse.json({ id: rows[0].id }, { status: 201 });
  } catch (e) {
    return esignErrorResponse(e, 'Raising the change order');
  }
}
