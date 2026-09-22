import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { dbErrorResponse } from '@/lib/db-error';
import { optionalRows } from '@/lib/db-optional';
import { coerceIntakeValue, isUuid } from '@/lib/crm/coerce';
import { signingColumns } from '@/lib/crm/intake';

/**
 * Contract signed: record the system, then move the contact.
 *
 * The only way into the Contract signed column. The stage board and the
 * contact record both open the same form when somebody chooses it, and both
 * send it here; public.sign_contact() writes the system onto the deal — making
 * the deal if there is none — and moves the contact, in one statement.
 *
 * Every field on the form is sent, including the emptied ones: an emptied box
 * is how somebody says "no battery after all", and dropping it would leave the
 * old answer standing. Fields the form never showed are not sent, and the
 * function leaves those as they were.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops', 'sales'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = (await request.json().catch(() => null)) as {
    values?: Record<string, unknown>;
    dealId?: unknown;
    note?: unknown;
  } | null;
  const incoming = body?.values ?? {};

  const patch: Record<string, unknown> = {};
  for (const field of signingColumns()) {
    if (field.name in incoming) patch[field.name] = coerceIntakeValue(field, incoming[field.name]);
  }

  // Said here as well as in the database, so the answer arrives before a round
  // trip — and in the same words the form puts under the box.
  const size = patch.system_size_kw;
  if ('system_size_kw' in patch && (typeof size !== 'number' || size <= 0)) {
    return NextResponse.json(
      { error: 'A signed contract needs a system size — enter it in kW.', missing: ['system_size_kw'] },
      { status: 400 }
    );
  }

  const dealId = isUuid(body?.dealId) ? body.dealId : null;
  const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : null;

  try {
    const rows = await withUser(session, (client) =>
      optionalRows<{ signed_deal_id: string; deal_created: boolean }>(
        client,
        'signing the contact (public.sign_contact)',
        `select signed_deal_id, deal_created
           from public.sign_contact($1::uuid, $2::jsonb, $3::uuid, $4)`,
        [id, JSON.stringify(patch), dealId, note]
      )
    );
    if (rows.length === 0) {
      return NextResponse.json(
        {
          error:
            'Could not sign — the database has not caught up yet. Open Admin → Database and click Apply.',
        },
        { status: 400 }
      );
    }
    return NextResponse.json({ dealId: rows[0].signed_deal_id, dealCreated: rows[0].deal_created });
  } catch (e) {
    // The function's own refusals are sentences meant for the person at the
    // form, and a 500 around them would read as a broken app.
    const err = e as { code?: string; message?: string };
    if (err.code === '22023' || err.code === 'P0002') {
      const text = err.message ?? 'That could not be signed.';
      return NextResponse.json(
        {
          error: text.charAt(0).toUpperCase() + text.slice(1) + '.',
          ...(/system size/.test(text) ? { missing: ['system_size_kw'] } : {}),
        },
        { status: err.code === 'P0002' ? 404 : 400 }
      );
    }
    return dbErrorResponse(e, 'Signing the contact');
  }
}
