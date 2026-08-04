import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { ROLE_HOME } from '@/lib/auth/roles';
import { withUser } from '@/lib/db';

/**
 * Self-service password change (every role): current + new. The database
 * function verifies the current password, keeps this session, revokes every
 * other one, and clears any force-change flag.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session || !session.isActive) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    current?: string;
    password?: string;
  } | null;
  if (!body?.current || !body?.password) {
    return NextResponse.json({ error: 'current and new password are required' }, { status: 400 });
  }

  try {
    await withUser(session, (c) =>
      c.query('select auth.change_password($1, $2, $3)', [
        body.current,
        body.password,
        session.token,
      ])
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('current password')) {
      return NextResponse.json({ error: 'Current password is incorrect.' }, { status: 400 });
    }
    if (message.includes('at least 8')) {
      return NextResponse.json({ error: 'Use at least 8 characters.' }, { status: 400 });
    }
    throw error;
  }

  return NextResponse.json({ redirect: ROLE_HOME[session.role] });
}
