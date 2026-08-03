import { NextResponse } from 'next/server';
import { ROLE_HOME, sanitizeNextPath } from '@/lib/auth/roles';
import { createSupabaseServer } from '@/lib/supabase/server';

/**
 * Lands every emailed auth link: invitations, password recovery, OTP magic
 * links. Exchanges the one-time code for a session, then forwards to the
 * (relative-only) `next` target — invites and recoveries pass
 * /auth/update-password — or to the signed-in role's home.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = sanitizeNextPath(searchParams.get('next'));

  if (code) {
    const supabase = await createSupabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      if (next) return NextResponse.redirect(`${origin}${next}`);

      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .single();
        if (profile) return NextResponse.redirect(`${origin}${ROLE_HOME[profile.role]}`);
      }
      return NextResponse.redirect(`${origin}/`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback`);
}
