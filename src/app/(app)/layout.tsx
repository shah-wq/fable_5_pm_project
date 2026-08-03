import { redirect } from 'next/navigation';
import { Logo } from '@/app/(auth)/_components/AuthUi';
import { createSupabaseServer } from '@/lib/supabase/server';

/**
 * Shell for every authenticated surface. Middleware has already gated the
 * route by role; this layout only renders identity chrome.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, full_name, email')
    .eq('id', user.id)
    .single();

  return (
    <>
      <header className="app-header">
        <div className="auth-brand-logo">
          <Logo />
        </div>
        <span className="spacer" />
        <span className="role-chip">{profile?.role ?? 'unknown'}</span>
        <span className="who">{profile?.full_name ?? profile?.email ?? user.email}</span>
        <form action="/auth/signout" method="post">
          <button className="btn-signout" type="submit">
            Sign out
          </button>
        </form>
      </header>
      {children}
    </>
  );
}
