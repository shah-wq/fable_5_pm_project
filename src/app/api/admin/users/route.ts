import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import type { UserRole } from '@/lib/auth/roles';
import { withUser } from '@/lib/db';
import { sendEmail } from '@/lib/email';
import { siteOrigin } from '@/lib/site';

interface CreateUserPayload {
  mode?: 'password' | 'invite';
  email?: string;
  role?: UserRole;
  fullName?: string;
  phone?: string;
  password?: string;
  forceChange?: boolean;
  dealerId?: string;
  clientId?: string;
}

/**
 * Admin panel §1.1 — add a user, either with an admin-set password (works
 * immediately, force-change on by default) or by invitation email. Role
 * linking: dealer logins attach to a dealer company, customer logins to a
 * client record, designers get a designers row.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (session.role !== 'admin' || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const p = (await request.json().catch(() => null)) as CreateUserPayload | null;
  const email = p?.email?.trim().toLowerCase();
  const mode = p?.mode === 'password' ? 'password' : 'invite';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'a valid email is required' }, { status: 400 });
  }
  if (!p?.role) return NextResponse.json({ error: 'role is required' }, { status: 400 });
  if (mode === 'password' && (p?.password?.length ?? 0) < 8) {
    return NextResponse.json({ error: 'password must be at least 8 characters' }, { status: 400 });
  }
  if (p.role === 'dealer' && !p.dealerId) {
    return NextResponse.json({ error: 'select the dealer company to link' }, { status: 400 });
  }
  if (p.role === 'customer' && !p.clientId) {
    return NextResponse.json({ error: 'select the client record to link' }, { status: 400 });
  }

  let created: { user_id: string; invite_token: string | null };
  try {
    const { rows } = await withUser(session, (c) =>
      c.query<{ user_id: string; invite_token: string | null }>(
        'select * from auth.admin_create_user($1, $2, $3, $4, $5, $6)',
        [
          email,
          p.role,
          p.fullName ?? null,
          p.phone ?? null,
          mode === 'password' ? p.password : null,
          p.forceChange ?? true,
        ]
      )
    );
    created = rows[0];
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      return NextResponse.json({ error: 'a user with this email already exists' }, { status: 409 });
    }
    throw error;
  }

  // Role linking, as the admin (RLS + audit triggers apply).
  if (p.role === 'dealer') {
    await withUser(session, (c) =>
      c.query('insert into public.dealer_users (dealer_id, user_id) values ($1, $2)', [
        p.dealerId,
        created.user_id,
      ])
    );
  }
  if (p.role === 'customer') {
    await withUser(session, (c) =>
      c.query('update public.clients set user_id = $1 where id = $2', [
        created.user_id,
        p.clientId,
      ])
    );
  }
  if (p.role === 'designer') {
    await withUser(session, (c) =>
      c.query(
        `insert into public.designers (user_id, display_name)
         values ($1, $2) on conflict (user_id) do nothing`,
        [created.user_id, p.fullName ?? email.split('@')[0]]
      )
    );
  }

  // Invitation email (invite mode).
  let emailSent: boolean | undefined;
  let inviteLink: string | undefined;
  if (created.invite_token) {
    inviteLink = `${siteOrigin(new URL(request.url).origin)}/auth/update-password?token=${created.invite_token}`;
    try {
      await sendEmail({
        to: email,
        subject: "You've been invited to SolarFlow",
        text: `You've been invited to SolarFlow as ${p.role}.\n\nSet your password here (link works once, expires in 7 days):\n${inviteLink}`,
      });
      emailSent = true;
    } catch (error) {
      console.error('invite email failed:', error);
      emailSent = false;
    }
  }

  await tryLogAuditEvent(session, {
    action: 'user.invited',
    entityType: 'profiles',
    entityId: created.user_id,
    context: { email, role: p.role, mode },
  });

  return NextResponse.json(
    {
      userId: created.user_id,
      ...(emailSent === undefined ? {} : { emailSent }),
      ...(emailSent === false && inviteLink ? { inviteLink } : {}),
    },
    { status: 201 }
  );
}
