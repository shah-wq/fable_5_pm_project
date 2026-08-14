import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ['availability', 'question', 'contact_update'];

/**
 * A customer action becomes a request in the PM's queue — availability is a
 * request, not a booking, and a contact change notifies the PM rather than
 * silently overwriting what the company thinks it knows. No stage field is
 * ever written from here.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (session.role !== 'customer' || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    projectId?: string;
    kind?: string;
    message?: string | null;
    preferredDates?: string | null;
    timeWindow?: string | null;
    contactPhone?: string | null;
    contactEmail?: string | null;
    preferredContact?: string | null;
  } | null;

  if (!body?.projectId || !UUID_RE.test(body.projectId)) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  }
  if (!body.kind || !KINDS.includes(body.kind)) {
    return NextResponse.json({ error: 'unknown request type' }, { status: 400 });
  }
  const text = (v: string | null | undefined, max = 2000) =>
    v && v.trim() ? v.trim().slice(0, max) : null;

  if (body.kind === 'question' && !text(body.message)) {
    return NextResponse.json({ error: 'please type your question' }, { status: 400 });
  }
  if (body.kind === 'availability' && !text(body.preferredDates)) {
    return NextResponse.json({ error: 'please tell us which days suit you' }, { status: 400 });
  }
  if (body.kind === 'contact_update' && !text(body.contactPhone, 40) && !text(body.contactEmail, 200)) {
    return NextResponse.json({ error: 'give a phone number or an email address' }, { status: 400 });
  }

  try {
    const result = await withUser(session, async (client) => {
      const { rows } = await client.query<{ client_id: string; assigned_pm: string | null; name: string }>(
        `select client_id, assigned_pm, name from public.projects where id = $1`,
        [body.projectId]
      );
      const project = rows[0];
      if (!project) return null;

      const inserted = await client.query<{ id: string }>(
        `insert into public.customer_requests
           (project_id, client_id, kind, message, preferred_dates, time_window,
            contact_phone, contact_email, preferred_contact)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning id`,
        [
          body.projectId, project.client_id, body.kind,
          text(body.message), text(body.preferredDates, 300),
          ['morning', 'afternoon', 'any'].includes(String(body.timeWindow)) ? body.timeWindow : null,
          text(body.contactPhone, 40), text(body.contactEmail, 200),
          ['email', 'phone', 'text'].includes(String(body.preferredContact)) ? body.preferredContact : null,
        ]
      );

      // A contact change also updates the customer's own record (the request
      // row is what tells the PM it happened).
      if (body.kind === 'contact_update') {
        await client.query(
          `update public.clients
           set phone = coalesce($2, phone),
               email = coalesce($3, email),
               preferred_contact = coalesce($4, preferred_contact)
           where id = $1`,
          [
            project.client_id,
            text(body.contactPhone, 40),
            text(body.contactEmail, 200),
            ['email', 'phone', 'text'].includes(String(body.preferredContact)) ? body.preferredContact : null,
          ]
        );
      }

      return { id: inserted.rows[0]?.id ?? null, projectId: body.projectId! };
    });

    if (!result?.id) {
      return NextResponse.json({ error: 'project not found' }, { status: 404 });
    }

    await tryLogAuditEvent(session, {
      action: `customer.${body.kind}`,
      entityType: 'customer_requests',
      entityId: result.id,
      projectId: result.projectId,
    });
    return NextResponse.json({ id: result.id }, { status: 201 });
  } catch (e) {
    return dbErrorResponse(e, 'Sending your message');
  }
}
