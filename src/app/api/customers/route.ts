import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';
import { findPeopleByContact } from '@/lib/people/service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTACT = ['email', 'phone', 'text'];

/**
 * Create or edit a customer record. PMs may edit contact details and internal
 * notes; the destructive operations live in their own routes and are
 * admin-only. Email is the portal login identity and unique
 * case-insensitively, so a clash is reported rather than silently creating a
 * second half-customer.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  // Sales create people: a prospect who rings in is a person before they are
  // anything else, and making them wait for a PM is how they end up in a
  // spreadsheet instead.
  if (!['admin', 'ops', 'sales'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    id?: string;
    dealerId?: string;
    firstName?: string;
    lastName?: string;
    email?: string | null;
    phone?: string | null;
    alternatePhone?: string | null;
    mailingAddress?: string | null;
    preferredContact?: string | null;
    preferredLanguage?: string | null;
    internalNotes?: string | null;
    isArchived?: boolean;
    /** Skip the 'already exists' guard when the admin has decided. */
    allowDuplicate?: boolean;
  } | null;

  const text = (v: string | null | undefined, max = 200) =>
    v && v.trim() ? v.trim().slice(0, max) : null;
  const first = text(body?.firstName, 80);
  const last = text(body?.lastName, 80);
  const email = text(body?.email)?.toLowerCase() ?? null;

  if (!body?.id && (!first || !last)) {
    return NextResponse.json({ error: 'first and last name are required' }, { status: 400 });
  }

  try {
    // Duplicate guard on create (Part 4): "offering to attach to the existing
    // person rather than inserting". Matched across every channel on file, not
    // just the primary columns — a second email is still the same person, and
    // that is precisely the case the old check walked past.
    if (!body?.id && !body?.allowDuplicate) {
      const existing = await withUser(session, (c) =>
        findPeopleByContact(c, email, text(body?.phone, 40))
      );
      if (existing.length > 0) {
        return NextResponse.json(
          {
            error: 'Somebody with this email or phone is already on file.',
            duplicates: existing,
          },
          { status: 409 }
        );
      }
    }

    const id = await withUser(session, async (client) => {
      if (body?.id && UUID_RE.test(body.id)) {
        const { rows } = await client.query<{ id: string }>(
          `update public.clients set
             first_name = coalesce($2, first_name),
             last_name = coalesce($3, last_name),
             email = $4,
             phone = $5,
             alternate_phone = $6,
             mailing_address = $7,
             preferred_contact = $8,
             preferred_language = $9,
             internal_notes = $10,
             is_archived = coalesce($11, is_archived)
           where id = $1
           returning id`,
          [
            body.id, first, last, email, text(body.phone, 40), text(body.alternatePhone, 40),
            text(body.mailingAddress, 300),
            CONTACT.includes(String(body.preferredContact)) ? body.preferredContact : null,
            text(body.preferredLanguage, 40), text(body.internalNotes, 4000),
            typeof body.isArchived === 'boolean' ? body.isArchived : null,
          ]
        );
        return rows[0]?.id ?? null;
      }

      // A dealer is optional now. Part 2's one real change: a person can exist
      // with no project — and a prospect from a web form belongs to no dealer's
      // book until a deal says so. Picking one for them would corrupt the
      // attribution that commissions and performance reporting both rest on.
      const dealerId = body?.dealerId && UUID_RE.test(body.dealerId) ? body.dealerId : null;

      const { rows } = await client.query<{ id: string }>(
        `insert into public.clients
           (dealer_id, first_name, last_name, email, phone, alternate_phone,
            mailing_address, preferred_contact, preferred_language, internal_notes)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning id`,
        [
          dealerId, first, last, email, text(body?.phone, 40), text(body?.alternatePhone, 40),
          text(body?.mailingAddress, 300),
          CONTACT.includes(String(body?.preferredContact)) ? body?.preferredContact : null,
          text(body?.preferredLanguage, 40), text(body?.internalNotes, 4000),
        ]
      );
      return rows[0]?.id ?? null;
    });

    if (!id) {
      return NextResponse.json(
        { error: 'Could not save — check the record still exists.' },
        { status: 400 }
      );
    }

    await tryLogAuditEvent(session, {
      action: body?.id ? 'customer.updated' : 'customer.created',
      entityType: 'clients',
      entityId: id,
    });
    return NextResponse.json({ id }, { status: body?.id ? 200 : 201 });
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      return NextResponse.json(
        { error: 'That email is already used by somebody else — merge the records instead.' },
        { status: 409 }
      );
    }
    return dbErrorResponse(e, 'Saving the customer');
  }
}
