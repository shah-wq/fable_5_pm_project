import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { dbErrorResponse } from '@/lib/db-error';
import { coerceIntakeValue, isUuid } from '@/lib/crm/coerce';
import { signingColumns } from '@/lib/crm/intake';

/**
 * Contract signed: record the system, move the contact, create the project.
 *
 * The only way into the Contract signed column. The stage board and the
 * contact record both open the same form when somebody chooses it, and both
 * send it here; public.sign_contact() writes the system onto the deal — making
 * the deal if there is none — moves the contact, and converts the deal into a
 * project, in one statement. If the project cannot be made, nothing happens.
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
    // A plain query, not optionalRows: that helper answers a missing column or
    // function with an empty result, and an empty result here could only be
    // reported as "not caught up" — which is what a database with the first
    // sign_contact was told while Admin → Database called it up to date.
    // Letting the error through means dbErrorResponse names what is missing.
    const { rows } = await withUser(session, (client) =>
      client.query<{
        signed_deal_id: string;
        deal_created: boolean;
        signed_project_id: string | null;
        signed_project_code: string | null;
      }>(
        `select signed_deal_id, deal_created, signed_project_id, signed_project_code
           from public.sign_contact($1::uuid, $2::jsonb, $3::uuid, $4)`,
        [id, JSON.stringify(patch), dealId, note]
      )
    );
    return NextResponse.json({
      dealId: rows[0].signed_deal_id,
      dealCreated: rows[0].deal_created,
      projectId: rows[0].signed_project_id ?? null,
      projectCode: rows[0].signed_project_code ?? null,
    });
  } catch (e) {
    // The function's own refusals are sentences meant for the person at the
    // form, and a 500 around them would read as a broken app.
    const err = e as { code?: string; message?: string };
    // 23514 is the project conversion's own refusal — a rule it checks that
    // the form did not, worded for a person all the same.
    if (err.code === '22023' || err.code === 'P0002' || err.code === '23514') {
      const text = err.message ?? 'That could not be signed.';
      const missing = /system size/.test(text)
        ? ['system_size_kw']
        : /dealer/.test(text)
          ? ['dealer_id']
          : /site address/.test(text)
            ? ['address']
            : null;
      return NextResponse.json(
        { error: text.charAt(0).toUpperCase() + text.slice(1) + '.', ...(missing ? { missing } : {}) },
        { status: err.code === 'P0002' ? 404 : 400 }
      );
    }
    return dbErrorResponse(e, 'Signing the contact');
  }
}
