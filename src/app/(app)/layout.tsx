import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Logo } from '@/app/(auth)/_components/AuthUi';
import { getSession } from '@/lib/auth/session';
import type { UserRole } from '@/lib/auth/roles';
import { SideNav, type NavItem } from './_components/SideNav';

const NAV: Record<UserRole, NavItem[]> = {
  admin: [
    { href: '/pipeline', label: 'Pipeline', icon: '▦' },
    { href: '/projects', label: 'Projects', icon: '☰' },
    { href: '/projects/new', label: 'New project', icon: '＋' },
    { href: '/leads', label: 'Leads', icon: '☎' },
    { href: '/reports', label: 'Reports', icon: '▤' },
    { href: '/admin', label: 'Admin', icon: '⚙' },
    { href: '/admin/finance', label: 'Finance', icon: '$' },
  ],
  ops: [
    { href: '/pipeline', label: 'Pipeline', icon: '▦' },
    { href: '/projects', label: 'Projects', icon: '☰' },
    { href: '/projects/new', label: 'New project', icon: '＋' },
    { href: '/leads', label: 'Leads', icon: '☎' },
    { href: '/reports', label: 'Reports', icon: '▤' },
  ],
  designer: [{ href: '/designer', label: 'My queue', icon: '▦' }],
  finance: [
    { href: '/admin/finance', label: 'Finance', icon: '$' },
    { href: '/reports', label: 'Reports', icon: '▤' },
  ],
  customer: [{ href: '/portal', label: 'My project', icon: '☀' }],
  dealer: [
    { href: '/dealers', label: 'Dashboard', icon: '▦' },
    { href: '/dealers/projects', label: 'My projects', icon: '☰' },
    { href: '/dealers/leads', label: 'Submit a lead', icon: '＋' },
    { href: '/dealers/commissions', label: 'Commissions', icon: '$' },
  ],
};

/**
 * Shell for every authenticated surface: persistent sidebar (logo, role-aware
 * navigation, identity + sign out) with the page content beside it. Collapses
 * to a top bar on small screens. Pages still enforce their own role gates via
 * guardPath().
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.isActive) redirect('/auth/signout?reason=deactivated');

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link href={NAV[session.role][0].href} className="sidebar-logo">
          <Logo />
        </Link>
        <SideNav items={NAV[session.role]} />
        <div className="sidebar-foot">
          <div className="who-block">
            <span className="role-chip">{session.role}</span>
            <span className="who">{session.fullName ?? session.email}</span>
          </div>
          <a className="foot-link" href="/auth/change-password">Change password</a>
          <form action="/auth/signout" method="post">
            <button className="btn-signout" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <div className="app-content">{children}</div>
    </div>
  );
}
