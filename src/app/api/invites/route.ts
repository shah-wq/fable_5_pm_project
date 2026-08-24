import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import type { UserRole } from '@/lib/auth/roles';
import { withUser } from '@/lib/db';
import { sendEmail } from '@/lib/email';
import { siteOrigin } from '@/lib/site';

const INVITABLE_ROLES: readonly UserRole[] = [
  'admin',
  'ops',
  'designer',
  'finance',
  'dealer',
  'customer',
];

interface InvitePayload {
  email?: string;
  role?: UserRole;
  fullName?: string;
  /** Required when role = 'dealer': which dealer org the login belongs to. */
  dealerId?: string;
  /** Required when role = 'customer': links the login to that project's client. */
  projectId?: string;
}

/**
 * ADM-02: admin invites Ops / Designer / Finance / Dealer (and Customer —
 * project creation and lead conversion call the same endpoint to auto-invite
 * the homeowner). Everyone receives the same thing: a 7-day, single-use link to
 * set their own password. Homeowners used to get a welcome email pointing at an
 * emailed-code door instead; that door is gone (002600) and they now have
 * passwords like everybody else.
 *
 * User creation and linking run with the ADMIN'S OWN claims, so the
 * in-database guards apply and the audit triggers record the real actor.
 * If email delivery fails, the invite link is returned in the response so
 * the admin can pass it along manually.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (session.role !== 'admin' || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const payload = (await request.json().catch(() => null)) as InvitePayload | null;
  const email = payload?.email?.trim().toLowerCase();
  const role = payload?.role;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'a valid email is required' }, { status: 400 });
  }
  if (!role || !INVITABLE_ROLES.includes(role)) {
    return NextResponse.json(
      { error: 'role must be one of ' + INVITABLE_ROLES.join(', ') },
      { status: 400 }
    );
  }
  if (role === 'dealer' && !payload?.dealerId) {
    return NextResponse.json({ error: 'dealerId is required for dealer invites' }, { status: 400 });
  }
  if (role === 'customer' && !payload?.projectId) {
    return NextResponse.json({ error: 'projectId is required for customer invites' }, { status: 400 });
  }

  let invited: { user_id: string; invite_token: string | null };
  try {
    const { rows } = await withUser(session, (c) =>
      c.query<{ user_id: string; invite_token: string | null }>(
        'select * from auth.create_invited_user($1, $2, $3)',
        [email, role, payload?.fullName ?? null]
      )
    );
    invited = rows[0];
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      return NextResponse.json({ error: 'a user with this email already exists' }, { status: 409 });
    }
    throw error;
  }

  // Role-specific linking, as the admin (RLS + audit triggers apply).
  if (role === 'dealer') {
    await withUser(session, (c) =>
      c.query('insert into public.dealer_users (dealer_id, user_id) values ($1, $2)', [
        payload!.dealerId,
        invited.user_id,
      ])
    );
  }

  if (role === 'designer') {
    await withUser(session, (c) =>
      c.query('insert into public.designers (user_id, display_name) values ($1, $2)', [
        invited.user_id,
        payload?.fullName ?? email.split('@')[0],
      ])
    );
  }

  if (role === 'customer') {
    const linked = await withUser(session, async (c) => {
      const project = await c.query<{ client_id: string }>(
        'select client_id from public.projects where id = $1',
        [payload!.projectId]
      );
      if (!project.rows[0]) return false;
      await c.query('update public.clients set user_id = $1 where id = $2', [
        invited.user_id,
        project.rows[0].client_id,
      ]);
      return true;
    });
    if (!linked) {
      return NextResponse.json({ error: 'project not found' }, { status: 404 });
    }
  }

  // Notification email.
  const origin = siteOrigin(new URL(request.url).origin);
  const inviteLink = invited.invite_token
    ? `${origin}/auth/update-password?token=${invited.invite_token}`
    : null;
  let emailSent = true;
  try {
    if (inviteLink && role === 'customer') {
      // A homeowner is not an employee being onboarded: say what the app is for.
      await sendEmail({
        to: email,
        subject: 'Track your solar project',
        text:
          `Your solar project portal is ready.\n\n` +
          `Choose a password here (the link works once and expires in 7 days):\n${inviteLink}\n\n` +
          `After that you can sign in any time at ${origin}/login/homeowner to see where your ` +
          `installation stands, what happens next, and your documents.\n`,
      });
    } else if (inviteLink) {
      await sendEmail({
        to: email,
        subject: "You've been invited to SolarFlow",
        text: `You've been invited to SolarFlow as ${role}.\n\nSet your password here (link works once, expires in 7 days):\n${inviteLink}`,
      });
    } else {
      await sendEmail({
        to: email,
        subject: 'Your SolarFlow account is ready',
        text: `Your account is ready. Sign in at ${origin}/login with the password you were given.`,
      });
    }
  } catch (error) {
    console.error('invite email failed:', error);
    emailSent = false;
  }

  await tryLogAuditEvent(session, {
    action: 'user.invited',
    entityType: 'profiles',
    entityId: invited.user_id,
    projectId: role === 'customer' ? payload!.projectId : undefined,
    context: { email, role, dealer_id: payload?.dealerId ?? null, email_sent: emailSent },
  });

  return NextResponse.json(
    {
      userId: invited.user_id,
      emailSent,
      // Surfaced so an admin can hand the link over when SMTP is down.
      ...(emailSent ? {} : inviteLink ? { inviteLink } : {}),
    },
    { status: 201 }
  );
}
