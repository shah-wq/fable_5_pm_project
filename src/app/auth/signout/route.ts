import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE } from '@/lib/auth/constants';
import { clearSessionCookie } from '@/lib/auth/cookies';
import { withAnon } from '@/lib/db';

async function signOut(request: Request, redirectTo: string) {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await withAnon((c) => c.query('select auth.logout($1)', [token])).catch(() => undefined);
  }
  const response = NextResponse.redirect(new URL(redirectTo, request.url), { status: 303 });
  clearSessionCookie(response);
  return response;
}

export async function POST(request: Request) {
  return signOut(request, '/login');
}

/** Used by server-side gates (e.g. a deactivated profile mid-session). */
export async function GET(request: Request) {
  const reason = new URL(request.url).searchParams.get('reason');
  return signOut(
    request,
    reason === 'deactivated' ? '/login?error=account_disabled' : '/login'
  );
}
