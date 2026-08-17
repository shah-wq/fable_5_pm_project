import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';
import { sendEmail } from '@/lib/email';

/**
 * The in-app account-deletion route both stores require (spec §7).
 *
 * It files a request rather than deleting anything: an admin carries it out
 * through the anonymise flow in the customer-management module, which removes
 * the person and keeps the permit, installation date and payment history the
 * business is legally required to retain. Silently destroying a live project's
 * history because someone tapped a button in an app would be the wrong answer
 * to a reasonable request.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (session.role !== 'customer') {
    return NextResponse.json(
      { error: 'Staff accounts are managed by your administrator.' },
      { status: 403 }
    );
  }

  const body = (await request.json().catch(() => null)) as {
    projectId?: string;
    confirm?: string;
  } | null;
  if (String(body?.confirm ?? '').trim().toUpperCase() !== 'DELETE') {
    return NextResponse.json({ error: 'Type DELETE to confirm.' }, { status: 400 });
  }

  try {
    const filed = await withUser(session, async (client) => {
      // The customer's own record, found through the login link rather than
      // trusting anything in the request body.
      const { rows } = await client.query<{ id: string; name: string; project_id: string | null }>(
        `select c.id, c.first_name || ' ' || c.last_name as name,
                (select p.id from public.projects p
                  where p.client_id = c.id order by p.created_at desc limit 1) as project_id
         from public.clients c
         where c.user_id = $1`,
        [session.userId]
      );
      const customer = rows[0];
      if (!customer?.project_id) return null;

      await client.query(
        `insert into public.customer_requests
           (project_id, client_id, kind, message)
         values ($1, $2, 'account_deletion', $3)`,
        [
          customer.project_id,
          customer.id,
          'Account deletion requested from the app. Handle through Admin → Customers → Anonymise.',
        ]
      );
      return customer;
    });

    if (!filed) {
      return NextResponse.json(
        { error: 'We could not find your record. Please email your project manager.' },
        { status: 400 }
      );
    }

    await tryLogAuditEvent(session, {
      action: 'customer.deletion_requested',
      entityType: 'clients',
      entityId: filed.id,
      projectId: filed.project_id ?? undefined,
    });

    // The office needs to know: an unread deletion request is a compliance
    // problem, not just an unread message.
    const to = process.env.PRIVACY_REQUEST_EMAIL ?? process.env.SMTP_USER;
    if (to) {
      await sendEmail({
        to,
        subject: `Account deletion requested — ${filed.name}`,
        text:
          `${filed.name} has requested deletion of their account from the mobile app.\n\n` +
          `Open Admin → Customers, find their record, and use Anonymise — that removes the ` +
          `person and keeps the permit, install date and payment history.\n\n` +
          `Both app stores expect this to be actioned within 30 days.\n`,
      }).catch(() => undefined);
    }

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (e) {
    return dbErrorResponse(e, 'Sending your deletion request');
  }
}
