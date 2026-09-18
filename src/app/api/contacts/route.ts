import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { dbErrorResponse } from '@/lib/db-error';
import { optionalRows } from '@/lib/db-optional';
import { intakeCreateColumns, type IntakeField } from '@/lib/crm/intake';
import { findPeopleByContact } from '@/lib/people/service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Coerce one submitted value to the shape its column expects, or drop it. */
function coerce(field: IntakeField, raw: unknown): unknown {
  if (raw === '' || raw === null || raw === undefined) return null;
  switch (field.type) {
    case 'number':
    case 'currency': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case 'toggle':
      return raw === true;
    case 'yesno':
      if (raw === true || raw === 'yes') return true;
      if (raw === false || raw === 'no') return false;
      return null;
    case 'ref':
      return UUID_RE.test(String(raw)) ? String(raw) : null;
    case 'select':
    case 'readonly':
      return field.options?.some((o) => o.value === String(raw)) ? String(raw) : null;
    default:
      return String(raw).slice(0, 4000);
  }
}

/** The submitted values for one table, as a JSON object of real columns only. */
function pick(
  owner: 'client' | 'deal',
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of intakeCreateColumns(owner)) {
    if (!(field.name in incoming)) continue;
    const value = coerce(field, incoming[field.name]);
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
