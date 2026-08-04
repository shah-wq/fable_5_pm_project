import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession, type Session } from '@/lib/auth/session';
import type { UserRole } from '@/lib/auth/roles';
import { withUser } from '@/lib/db';
import { sendEmail } from '@/lib/email';
import { siteOrigin } from '@/lib/site';

async function gate(): Promise<Session | NextResponse> {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (session.role !== 'admin' || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return session;
}

/** Edit details / role / active status. Role changes and disables are audited
 *  by the profiles triggers with old → new values. */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await gate();
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;

  const p = (await request.json().catch(() => null)) as {
    fullName?: string;
    phone?: string;
    role?: UserRole;
    isActive?: boolean;
  } | null;

  const sets: string[] = [];
  const vals: unknown[] = [id];
  const add = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (p?.fullName !== undefined) add('full_name', p.fullName || null);
  if (p?.phone !== undefined) add('phone', p.phone || null);
  if (p?.role !== undefined) add('role', p.role);
  if (p?.isActive !== undefined) add('is_active', p.isActive);
  if (sets.length === 0) return NextResponse.json({ error: 'nothing to save' }, { status: 400 });

  const { rowCount } = await withUser(session, (c) =>
    c.query(`update public.profiles set ${sets.join(', ')} where id = $1 and deleted_at is null`, vals)
  );
  if (!rowCount) return NextResponse.json({ error: 'user not found' }, { status: 404 });

  // Disabling blocks the next request; also kill live sessions immediately.
  if (p?.isActive === false) {
    await withUser(session, (c) => c.query('select auth.admin_force_logout($1)', [id]));
  }
  return NextResponse.json({ ok: true });
}

/** §1.3 delete — guarded by typed-email confirmation; the database function
 *  scrubs credentials/PII, keeps every reference, and protects the last admin. */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await gate();
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;

  const p = (await request.json().catch(() => null)) as { confirmEmail?: string } | null;

  const target = await withUser(session, (c) =>
    c.query<{ email: string | null }>(
      'select email from public.profiles where id = $1 and deleted_at is null',
      [id]
    )
  );
  const email = target.rows[0]?.email;
  if (email === undefined) return NextResponse.json({ error: 'user not found' }, { status: 404 });
  if (!p?.confirmEmail || p.confirmEmail.trim().toLowerCase() !== (email ?? '').toLowerCase()) {
    return NextResponse.json(
      { error: "Type the user's email exactly to confirm deletion." },
      { status: 400 }
    );
  }

  try {
    await withUser(session, (c) => c.query('select auth.admin_delete_user($1)', [id]));
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('only remaining admin')) {
      return NextResponse.json({ error: 'Cannot delete the only remaining admin.' }, { status: 409 });
    }
    throw error;
  }
  return NextResponse.json({ ok: true });
}

/** Row actions: set password, send reset link, force logout, resend/cancel invite. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await gate();
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;

  const p = (await request.json().catch(() => null)) as {
    action?: string;
    password?: string;
    forceChange?: boolean;
    email?: string;
  } | null;

  switch (p?.action) {
    case 'set_password': {
      if ((p.password?.length ?? 0) < 8) {
        return NextResponse.json({ error: 'password must be at least 8 characters' }, { status: 400 });
      }
      await withUser(session, (c) =>
        c.query('select auth.admin_set_password($1, $2, $3)', [id, p.password, p.forceChange ?? true])
      );
      return NextResponse.json({ ok: true });
    }
    case 'reset_link': {
      const { rows } = await withUser(session, (c) =>
        c.query<{ email: string | null }>('select email from public.profiles where id = $1', [id])
      );
      const email = rows[0]?.email;
      if (!email) return NextResponse.json({ error: 'user has no email' }, { status: 400 });
      const token = await withUser(session, (c) =>
        c.query<{ recovery_token: string }>('select * from auth.request_recovery($1)', [email])
      );
      if (!token.rows[0]) {
        return NextResponse.json({ error: 'recovery not available for this account' }, { status: 400 });
      }
      const link = `${siteOrigin(new URL(request.url).origin)}/auth/update-password?token=${token.rows[0].recovery_token}`;
      try {
        await sendEmail({
          to: email,
          subject: 'Reset your SolarFlow password',
          text: `Follow this link to set a new password (expires in 1 hour):\n\n${link}`,
        });
      } catch {
        return NextResponse.json({ error: 'email failed', resetLink: link }, { status: 502 });
      }
      await tryLogAuditEvent(session, {
        action: 'user.reset_link_sent',
        entityType: 'profiles',
        entityId: id,
      });
      return NextResponse.json({ ok: true });
    }
    case 'force_logout':
      await withUser(session, (c) => c.query('select auth.admin_force_logout($1)', [id]));
      return NextResponse.json({ ok: true });
    case 'resend_invite': {
      const { rows } = await withUser(session, (c) =>
        c.query<{ invite_token: string }>('select * from auth.admin_resend_invite($1)', [id])
      );
      const emailTo = p.email?.trim();
      const link = `${siteOrigin(new URL(request.url).origin)}/auth/update-password?token=${rows[0].invite_token}`;
      if (emailTo) {
        try {
          await sendEmail({
            to: emailTo,
            subject: "You've been invited to SolarFlow",
            text: `Set your password here (link works once, expires in 7 days):\n${link}`,
          });
          return NextResponse.json({ ok: true });
        } catch {
          return NextResponse.json({ error: 'email failed', inviteLink: link }, { status: 502 });
        }
      }
      return NextResponse.json({ ok: true, inviteLink: link });
    }
    case 'cancel_invite':
      await withUser(session, (c) => c.query('select auth.admin_cancel_invite($1)', [id]));
      return NextResponse.json({ ok: true });
    default:
      return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  }
}
