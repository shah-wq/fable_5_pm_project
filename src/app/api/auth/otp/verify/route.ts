import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { setSessionCookie } from '@/lib/auth/cookies';
import { ROLE_HOME, sanitizeNextPath, type UserRole } from '@/lib/auth/roles';
import { withAnon } from '@/lib/db';

interface VerifyRow {
  user_id: string;
  session_token: string;
  user_role: UserRole;
  full_name: string | null;
}

/** Customer OTP, step 2: verify the 6-digit code and start a session. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    email?: string;
    code?: string;
    next?: string;
  } | null;

  const email = body?.email?.trim();
  const code = body?.code?.trim();
  if (!email || !code) {
    return NextResponse.json({ error: 'email and code are required' }, { status: 400 });
  }

  const { rows } = await withAnon((c) =>
    c.query<VerifyRow>('select * from auth.verify_otp($1, $2)', [email, code])
  );
  const row = rows[0];
  if (!row?.session_token) {
    return NextResponse.json(
      { error: 'That code is incorrect or expired. Request a new one.' },
      { status: 401 }
    );
  }

  await tryLogAuditEvent(
    { userId: row.user_id, email, role: row.user_role },
    { action: 'auth.signed_in', entityType: 'profiles', entityId: row.user_id }
  );

  const response = NextResponse.json({
    redirect: sanitizeNextPath(body?.next) ?? ROLE_HOME[row.user_role],
  });
  setSessionCookie(response, row.session_token);
  return response;
}
