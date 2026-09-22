import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { coerceIntakeValue, isUuid } from '@/lib/crm/coerce';
import { signingColumns } from '@/lib/crm/intake';
import { esignErrorResponse } from '@/lib/esign/errors';
import { listEnvelopes, loadSettings, readiness, sendEnvelope } from '@/lib/esign/service';

const ROLES = ['admin', 'ops', 'sales'];

/**
 * The contact's contracts out for signature, and whether one can be sent.
 *
 * On a database without 004400 this answers "not ready" rather than failing,
 * so the signing form keeps working by hand while the SQL catches up.
 */
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
      const settings = await loadSettings(c);
      const envelopes = await listEnvelopes(c, { clientId: id });
      const { rows } = await c.query<{ name: string | null; email: string | null }>(
        `select nullif(btrim(concat_ws(' ', first_name, last_name)), '') as name, email
           from public.clients where id = $1`,
        [id]
      );
      return { settings, envelopes, signer: rows[0] ?? { name: null, email: null } };
    });
    const r = readiness(out.settings, 'contract');
    return NextResponse.json({ ...r, envelopes: out.envelopes, signer: out.signer });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === '42P01' || code === '42883') {
      return NextResponse.json({
        ready: false,
        reason: 'E-signature needs migration 004400 — Admin → Database → Apply.',
        envelopes: [],
        signer: { name: null, email: null },
      });
    }
    return esignErrorResponse(e, 'Loading e-signatures');
  }
}

/**
 * Send the contract for signature instead of signing it here.
 *
 * Takes the same form the Sign button does. Nothing moves yet: the contact
 * stays where they are until the homeowner signs, and then the project is
 * created from exactly what was sent — see esign_complete() in 004400.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!ROLES.includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = (await request.json().catch(() => null)) as {
    values?: Record<string, unknown>;
    dealId?: unknown;
    signerName?: unknown;
    signerEmail?: unknown;
    delivery?: unknown;
  } | null;
  const incoming = body?.values ?? {};
  const payload: Record<string, unknown> = {};
  for (const field of signingColumns()) {
    if (field.name in incoming)
      payload[field.name] = coerceIntakeValue(field, incoming[field.name]);
  }
  const delivery = body?.delivery === 'embedded' ? 'embedded' : 'email';
  const signerEmail = typeof body?.signerEmail === 'string' ? body.signerEmail.trim() : '';
  const signerName =
    typeof body?.signerName === 'string' ? body.signerName.trim().slice(0, 200) : '';
  const dealId = isUuid(body?.dealId) ? body.dealId : null;

  try {
    const settings = await withUser(session, (c) => loadSettings(c));
    const r = readiness(settings, 'contract');
    if (!r.ready) return NextResponse.json({ error: r.reason }, { status: 409 });

    const { rows } = await withUser(session, (c) =>
      c.query<{ id: string }>(
        `select public.esign_open('contract', $1, $2, null, $3, $4, $5, $6::jsonb, null) as id`,
        [id, dealId, signerName, signerEmail, delivery, JSON.stringify(payload)]
      )
    );
    const sent = await sendEnvelope(session, rows[0].id);
    return NextResponse.json(sent, { status: 201 });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === '22023' && err.message) {
      const missing = /system size/.test(err.message)
        ? ['system_size_kw']
        : /dealer/.test(err.message)
          ? ['dealer_id']
          : /site address/.test(err.message)
            ? ['address']
            : null;
      if (missing) {
        return NextResponse.json(
          { error: err.message.charAt(0).toUpperCase() + err.message.slice(1) + '.', missing },
          { status: 400 }
        );
      }
    }
    return esignErrorResponse(e, 'Sending the contract');
  }
}
