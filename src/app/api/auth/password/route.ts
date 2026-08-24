import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { setSessionCookie } from '@/lib/auth/cookies';
import { roleToLandingRoute, type UserRole } from '@/lib/auth/roles';
import { withAnon } from '@/lib/db';

interface SetPasswordRow {
  user_id: string;
  session_token: string | null;
  user_role: UserRole;
  full_name: string | null;
}

/**
 * Finishes both invite-accept and password recovery: consumes the one-time
 * token, sets the password, revokes every other session, signs the user in.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    token?: string;
    password?: string;
  } | null;

  const token = body?.token?.trim();
  const password = body?.password ?? '';
  if (!token || !password) {
    return NextResponse.json({ error: 'token and password are required' }, { status: 400 });
  }

  let row: SetPasswordRow | undefined;
  try {
    const { rows } = await withAnon((c) =>
      c.query<SetPasswordRow>('select * from auth.set_password_with_token($1, $2)', [
        token,
        password,
      ])
    );
    row = rows[0];
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('at least 10 characters')) {
      return NextResponse.json({ error: 'Use at least 10 characters.' }, { status: 400 });
    }
    throw error;
  }

  if (!row?.session_token) {
    return NextResponse.json(
      { error: 'This link is invalid or has expired. Request a new one.' },
      { status: 410 }
    );
  }

  await tryLogAuditEvent(
    { userId: row.user_id, email: null, role: row.user_role },
    { action: 'auth.password_set', entityType: 'profiles', entityId: row.user_id }
  );

  // One routing function, here as everywhere (§9): setting a password signs the
  // user in, so where they go next is the same decision the login endpoint makes.
  const response = NextResponse.json({ redirect: roleToLandingRoute(row.user_role) });
  setSessionCookie(response, row.session_token);
  return response;
}
