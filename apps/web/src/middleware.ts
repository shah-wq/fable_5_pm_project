import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { Database } from '@/lib/database.types';
import {
  ROLE_HOME,
  accessForPath,
  doorForPath,
  isLoginPath,
  sanitizeNextPath,
} from '@/lib/auth/roles';

/**
 * Runs on every route group (see `config.matcher`): refreshes the Supabase
 * session cookies (@supabase/ssr) and enforces role-based access from
 * ROUTE_ACCESS before any surface renders.
 *
 * Middleware is the UX layer of authorization — the real wall is RLS
 * (migration 000600): even a bypassed check here meets policies keyed to the
 * same profiles.role.
 */
export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Also refreshes expired sessions — do not remove.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isPublic = isLoginPath(pathname) || pathname.startsWith('/auth/');

  if (!user) {
    if (isPublic) return response;
    const door = doorForPath(pathname);
    const url = request.nextUrl.clone();
    url.pathname = door.path;
    url.search = '';
    const next = sanitizeNextPath(pathname + search);
    if (next && next !== '/') url.searchParams.set('next', next);
    return NextResponse.redirect(url);
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, is_active')
    .eq('id', user.id)
    .single();

  // Deactivated (or profile-less) accounts die at the door, everywhere.
  if (!profile || !profile.is_active) {
    await supabase.auth.signOut();
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('error', 'account_disabled');
    const redirect = NextResponse.redirect(url);
    // Carry over the cookie removals signOut queued on `response`.
    response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
    return redirect;
  }

  const home = ROLE_HOME[profile.role];

  // Signed-in users have no business on a login page.
  if (isLoginPath(pathname)) {
    return NextResponse.redirect(new URL(home, request.url));
  }

  const allowed = accessForPath(pathname);
  if (allowed && !allowed.includes(profile.role)) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    return NextResponse.redirect(new URL(home, request.url));
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except:
     *  - /u/* and /api/u/*  — magic-link upload surface (REQ-SEC-01): token
     *    holders never get a Supabase session, so no cookies to refresh here
     *  - Next.js internals and static assets
     */
    '/((?!u/|api/u/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt)$).*)',
  ],
};
