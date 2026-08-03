import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth/constants';
import { accessForPath, doorForPath, isLoginPath, sanitizeNextPath } from '@/lib/auth/roles';

/**
 * Edge-safe fast path: visitors with no session cookie never reach a
 * protected surface — they're bounced to the right login door (or get a 401
 * for APIs) before any server work happens.
 *
 * The AUTHORITATIVE checks live server-side, where the database is
 * reachable: guardPath()/requireRole() (src/lib/auth/session.ts) validate
 * the session, re-read the profile's role and is_active on every request,
 * and enforce ROUTE_ACCESS. And beneath all of it, RLS in Postgres is the
 * real wall — a request that somehow dodged both layers still only sees its
 * §2 slice.
 */
export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  const hasSessionCookie = request.cookies.has(SESSION_COOKIE);
  const isPublic = isLoginPath(pathname) || pathname.startsWith('/auth/');
  const isProtected = accessForPath(pathname) !== null;

  if (!hasSessionCookie && isProtected && !isPublic) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = doorForPath(pathname).path;
    url.search = '';
    const next = sanitizeNextPath(pathname + search);
    if (next && next !== '/') url.searchParams.set('next', next);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Everything except:
     *  - /u/* and /api/u/*  — magic-link upload surface (REQ-SEC-01): token
     *    holders never carry a session
     *  - /api/health        — deployment diagnostics must always answer
     *  - Next.js internals and static assets
     */
    '/((?!u/|api/u/|api/health|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt)$).*)',
  ],
};
