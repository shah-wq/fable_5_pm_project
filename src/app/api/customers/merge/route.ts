import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS = [
  'first_name', 'last_name', 'email', 'phone', 'alternate_phone',
  'mailing_address', 'preferred_contact', 'preferred_language', 'internal_notes',
];

/**
 * Merge duplicate customers. GET previews exactly what will move ('3 projects,
 * 12 documents, 1 portal account') so the admin decides with the facts in
 * front of them; POST performs it. Nothing is deleted — the merged records are
 * archived and everything they own is re-pointed — and the whole thing is
 * written to the activity log with both originals so it can be reconstructed.
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (session.role !== 'admin' || !session.isActive) {
    return NextResponse.json({ error: 'Only an admin can merge customers.' }, { status: 403 });
  }

  const ids = (new URL(request.url).searchParams.get('ids') ?? '')
    .split(',').map((s) => s.trim()).filter((s) => UUID_RE.test(s)).slice(0, 5);
  if (ids.length < 2) {
    return NextResponse.json({ error: 'pick at least two customers' }, { status: 400 });
  }

  try {
    const records = await withUser(session, async (client) => {
      const { rows } = await client.query(
        `select c.id, c.first_name, c.last_name, c.email, c.phone, c.alternate_phone,
                c.mailing_address, c.preferred_contact, c.preferred_language,
                c.internal_notes, c.user_id, c.created_at,
                (select count(*)::int from public.projects p where p.client_id = c.id) as projects,
                (select count(*)::int from public.documents d
                   join public.projects p on p.id = d.project_id
                   where p.client_id = c.id) as documents,
                (select count(*)::int from public.customer_requests r where r.client_id = c.id) as messages,
                (select count(*)::int from public.leads l
                   where l.converted_project_id in
                     (select id from public.projects where client_id = c.id)) as leads,
                pr.email as login_email
         from public.clients c
         left join public.profiles pr on pr.id = c.user_id
         where c.id = any($1)
         order by c.created_at`,
        [ids]
      );
      return rows;
    });

    if (records.length < 2) {
      return NextResponse.json({ error: 'those customers were not found' }, { status: 404 });
    }
    return NextResponse.json({ records, fields: FIELDS });
  } catch (e) {
    return dbErrorResponse(e, 'Previewing the merge');
  }
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (session.role !== 'admin' || !session.isActive) {
    return NextResponse.json({ error: 'Only an admin can merge customers.' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    survivorId?: string;
    mergeIds?: string[];
    fields?: Record<string, unknown>;
    keepLoginUserId?: string | null;
  } | null;

  const survivor = body?.survivorId && UUID_RE.test(body.survivorId) ? body.survivorId : null;
  const merged = Array.isArray(body?.mergeIds)
    ? body!.mergeIds.filter((v) => UUID_RE.test(String(v)) && v !== survivor).slice(0, 5)
    : [];
  if (!survivor || merged.length === 0) {
    return NextResponse.json({ error: 'a survivor and at least one duplicate are required' }, { status: 400 });
  }

  // Only registry fields, only strings — the function applies them as a patch.
  const fields: Record<string, string | null> = {};
  for (const key of FIELDS) {
    const value = body?.fields?.[key];
    if (typeof value === 'string' && value.trim()) {
      fields[key] = key === 'email' ? value.trim().toLowerCase().slice(0, 200) : value.trim().slice(0, 4000);
    }
  }
  const keepLogin = body?.keepLoginUserId && UUID_RE.test(body.keepLoginUserId)
    ? body.keepLoginUserId
    : null;

  try {
    // Both originals are captured before the merge so the log can reconstruct it.
    const before = await withUser(session, async (client) => {
      const { rows } = await client.query(
        `select id, first_name, last_name, email, phone, alternate_phone, mailing_address,
                preferred_contact, preferred_language, internal_notes, user_id
         from public.clients where id = any($1)`,
        [[survivor, ...merged]]
      );
      return rows;
    });

    const summary = await withUser(session, async (client) => {
      const { rows } = await client.query<{ result: Record<string, unknown> }>(
        `select public.merge_customers($1, $2, $3::jsonb, $4) as result`,
        [survivor, merged, JSON.stringify(fields), keepLogin]
      );
      return rows[0]?.result ?? null;
    });

    await tryLogAuditEvent(session, {
      action: 'customer.merged',
      entityType: 'clients',
      entityId: survivor,
      context: { merged, summary, before } as never,
    });

    return NextResponse.json({ ok: true, summary });
  } catch (e) {
    return dbErrorResponse(e, 'Merging the customers');
  }
}
