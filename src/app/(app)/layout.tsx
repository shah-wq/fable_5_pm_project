import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Logo } from '@/app/(auth)/_components/AuthUi';
import { getSession } from '@/lib/auth/session';
import type { UserRole } from '@/lib/auth/roles';

const NAV: Record<UserRole, Array<{ href: string; label: string }>> = {
  admin: [
    { href: '/pipeline', label: 'Pipeline' },
    { href: '/projects', label: 'Projects' },
    { href: '/admin', label: 'Admin' },
    { href: '/admin/finance', label: 'Finance' },
  ],
  ops: [
    { href: '/pipeline', label: 'Pipeline' },
    { href: '/projects', label: 'Projects' },
  ],
  designer: [{ href: '/designer', label: 'My queue' }],
  finance: [{ href: '/admin/finance', label: 'Finance' }],
  customer: [{ href: '/portal', label: 'My project' }],
  dealer: [{ href: '/dealers', label: 'My book' }],
};

/**
 * Shell for every authenticated surface: role-aware navigation + identity
 * chrome. Each page still enforces its own role gate via guardPath().
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.isActive) redirect('/auth/signout?reason=deactivated');

  return (
    <>
      <header className="app-header">
        <Link href={NAV[session.role][0].href} className="auth-brand-logo" style={{ textDecoration: 'none', color: 'inherit' }}>
          <Logo />
        </Link>
        <nav className="app-nav">
          {NAV[session.role].map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>
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
