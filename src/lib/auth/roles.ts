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
  // Finance gets its own, much smaller, dashboard (Dashboard spec §8). Customers
  // get none — there is deliberately no entry that admits them.
  '/dashboard': ['admin', 'ops', 'finance'],
  '/leads': ['admin', 'ops'],
  // The global chat inbox is a staff instrument; the thread API is shared with
  // the customer, who reaches only their own project (enforced in the database).
  '/messages': ['admin', 'ops'],
  // The follow-up list and the ratings behind it are staff work: §5 puts them in
  // the PM's own queue, and §6 keeps per-person figures away from everyone else.
  '/tasks': ['admin', 'ops'],
  // §6: "the customer is never told their rating is scored against a named
  // individual", and §5 keeps the verbatim away from the dealer — so the log is
  // staff-only, like the by-party figures it sits beside.
  '/feedback': ['admin', 'ops'],
  '/api/tasks': ['admin', 'ops'],
  '/api/chat': ['admin', 'ops', 'customer'],
  '/reports': ['admin', 'ops', 'finance'],
  '/api/reports': ['admin', 'ops', 'finance'],
  '/designer': ['admin', 'designer'],
  '/portal': ['customer'],
  '/api/portal': ['customer'],
  // Stage feedback: the customer answers, and nobody else has anything to say
  // here — a dealer or a staff member posting a rating would be filing an
  // opinion in the customer's name.
  '/api/feedback': ['customer'],
  '/dealers': ['dealer'],
  '/api/invites': ['admin'],
  '/api/admin': ['admin'],
  '/api/projects': ['admin', 'ops'],
  '/api/leads': ['admin', 'ops', 'dealer'],
};

/**
 * The three front doors (Sign-in Screens §2, §9).
 *
 * One entry point, three unmistakable doors: /login is canonical and stays the
 * staff page, with the other two hanging off it. Sibling URLs rather than
 * /portal/login and /dealers/login because these are three doors to one
 * building — and because the dealer and homeowner pages are now linked from
 * invitation emails and onboarding packs, where '/login/homeowner' reads as what
 * it is.
 *
 * The `roles` list is NOT an access rule. §5: valid credentials at the wrong
 * door sign in and get taken to their own surface — a homeowner who typed their
 * details into the staff form has proved who they are, and refusing them is a
 * support call caused entirely by layout. The list only decides whether to say
 * "taking you to your project" on the way through.
 */
export const LOGIN_DOORS = {
  staff: {
    path: '/login',
    roles: ['admin', 'ops', 'designer', 'finance'] as readonly UserRole[],
    label: 'Staff sign-in',
  },
  dealer: {
    path: '/login/dealer',
    roles: ['dealer'] as readonly UserRole[],
    label: 'Dealer sign-in',
  },
  customer: {
    path: '/login/homeowner',
    roles: ['customer'] as readonly UserRole[],
    label: 'Homeowner sign-in',
  },
} as const;

export type DoorId = keyof typeof LOGIN_DOORS;

/**
 * The paths these pages used to live at. Kept working, permanently: they are in
 * sent invitation emails, in browser histories and on printed onboarding sheets,
 * and a dead sign-in link is the one broken link nobody can work around.
 */
export const LEGACY_LOGIN_PATHS: Record<string, string> = {
  '/dealers/login': LOGIN_DOORS.dealer.path,
  '/portal/login': LOGIN_DOORS.customer.path,
};

/**
 * Where a signed-in role goes. The single routing function of §9 — used by the
 * login endpoint, by the pages that bounce an already-signed-in visitor, and by
 * the password-reset flow, so a role added later has exactly one place to be
 * handled.
 *
 * `next` is honoured when it survives sanitizing (someone who was sent to a door
 * from a deep link lands where they were going), except when the account must
 * change its password first — that comes before anything else.
 */
export function roleToLandingRoute(
  role: UserRole,
  opts: { next?: string | null; forcePasswordChange?: boolean } = {}
): string {
  if (opts.forcePasswordChange) return '/auth/change-password?forced=1';
  const next = sanitizeNextPath(opts.next);
  if (next && next !== '/' && !isLoginPath(next)) return next;
  return ROLE_HOME[role];
}

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

/**
 * True for the login doors and their subpages (e.g. /login/reset), and for the
 * old door paths that now redirect. Middleware treats these as public — a page
 * that exists to let people in must never itself require being in.
 */
export function isLoginPath(pathname: string): boolean {
  if (pathname in LEGACY_LOGIN_PATHS) return true;
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
