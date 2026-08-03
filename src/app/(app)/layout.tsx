import { redirect } from 'next/navigation';
import { Logo } from '@/app/(auth)/_components/AuthUi';
import { getSession } from '@/lib/auth/session';

/**
 * Shell for every authenticated surface. Each page enforces its own role
 * gate via guardPath(); this layout renders identity chrome.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.isActive) redirect('/auth/signout?reason=deactivated');

  return (
    <>
      <header className="app-header">
        <div className="auth-brand-logo">
          <Logo />
        </div>
        <span className="spacer" />
        <span className="role-chip">{session.role}</span>
        <span className="who">{session.fullName ?? session.email}</span>
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
