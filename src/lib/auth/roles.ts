/**
 * The single routing truth. Middleware, login forms, and the auth routes all
 * decide destinations from this file — never from which page a user signed
 * in on or anything the client claims.
 *
 * Must stay in sync with the public.user_role enum (db/migrations).
 */

export type UserRole = 'admin' | 'ops' | 'designer' | 'customer' | 'dealer' | 'finance';

/** Where each role lands after login (and gets sent when caught elsewhere).
 *  Manual version: the admin operates the pipeline day-to-day, so it is their
 *  home too; /admin stays one click away in the header. */
export const ROLE_HOME: Record<UserRole, string> = {
  admin: '/pipeline',
  ops: '/pipeline',
  designer: '/designer',
  finance: '/admin/finance',
  customer: '/portal',
  dealer: '/dealers',
};

/**
 * Who may enter which route group. Longest matching prefix wins, so
 * '/admin/finance' (admin + finance) is carved out of '/admin' (admin only).
 * Paths without an entry are public-after-auth (e.g. '/', which redirects).
 */
export const ROUTE_ACCESS: Record<string, readonly UserRole[]> = {
  '/admin/finance': ['admin', 'finance'],
  '/admin': ['admin'],
  '/pipeline': ['admin', 'ops'],
  '/projects': ['admin', 'ops'],
  '/leads': ['admin', 'ops'],
  '/designer': ['admin', 'designer'],
  '/portal': ['customer'],
  '/dealers': ['dealer'],
  '/api/invites': ['admin'],
  '/api/admin': ['admin'],
  '/api/projects': ['admin', 'ops'],
  '/api/leads': ['admin', 'ops', 'dealer'],
};

/** The three login doors. Destination is still decided by profiles.role. */
export const LOGIN_DOORS = {
  staff: {
    path: '/login',
    roles: ['admin', 'ops', 'designer', 'finance'] as readonly UserRole[],
    label: 'Staff sign-in',
  },
  dealer: {
    path: '/dealers/login',
    roles: ['dealer'] as readonly UserRole[],
    label: 'Dealer sign-in',
  },
  customer: {
    path: '/portal/login',
    roles: ['customer'] as readonly UserRole[],
    label: 'Homeowner sign-in',
  },
} as const;

export type DoorId = keyof typeof LOGIN_DOORS;

/** The door whose allowlist contains this role. */
export function doorForRole(role: UserRole): (typeof LOGIN_DOORS)[DoorId] {
  if (LOGIN_DOORS.dealer.roles.includes(role)) return LOGIN_DOORS.dealer;
  if (LOGIN_DOORS.customer.roles.includes(role)) return LOGIN_DOORS.customer;
  return LOGIN_DOORS.staff;
}

/** Which door an unauthenticated visitor to `pathname` should be sent to. */
export function doorForPath(pathname: string): (typeof LOGIN_DOORS)[DoorId] {
  if (pathname === '/portal' || pathname.startsWith('/portal/')) return LOGIN_DOORS.customer;
  if (pathname === '/dealers' || pathname.startsWith('/dealers/')) return LOGIN_DOORS.dealer;
  return LOGIN_DOORS.staff;
}

/** Roles allowed on `pathname`, or null when no rule applies (public-after-auth). */
export function accessForPath(pathname: string): readonly UserRole[] | null {
  let match: string | null = null;
  for (const prefix of Object.keys(ROUTE_ACCESS)) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) {
      if (match === null || prefix.length > match.length) match = prefix;
    }
  }
  return match === null ? null : ROUTE_ACCESS[match];
}

/** True for the login doors and their subpages (e.g. /login/reset). */
export function isLoginPath(pathname: string): boolean {
  return Object.values(LOGIN_DOORS).some(
    (door) => pathname === door.path || pathname.startsWith(door.path + '/')
  );
}

/**
 * `?next=` values must be relative paths — this is the open-redirect guard.
 * Anything absolute, protocol-relative, or backslash-y is rejected.
 */
export function sanitizeNextPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith('/')) return null;
  if (raw.startsWith('//')) return null;
  if (raw.includes('\\') || raw.includes(':')) return null;
  return raw;
}
