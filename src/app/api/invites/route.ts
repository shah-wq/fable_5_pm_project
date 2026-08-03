import { NextResponse } from 'next/server';
import { logAuditEvent } from '@/lib/audit';
import type { UserRole } from '@/lib/auth/roles';
import { createServiceClient, createSupabaseServer } from '@/lib/supabase/server';

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
 * the same endpoint is what project creation and lead conversion call to
 * auto-invite the homeowner). Supabase emails the invite link; it lands on
 * /auth/callback and then /auth/update-password (staff/dealer) or /portal
 * (customers, who use OTP and never set a password).
 *
 * Role assignment happens with the ADMIN'S OWN session (not the service
 * key), so the in-database guard applies and the audit trigger records the
 * real actor.
 */
export async function POST(request: Request) {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // Middleware already gates /api/invites to admins; re-check here so the
  // route stands on its own.
  const { data: me } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (me?.role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const payload = (await request.json().catch(() => null)) as InvitePayload | null;
  const email = payload?.email?.trim().toLowerCase();
  const role = payload?.role;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'a valid email is required' }, { status: 400 });
  }
  if (!role || !INVITABLE_ROLES.includes(role)) {
    return NextResponse.json({ error: 'role must be one of ' + INVITABLE_ROLES.join(', ') }, { status: 400 });
  }
  if (role === 'dealer' && !payload?.dealerId) {
    return NextResponse.json({ error: 'dealerId is required for dealer invites' }, { status: 400 });
  }
  if (role === 'customer' && !payload?.projectId) {
    return NextResponse.json({ error: 'projectId is required for customer invites' }, { status: 400 });
  }

  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(request.url).origin;
  const landing = role === 'customer' ? '/portal' : '/auth/update-password';

  const service = createServiceClient();
  const { data: invited, error: inviteError } = await service.auth.admin.inviteUserByEmail(email, {
    data: payload?.fullName ? { full_name: payload.fullName } : undefined,
    redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(landing)}`,
  });
  if (inviteError || !invited.user) {
    const already = /already/i.test(inviteError?.message ?? '');
    return NextResponse.json(
      { error: already ? 'a user with this email already exists' : 'invite failed' },
      { status: already ? 409 : 502 }
    );
  }
  const invitedId = invited.user.id;

  // Everything below runs as the admin: RLS + the role-change guard apply,
  // and the profiles audit trigger records the admin as the actor.
  if (role !== 'customer') {
    const { error: roleError } = await supabase
      .from('profiles')
      .update({ role, full_name: payload?.fullName ?? null })
      .eq('id', invitedId);
    if (roleError) {
      return NextResponse.json({ error: 'user created but role assignment failed' }, { status: 502 });
    }
  }

  if (role === 'dealer') {
    const { error } = await supabase
      .from('dealer_users')
      .insert({ dealer_id: payload!.dealerId!, user_id: invitedId });
    if (error) {
      return NextResponse.json({ error: 'user created but dealer link failed' }, { status: 502 });
    }
  }

  if (role === 'designer') {
    const { error } = await supabase.from('designers').insert({
      user_id: invitedId,
      display_name: payload?.fullName ?? email.split('@')[0],
    });
    if (error) {
      return NextResponse.json({ error: 'user created but designer record failed' }, { status: 502 });
    }
  }

  if (role === 'customer') {
    const { data: project } = await supabase
      .from('projects')
      .select('client_id')
      .eq('id', payload!.projectId!)
      .single();
    if (!project) {
      return NextResponse.json({ error: 'project not found' }, { status: 404 });
    }
    const { error } = await supabase
      .from('clients')
      .update({ user_id: invitedId })
      .eq('id', project.client_id);
    if (error) {
      return NextResponse.json({ error: 'user created but client link failed' }, { status: 502 });
    }
  }

  await logAuditEvent(supabase, {
    action: 'user.invited',
    entityType: 'profiles',
    entityId: invitedId,
    projectId: role === 'customer' ? payload!.projectId! : undefined,
    context: { email, role, dealer_id: payload?.dealerId ?? null },
  }).catch(() => undefined);

  return NextResponse.json({ userId: invitedId }, { status: 201 });
}
