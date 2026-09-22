import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { dbErrorResponse } from '@/lib/db-error';
import { optionalRows } from '@/lib/db-optional';
import { coerceIntakeValue } from '@/lib/crm/coerce';
import { intakeCreateColumns } from '@/lib/crm/intake';
import { findPeopleByContact } from '@/lib/people/service';

/**
 * Create Contact.
 *
 * One form, two tables: the person, and — only when there is something to put on
 * it — the deal that carries the system, the price and the paperwork. Both are
 * made inside public.create_contact() so a failure halfway leaves neither
 * behind.
 *
 * The duplicate guard runs here as it does on every other creation path, and
 * matches across every channel on file rather than the primary columns alone: a
 * second email address is still the same person.
 */

/** The submitted values for one table, as a JSON object of real columns only. */
function pick(
  owner: 'client' | 'deal',
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of intakeCreateColumns(owner)) {
    if (!(field.name in incoming)) continue;
    const value = coerceIntakeValue(field, incoming[field.name]);
    if (value !== null) out[field.name] = value;
  }
  return out;
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops', 'sales'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    values?: Record<string, unknown>;
    allowDuplicate?: boolean;
  } | null;
  const incoming = body?.values ?? {};

  const person = pick('client', incoming);
  const deal = pick('deal', incoming);

  // Whoever creates a contact owns it, unless they said otherwise. The form
  // pre-selects them so the default is visible before it is saved; this is for
  // every other way a contact arrives — an import, a web form, a script — where
  // the alternative is an unowned record nobody is looking at.
  //
  // Only when the field was not sent at all. Somebody who clears the box on the
  // form has made a decision, and a default that overrides it is not a default.
  if (!('owner_id' in incoming)) person.owner_id = session.userId;

  // The form asks for a surname and marks the first name optional, which is how
  // every CRM asks and how half the business cards in a drawer read. The column
  // is NOT NULL, so the absent half arrives as an empty string rather than as a
  // failed insert — and every display in the product joins the two names with a
  // filter, so an empty one shows as nothing rather than as a gap.
  if (typeof person.first_name !== 'string') person.first_name = '';

  // Lead status is the contact's own field now, so what is left on the deal side
  // is only ever something somebody typed: a dealer code, a sales note. Any of
  // them means there is an opportunity worth recording; none of them means this
  // is a person and nothing more.
  const email = typeof person.email === 'string' ? person.email.trim().toLowerCase() : null;
  const phone = typeof person.phone === 'string' ? person.phone.trim() : null;
  if (email) person.email = email;

  // The whole of the requirement, and no more: something to find them by, and
  // something to reach them on. A rep standing on a driveway with a mobile
  // number and no email still gets to save, because the alternative is that the
  // number lives in their phone instead of in here.
  if (!person.last_name) {
    return NextResponse.json({ error: 'A last name, so the record can be found again.' }, { status: 400 });
  }
  if (!email && !phone) {
    return NextResponse.json(
      { error: 'A way to reach them — an email address or a phone number.' },
      { status: 400 }
    );
  }

  try {
    if (body?.allowDuplicate !== true) {
      const existing = await withUser(session, (c) => findPeopleByContact(c, email, phone));
      if (existing.length > 0) {
        return NextResponse.json(
          { error: 'Somebody with this email or phone is already on file.', duplicates: existing },
          { status: 409 }
        );
      }
    }

    const created = await withUser(session, async (client) => {
      const rows = await optionalRows<{ client_id: string; deal_id: string | null }>(
        client,
        'creating the contact (public.create_contact)',
        `select client_id, deal_id from public.create_contact($1::jsonb, $2::jsonb)`,
        [JSON.stringify(person), Object.keys(deal).length > 0 ? JSON.stringify(deal) : null]
      );
      return rows[0] ?? null;
    });

    if (!created?.client_id) {
      return NextResponse.json(
        { error: 'Could not save — the database may not have caught up yet.' },
        { status: 400 }
      );
    }

    await tryLogAuditEvent(session, {
      action: 'contact.created',
      entityType: 'clients',
      entityId: created.client_id,
      clientId: created.client_id,
      dealId: created.deal_id ?? undefined,
      kind: 'form',
    });
    return NextResponse.json(
      { clientId: created.client_id, dealId: created.deal_id },
      { status: 201 }
    );
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      return NextResponse.json(
        { error: 'That email is already used by somebody else — open their record instead.' },
        { status: 409 }
      );
    }
    return dbErrorResponse(e, 'Creating the contact');
  }
}
