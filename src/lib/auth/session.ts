import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { withAnon } from '../db';
import { SESSION_COOKIE } from './constants';
import { ROLE_HOME, accessForPath, doorForPath, type UserRole } from './roles';

export interface Session {
  userId: string;
  email: string | null;
  role: UserRole;
  isActive: boolean;
  fullName: string | null;
  token: string;
}

interface SessionRow {
  user_id: string;
  email: string | null;
  user_role: UserRole;
  is_active: boolean;
  full_name: string | null;
}

/**
 * Resolve the request's session cookie against auth.sessions. Role and
 * is_active come from profiles at call time, so role changes and
 * deactivations take effect on the very next request.
 */
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const { rows } = await withAnon((c) =>
    c.query<SessionRow>('select * from auth.validate_session($1)', [token])
  );
  const row = rows[0];
  if (!row) return null;

  return {
    userId: row.user_id,
    email: row.email,
    role: row.user_role,
    isActive: row.is_active,
    fullName: row.full_name,
    token,
  };
}

/**
 * Server-side gate for a surface. Redirects anonymous visitors to the right
 * login door (with a safe `next`), kicks deactivated accounts out entirely,
 * and sends wrong-role visitors to their own home. ROUTE_ACCESS (roles.ts)
 * stays the single source of truth via guardPath().
 */
export async function requireRole(
  allowed: readonly UserRole[],
  currentPath: string
): Promise<Session> {
  const session = await getSession();
  if (!session) {
    redirect(`${doorForPath(currentPath).path}?next=${encodeURIComponent(currentPath)}`);
  }
  if (!session.isActive) {
    redirect('/auth/signout?reason=deactivated');
  }
  if (!allowed.includes(session.role)) {
    redirect(ROLE_HOME[session.role]);
  }
  return session;
}

/** requireRole() driven by the ROUTE_ACCESS table. */
export async function guardPath(currentPath: string): Promise<Session> {
  const allowed = accessForPath(currentPath);
  if (!allowed) {
    throw new Error(`guardPath: no ROUTE_ACCESS entry covers ${currentPath}`);
  }
  return requireRole(allowed, currentPath);
}
