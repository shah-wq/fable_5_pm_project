import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { setSessionCookie } from '@/lib/auth/cookies';
import {
  LOGIN_DOORS,
  ROLE_HOME,
  roleToLandingRoute,
  type DoorId,
  type UserRole,
} from '@/lib/auth/roles';
import { withAnon } from '@/lib/db';
import { isAppShell } from '@/lib/native/shell';
import { siteUrl } from '@/lib/site';

interface SignInRow {
  outcome: 'ok' | 'invalid' | 'disabled' | 'locked';
  user_id: string | null;
  session_token: string | null;
  user_role: UserRole | null;
  full_name: string | null;
  force_password_change: boolean;
  delay_ms: number;
  retry_after: number;
}

/**
 * The one login endpoint (Sign-in Screens §5).
 *
 * All three sign-in pages post here, and everything that decides an outcome
 * happens once: one call to auth.sign_in(), one rate limiter, one routing
 * function. The `door` field says which page was used — and is used for nothing
 * but the wording of the reply.
 *
 * §5, the rule that makes three doors safe rather than confusing: right
 * credentials on the wrong page are signed in and taken to their own surface.
 * The old behaviour — sign them out again and show them a link — punished
 * somebody who typed a correct password for a layout decision they had no part
 * in. A homeowner who lands on the staff page has proved who they are; the only
 * sensible response is to take them where they were going.
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
  const door: DoorId = body?.door && body.door in LOGIN_DOORS ? body.door : 'staff';
  if (!email || !password) {
    return NextResponse.json({ error: 'Enter your email and password.' }, { status: 400 });
  }

  const result = await signIn(email, password, clientIp(request));

  // 'invalid' with a retry time means that attempt was the one that closed the
  // door: report the lockout now rather than a generic failure the user will
  // retype, hit the wall on, and not understand.
  if (result.outcome === 'locked' || result.retry_after > 0) {
    const seconds = result.retry_after || 900;
    return NextResponse.json(
      {
        error: `Too many sign-in attempts. Try again in ${minutes(seconds)}, or reset your password to get straight back in.`,
      },
      { status: 429, headers: { 'retry-after': String(seconds) } }
    );
  }

  if (result.outcome === 'invalid') {
    // The progressive delay from §5. Applied here rather than in SQL so a
    // database connection is not held open doing nothing — the cost lands on
    // the request that earned it.
    if (result.delay_ms > 0) await sleep(result.delay_ms);
    // §5: one generic message, identical for an unknown address and a wrong
    // password. Anything more specific tells a stranger whether an address
    // belongs to a customer of this business, and which role it holds.
    return NextResponse.json({ error: "That email and password don't match." }, { status: 401 });
  }

  if (result.outcome === 'disabled') {
    // §5 wants this one said plainly: "the user needs to know it is not their
    // typing". Reaching it requires the correct password, so it reveals nothing
    // to anybody guessing.
    return NextResponse.json(
      { error: 'This account has been disabled. Contact your administrator.' },
      { status: 403 }
    );
  }

  const role = result.user_role as UserRole;
  const token = result.session_token as string;

  // §6: the store app is a homeowner product. Staff and dealer credentials are
  // correct — they are simply not for this app — so the session is dropped again
  // and the reply points at the web address rather than pretending to fail.
  if (role !== 'customer' && (await isAppShell())) {
    await withAnon((c) => c.query('select auth.logout($1)', [token]));
    return NextResponse.json(
      {
        error:
          `This app shows a homeowner their own installation. Staff and dealer accounts sign in ` +
          `on the web at ${siteUrl()}${ROLE_HOME[role]}.`,
      },
      { status: 403 }
    );
  }

  await tryLogAuditEvent(
    { userId: result.user_id as string, email, role },
    { action: 'auth.signed_in', entityType: 'profiles', entityId: result.user_id as string }
  );

  const redirect = roleToLandingRoute(role, {
    next: body?.next,
    forcePasswordChange: result.force_password_change,
  });

  // Used on the wrong page? Say so on the way through — one short line, not a
  // refusal. Silence would be defensible, but on a shared computer somebody
  // typing colleague-adjacent details deserves to see who they signed in as.
  const wrongDoor = !LOGIN_DOORS[door].roles.includes(role);
  const response = NextResponse.json({
    redirect,
    note: wrongDoor && !result.force_password_change ? noteFor(role) : null,
  });
  setSessionCookie(response, token);
  return response;
}

/**
 * One call to the database — with one fallback, for the window between the code
 * shipping and somebody pasting 003000 into the SQL editor.
 *
 * Every other module degrades in that window by hiding a panel. This one cannot:
 * if the new function is missing and the route throws, nobody can sign in to
 * anything, including the admin who needs to get in and run the file. So a
 * missing auth.sign_in falls back to the previous path, which every database has
 * had since 001300 — the same credential check and the same account lockout,
 * without the per-IP counter and the progressive delay. The rate limiter arrives
 * with the migration; the door stays open in the meantime.
 */
async function signIn(email: string, password: string, ip: string | null): Promise<SignInRow> {
  try {
    const { rows } = await withAnon((c) =>
      c.query<SignInRow>('select * from auth.sign_in($1, $2, $3)', [email, password, ip])
    );
    if (rows[0]) return rows[0];
  } catch (error) {
    // 42883 undefined_function — anything else is a real failure and should
    // surface as one rather than being quietly downgraded.
    if ((error as { code?: string }).code !== '42883') throw error;
  }

  const { rows } = await withAnon((c) =>
    c.query<{
      user_id: string;
      session_token: string | null;
      user_role: UserRole;
      is_active: boolean;
      full_name: string | null;
      force_password_change: boolean;
    }>('select * from auth.login_with_password($1, $2)', [email, password])
  );
  const row = rows[0];
  const blank = { delay_ms: 0, retry_after: 0 };
  if (!row) {
    return { outcome: 'invalid', user_id: null, session_token: null, user_role: null,
             full_name: null, force_password_change: false, ...blank };
  }
  if (!row.is_active || !row.session_token) {
    return { outcome: 'disabled', user_id: row.user_id, session_token: null,
             user_role: row.user_role, full_name: row.full_name,
             force_password_change: false, ...blank };
  }
  return {
    outcome: 'ok',
    user_id: row.user_id,
    session_token: row.session_token,
    user_role: row.user_role,
    full_name: row.full_name,
    force_password_change: row.force_password_change,
    ...blank,
  };
}

/** 'Signed in — taking you to your project.' (§5) */
function noteFor(role: UserRole): string {
  if (role === 'customer') return 'Signed in — taking you to your project.';
  if (role === 'dealer') return 'Signed in — taking you to your dealer portal.';
  return 'Signed in — taking you to the staff pipeline.';
}

/**
 * The caller's address, for the per-IP half of the rate limiter.
 *
 * Behind Vercel the left-most x-forwarded-for hop is the client; the header is
 * forgeable in general, which is why it throttles rather than authorizes. A
 * spoofed value costs an attacker their own rate limit and nothing else, and the
 * per-account counter is unaffected by it.
 */
function clientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() || null;
  return request.headers.get('x-real-ip')?.trim() || null;
}

function minutes(seconds: number): string {
  const m = Math.max(1, Math.ceil(seconds / 60));
  return m === 1 ? 'a minute' : `${m} minutes`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(8000, ms)));
}
