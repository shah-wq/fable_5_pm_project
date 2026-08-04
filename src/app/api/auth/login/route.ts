import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { setSessionCookie } from '@/lib/auth/cookies';
import {
  LOGIN_DOORS,
  ROLE_HOME,
  doorForRole,
  sanitizeNextPath,
  type DoorId,
  type UserRole,
} from '@/lib/auth/roles';
import { withAnon } from '@/lib/db';

interface LoginRow {
  user_id: string;
  session_token: string | null;
  user_role: UserRole;
  is_active: boolean;
  full_name: string | null;
  force_password_change: boolean;
}

/**
 * Password door (staff + dealer). The destination is decided by
 * profiles.role AFTER authentication; valid credentials at the wrong door
 * are signed straight back out with a pointer to the right one. Bad email,
 * bad password, and lockout all produce the same 401.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    email?: string;
    password?: string;
    door?: DoorId;
    next?: string;
  } | null;

  const email = body?.email?.trim();
  const password = body?.password ?? '';
  const door = body?.door && body.door in LOGIN_DOORS ? body.door : null;
  if (!email || !password || !door) {
    return NextResponse.json({ error: 'email, password, and door are required' }, { status: 400 });
  }

  const { rows } = await withAnon((c) =>
    c.query<LoginRow>('select * from auth.login_with_password($1, $2)', [email, password])
  );
  const row = rows[0];

  if (!row) {
    return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 });
  }

  if (!row.is_active || !row.session_token) {
    return NextResponse.json(
      { error: 'This account has been deactivated. Contact your administrator.' },
      { status: 403 }
    );
  }

  if (!LOGIN_DOORS[door].roles.includes(row.user_role)) {
    await withAnon((c) => c.query('select auth.logout($1)', [row.session_token]));
    const rightDoor = doorForRole(row.user_role);
    return NextResponse.json(
      {
        error: 'wrong_door',
        doorPath: rightDoor.path,
        doorLabel: rightDoor.label,
      },
      { status: 403 }
    );
  }

  await tryLogAuditEvent(
    { userId: row.user_id, email, role: row.user_role },
    { action: 'auth.signed_in', entityType: 'profiles', entityId: row.user_id }
  );

  const response = NextResponse.json({
    redirect: row.force_password_change
      ? '/auth/change-password?forced=1'
      : (sanitizeNextPath(body?.next) ?? ROLE_HOME[row.user_role]),
  });
  setSessionCookie(response, row.session_token);
  return response;
}
