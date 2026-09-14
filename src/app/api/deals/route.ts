import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { dbErrorResponse } from '@/lib/db-error';
import { optionalRows } from '@/lib/db-optional';
import { findPeopleByContact } from '@/lib/people/service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Create a deal, and edit the fields the stage gates read.
 *
 * Duplicate prevention runs here too (Part 4: "every creation path"), because a
 * deal typed in by a rep is one of the commonest ways a second record for the
 * same person gets made.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops', 'sales'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const text = (v: unknown, max = 200) =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
  const uuid = (v: unknown) => (typeof v === 'string' && UUID_RE.test(v) ? v : null);
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const clientId = uuid(body?.clientId);
  const first = text(body?.firstName, 80);
  const last = text(body?.lastName, 80);
  const email = text(body?.email)?.toLowerCase() ?? null;
  const phone = text(body?.phone, 40);

  if (!clientId && (!first || !last)) {
    return NextResponse.json(
      { error: 'A deal needs a person: pick somebody on file, or give a first and last name.' },
      { status: 400 }
    );
  }
  if (!clientId && !email && !phone) {
    return NextResponse.json(
      { error: 'A deal needs a way to reach them — an email or a phone number.' },
      { status: 400 }
    );
  }

  try {
    // Offer the existing person rather than inserting a second one.
    if (!clientId && body?.allowDuplicate !== true) {
      const existing = await withUser(session, (c) => findPeopleByContact(c, email, phone));
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
      // A deal typed in by hand creates the person, and links to them. Part 2:
      // clients is the person spine, so a deal that carries a name and an email
      // of its own is a person nobody can search for, merge, or check for
      // duplicates — which is exactly the shadow record this module exists to
      // prevent. The unmatched path stays open for dealer submissions, which
      // arrive before anybody has decided who they are.
      let personId = clientId;
      if (!personId) {
        const created = await optionalRows<{ id: string }>(
          client,
          'creating the person behind a deal (public.clients)',
          `insert into public.clients (first_name, last_name, email, phone, dealer_id, source_id)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [first, last, email, phone, uuid(body?.dealerId), uuid(body?.sourceId)]
        );
        personId = created[0]?.id ?? null;
        if (personId) {
          if (email) {
            await optionalRows(
              client,
              'recording the new person’s email channel',
              `insert into public.client_channels (client_id, kind, value, value_normalised, is_primary)
               values ($1, 'email', $2, '', true) on conflict do nothing`,
              [personId, email]
            );
          }
          if (phone) {
            await optionalRows(
              client,
              'recording the new person’s phone channel',
              `insert into public.client_channels (client_id, kind, value, value_normalised, is_primary)
               values ($1, 'phone', $2, '', true) on conflict do nothing`,
              [personId, phone]
            );
          }
        }
      }

      const rows = await optionalRows<{ id: string }>(
        client,
        'creating a deal (public.deals)',
        `insert into public.deals
           (client_id, customer_first, customer_last, customer_email, customer_phone,
            address, dealer_id, source_id, owner_id, stage, next_action, next_action_at,
            property_address_id, notes)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'new', $10, $11, $12, $13)
         returning id`,
        [
          personId,
          first,
          last,
          email,
          phone,
          text(body?.address, 300),
          uuid(body?.dealerId),
          uuid(body?.sourceId),
          // Unassigned by default: Part 8 gives every rep the unassigned pool,
          // and picking an owner for them would be a routing rule nobody chose.
          uuid(body?.ownerId),
          text(body?.nextAction, 200),
          text(body?.nextActionAt, 10),
          uuid(body?.propertyAddressId),
          text(body?.notes, 4000),
        ]
      );
      return rows[0]?.id ?? null;
    });

    if (!id) {
      return NextResponse.json(
        { error: 'Could not create the deal — the database may not have caught up yet.' },
        { status: 400 }
      );
    }

    await tryLogAuditEvent(session, {
      action: 'deal.created',
      entityType: 'deals',
      entityId: id,
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch (e) {
    return dbErrorResponse(e, 'Saving the deal');
  }
}

/** Edit one deal: the qualification, proposal and commercial fields. */
export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops', 'sales'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const id = typeof body?.id === 'string' && UUID_RE.test(body.id) ? body.id : null;
  if (!id) return NextResponse.json({ error: 'which deal?' }, { status: 400 });

  // An allowlist, in the same spirit as the stage form's field registry: only
  // these columns can be written, and each is coerced to its own shape.
  const TEXT = ['address', 'credit_band', 'timeline_intent', 'shading_concern',
                'financing_route', 'next_action', 'notes', 'lost_notes'];
  const NUMBER = ['roof_age', 'avg_monthly_bill', 'annual_usage_kwh', 'system_size_kw',
                  'battery_qty', 'production_estimate_kwh', 'gross_price', 'incentives',
                  'net_price', 'monthly_payment', 'contract_value', 'expected_commission',
                  'probability'];
  const BOOL = ['homeowner_confirmed', 'decision_maker_identified'];
  const DATE = ['next_action_at', 'expected_close_date'];
  const REF = ['client_id', 'owner_id', 'next_action_owner_id', 'property_address_id',
               'roof_type_id', 'utility_id', 'module_id', 'inverter_id', 'battery_id',
               'financing_company_id', 'competitor_id', 'source_id', 'dealer_id'];

  const sets: string[] = [];
  const params: unknown[] = [id];
  const push = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  for (const [key, value] of Object.entries(body ?? {})) {
    if (key === 'id') continue;
    if (TEXT.includes(key)) push(key, typeof value === 'string' ? value.slice(0, 4000) : null);
    else if (NUMBER.includes(key)) {
      const n = Number(value);
      push(key, value === null || value === '' || !Number.isFinite(n) ? null : n);
      // A hand-typed probability is an override, and says so in the forecast.
      if (key === 'probability' && Number.isFinite(n)) push('probability_is_override', true);
    } else if (BOOL.includes(key)) push(key, value === true);
    else if (DATE.includes(key)) {
      push(key, typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);
    } else if (REF.includes(key)) {
      push(key, typeof value === 'string' && UUID_RE.test(value) ? value : null);
    }
  }

  if (sets.length === 0) return NextResponse.json({ ok: true });

  try {
    const ok = await withUser(session, async (client) => {
      const rows = await optionalRows<{ id: string }>(
        client,
        'saving a deal (public.deals)',
        `update public.deals set ${sets.join(', ')} where id = $1 returning id`,
        params
      );
      return rows.length > 0;
    });
    if (!ok) return NextResponse.json({ error: 'that deal no longer exists' }, { status: 404 });
    await tryLogAuditEvent(session, {
      action: 'deal.updated',
      entityType: 'deals',
      entityId: id,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return dbErrorResponse(e, 'Saving the deal');
  }
}
