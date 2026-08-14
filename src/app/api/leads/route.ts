import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lead submission — the one place a dealer writes. A lead never creates a
 * project directly; it lands in the PM's review queue. RLS double-checks the
 * dealer can only file under their own company.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['dealer', 'admin', 'ops'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    customerFirst?: string;
    customerLast?: string;
    customerEmail?: string;
    customerPhone?: string;
    address?: string;
    salesRepName?: string;
    estimatedSizeKw?: number;
    cashOrFinancingId?: string;
    notes?: string;
  } | null;

  const first = body?.customerFirst?.trim();
  const last = body?.customerLast?.trim();
  const address = body?.address?.trim();
  const email = body?.customerEmail?.trim() || null;
  const phone = body?.customerPhone?.trim() || null;
  if (!first || !last) {
    return NextResponse.json({ error: 'customer first and last name are required' }, { status: 400 });
  }
  if (!address) return NextResponse.json({ error: 'site address is required' }, { status: 400 });
  if (!email && !phone) {
    return NextResponse.json({ error: 'customer email or phone is required' }, { status: 400 });
  }
  const kw = body?.estimatedSizeKw === undefined || body.estimatedSizeKw === null
    ? null
    : Number(body.estimatedSizeKw);
  if (kw !== null && (!Number.isFinite(kw) || kw <= 0)) {
    return NextResponse.json({ error: 'invalid estimated system size' }, { status: 400 });
  }
  const cashId = body?.cashOrFinancingId && UUID_RE.test(body.cashOrFinancingId)
    ? body.cashOrFinancingId
    : null;

  const leadId = await withUser(session, async (client) => {
    const dealer = await client.query<{ dealer_id: string }>(
      `select dealer_id from public.dealer_users where user_id = $1 limit 1`,
      [session.userId]
    );
    if (!dealer.rows[0]) return null;
    const { rows } = await client.query<{ id: string }>(
      `insert into public.leads
         (dealer_id, submitted_by, customer_first, customer_last, customer_email,
          customer_phone, address, sales_rep_name, estimated_size_kw,
          cash_or_financing_id, notes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning id`,
      [dealer.rows[0].dealer_id, session.userId, first, last, email, phone, address,
       body?.salesRepName?.trim() || null, kw, cashId, body?.notes?.trim() || null]
    );
    return rows[0]?.id ?? null;
  }).catch(() => null);

  if (!leadId) {
    return NextResponse.json(
      { error: 'Could not submit — your login is not linked to a dealer company.' },
      { status: 403 }
    );
  }

  await tryLogAuditEvent(session, { action: 'lead.submitted', entityType: 'leads', entityId: leadId });
  return NextResponse.json({ id: leadId }, { status: 201 });
}
