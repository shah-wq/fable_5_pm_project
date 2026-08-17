import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';
import { sendEmail } from '@/lib/email';
import { siteOrigin } from '@/lib/site';

/**
 * Portal access for one customer, on top of the existing auth engine. The
 * customer record and the login are separate facts: a customer may exist with
 * no login, and the login row points at the customer. Invite / resend / set a
 * password directly / reset / disable / force logout — all audited, and a
 * disabled login keeps the record and its history intact.
 *
 * PMs may invite and resend; only an admin sets passwords or disables access.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    action?: string;
    password?: string;
    forceChange?: boolean;
  } | null;
  const action = String(body?.action ?? '');
  const adminOnly = ['set_password', 'reset_link', 'disable', 'enable', 'force_logout'];
  if (adminOnly.includes(action) && session.role !== 'admin') {
    return NextResponse.json(
      { error: 'Only an admin can set passwords or change access.' },
      { status: 403 }
    );
  }

  try {
    const customer = await withUser(session, async (client) => {
      const { rows } = await client.query<{
        id: string; email: string | null; name: string; user_id: string | null;
      }>(
        `select c.id, c.email, c.first_name || ' ' || c.last_name as name, c.user_id
         from public.clients c where c.id = $1`,
        [id]
      );
      return rows[0] ?? null;
    });
    if (!customer) return NextResponse.json({ error: 'customer not found' }, { status: 404 });

    const origin = siteOrigin(new URL(request.url).origin);
    const link = (token: string) => `${origin}/auth/update-password?token=${token}`;

    switch (action) {
      case 'invite': {
        if (!customer.email) {
          return NextResponse.json(
            { error: 'Add an email address to this customer first — the invitation goes there.' },
            { status: 400 }
          );
        }
        if (customer.user_id) {
          return NextResponse.json(
            { error: 'This customer already has a login — use Resend invitation or Reset password.' },
            { status: 409 }
          );
        }
        // Customer logins have their own invite path: the staff auth panel is
        // admin-only, but inviting a homeowner is everyday PM work.
        const inviteToken = await withUser(session, async (client) => {
          const { rows } = await client.query<{ customer_portal_invite: string }>(
            `select public.customer_portal_invite($1) as customer_portal_invite`,
            [id]
          );
          return rows[0]?.customer_portal_invite ?? null;
        });
        if (!inviteToken) {
          return NextResponse.json({ error: 'could not create the login' }, { status: 400 });
        }
        await tryLogAuditEvent(session, {
          action: 'customer.portal_invited', entityType: 'clients', entityId: id,
        });
        try {
          await sendEmail({
            to: customer.email,
            subject: 'Track your solar project',
            text: `Hello ${customer.name},\n\nYou can follow your solar installation here — set your password with this link (it works once and expires in 7 days):\n\n${link(inviteToken)}\n`,
          });
        } catch {
          return NextResponse.json({ ok: true, inviteLink: link(inviteToken) });
        }
        return NextResponse.json({ ok: true });
      }

      case 'resend_invite': {
        if (!customer.user_id) {
          return NextResponse.json({ error: 'This customer has no login yet — use Invite.' }, { status: 400 });
        }
        const { rows } = await withUser(session, (c) =>
          c.query<{ token: string }>('select public.customer_portal_resend($1) as token', [id])
        );
        const token = rows[0]?.token;
        if (!token) return NextResponse.json({ error: 'no invitation to resend' }, { status: 400 });
        await tryLogAuditEvent(session, {
          action: 'customer.portal_invite_resent', entityType: 'clients', entityId: id,
        });
        if (!customer.email) return NextResponse.json({ ok: true, inviteLink: link(token) });
        try {
          await sendEmail({
            to: customer.email,
            subject: 'Track your solar project',
            text: `Set your password here (works once, expires in 7 days):\n\n${link(token)}\n`,
          });
        } catch {
          return NextResponse.json({ ok: true, inviteLink: link(token) });
        }
        return NextResponse.json({ ok: true });
      }

      case 'set_password': {
        // Works whether or not they already have a login: the function creates
        // one for a customer who has never been invited, which is the answer for
        // 'they are on the phone now and want to see their project'.
        if (!customer.email) {
          return NextResponse.json(
            { error: 'Add an email address to this customer first — it is their login name.' },
            { status: 400 }
          );
        }
        if ((body?.password?.length ?? 0) < 10) {
          return NextResponse.json(
            { error: 'The password must be at least 10 characters.' },
            { status: 400 }
          );
        }
        await withUser(session, (c) =>
          c.query('select public.customer_portal_set_initial_password($1, $2, $3)',
            [id, body!.password, body?.forceChange ?? true])
        );
        await tryLogAuditEvent(session, {
          action: 'customer.portal_password_set', entityType: 'clients', entityId: id,
        });
        return NextResponse.json({ ok: true });
      }

      case 'reset_link': {
        if (!customer.email) return NextResponse.json({ error: 'no email on file' }, { status: 400 });
        const { rows } = await withUser(session, (c) =>
          c.query<{ recovery_token: string }>('select * from auth.request_recovery($1)', [customer.email])
        );
        const token = rows[0]?.recovery_token;
        if (!token) return NextResponse.json({ error: 'no login for this customer' }, { status: 400 });
        await tryLogAuditEvent(session, {
          action: 'customer.portal_reset_sent', entityType: 'clients', entityId: id,
        });
        try {
          await sendEmail({
            to: customer.email,
            subject: 'Reset your SolarFlow password',
            text: `Set a new password here (expires in 1 hour):\n\n${link(token)}\n`,
          });
        } catch {
          return NextResponse.json({ ok: true, resetLink: link(token) });
        }
        return NextResponse.json({ ok: true });
      }

      case 'disable':
      case 'enable': {
        if (!customer.user_id) {
          return NextResponse.json({ error: 'This customer has no login.' }, { status: 400 });
        }
        await withUser(session, async (client) => {
          await client.query(`update public.profiles set is_active = $2 where id = $1`,
            [customer.user_id, action === 'enable']);
          if (action === 'disable') {
            await client.query('select auth.admin_force_logout($1)', [customer.user_id]);
          }
        });
        await tryLogAuditEvent(session, {
          action: action === 'disable' ? 'customer.portal_disabled' : 'customer.portal_enabled',
          entityType: 'clients',
          entityId: id,
        });
        return NextResponse.json({ ok: true });
      }

      case 'force_logout': {
        if (!customer.user_id) {
          return NextResponse.json({ error: 'This customer has no login.' }, { status: 400 });
        }
        await withUser(session, (c) => c.query('select auth.admin_force_logout($1)', [customer.user_id]));
        await tryLogAuditEvent(session, {
          action: 'customer.portal_logged_out', entityType: 'clients', entityId: id,
        });
        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json({ error: 'unknown action' }, { status: 400 });
    }
  } catch (e) {
    return dbErrorResponse(e, 'Updating portal access');
  }
}
