import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Logo } from '@/app/(auth)/_components/AuthUi';
import { getSession } from '@/lib/auth/session';
import type { UserRole } from '@/lib/auth/roles';
import { withUser } from '@/lib/db';
import { optionalRows } from '@/lib/db-optional';
import { isAppShell } from '@/lib/native/shell';
import { Assistant } from './_components/Assistant';
import { SideNav, type NavItem } from './_components/SideNav';
import { TabBar } from './portal/_components/TabBar';

// The CRM group (Modules 16–19). The specification argues for these four at the
// top level with no section header — "A PM who wins a deal on Tuesday and
// manages its install in September is doing one job in one product". They are
// grouped here because that was asked for directly; the URLs stay flat either
// way, so moving them back out is a one-line change and breaks no links.
const CRM: NavItem[] = [
  { href: '/admin/people', label: 'Contacts', icon: '☺', group: 'CRM' },
  // The same contacts as a board. Sits directly under them because it is the
  // same list read a different way, not a different list.
  { href: '/admin/people/stages', label: 'Contact stages', icon: '▥', group: 'CRM' },
  { href: '/deals', label: 'Deals', icon: '◈', group: 'CRM' },
  { href: '/admin/dealers', label: 'Dealers', icon: '⌂', group: 'CRM' },
  { href: '/admin/subscribers', label: 'E-book subscribers', icon: '✉', group: 'CRM' },
];

const NAV: Record<UserRole, NavItem[]> = {
  admin: [
    { href: '/dashboard', label: 'Dashboard', icon: '◱' },
    { href: '/messages', label: 'Messages', icon: '✉' },
    { href: '/tasks', label: 'Follow-ups', icon: '⚑' },
    { href: '/pipeline', label: 'Pipeline', icon: '▦' },
    { href: '/projects', label: 'Projects', icon: '☰' },
    { href: '/projects/new', label: 'New project', icon: '＋' },
    { href: '/leads', label: 'Leads', icon: '☎' },
    { href: '/reports', label: 'Reports', icon: '▤' },
    ...CRM,
    { href: '/admin', label: 'Admin', icon: '⚙', group: 'Settings' },
    { href: '/admin/finance', label: 'Finance', icon: '$', group: 'Settings' },
  ],
  ops: [
    { href: '/dashboard', label: 'Dashboard', icon: '◱' },
    { href: '/messages', label: 'Messages', icon: '✉' },
    { href: '/tasks', label: 'Follow-ups', icon: '⚑' },
    { href: '/pipeline', label: 'Pipeline', icon: '▦' },
    { href: '/projects', label: 'Projects', icon: '☰' },
    { href: '/projects/new', label: 'New project', icon: '＋' },
    { href: '/leads', label: 'Leads', icon: '☎' },
    { href: '/reports', label: 'Reports', icon: '▤' },
    // Ops work deals and people; the dealer record and the subscriber consent
    // records are admin's (Part 8).
    ...CRM.filter((i) =>
      ['/deals', '/admin/people', '/admin/people/stages'].includes(i.href)
    ),
  ],
  // Part 8: "Own deals and their people, plus the unassigned pool. Read-only on
  // projects that came from their own deals. No access to other stages'
  // operational fields, no admin panel."
  sales: [
    { href: '/deals', label: 'Deals', icon: '◈' },
    { href: '/admin/people', label: 'Contacts', icon: '☺' },
    { href: '/admin/people/stages', label: 'Contact stages', icon: '▥' },
    { href: '/reports', label: 'Reports', icon: '▤' },
  ],
  designer: [{ href: '/designer', label: 'My queue', icon: '▦' }],
  finance: [
    { href: '/dashboard', label: 'Dashboard', icon: '◱' },
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

  // The store app is the homeowner's portal and nothing else. A staff member
  // signing in through it is told to use a browser rather than being handed the
  // pipeline on a 5-inch screen it was never designed for. This is a
  // presentation decision, not a security one — the user agent is
  // client-supplied, and what anyone may actually read is still decided by
  // guardPath() and RLS.
  if (session.role !== 'customer' && (await isAppShell())) {
    return (
      <div className="customer-app">
        <header className="app-bar">
          <span className="app-bar-logo">
            <Logo />
          </span>
        </header>
        <main className="app-body">
          <div className="app-page">
            <section className="panel">
              <h1>This app is for homeowners</h1>
              <p>
                You are signed in as <strong>{session.fullName ?? session.email}</strong> ({session.role}).
                The SolarFlow app shows a customer their own installation — it is not the staff
                tool.
              </p>
              <p>
                Everything you need is on a computer: the pipeline, projects, stage forms, reports
                and admin all live in the browser at your normal address. They need a screen wide
                enough to work on.
              </p>
              <form action="/auth/signout" method="post">
                <button className="btn" type="submit">
                  Sign out
                </button>
              </form>
            </section>
          </div>
        </main>
      </div>
    );
  }

  // Customers get the app shell instead of the staff sidebar: a title bar and
  // five bottom tabs. It is the same code either way — the mobile app is this
  // surface in a native wrapper, not a second product (mobile spec §0).
  if (session.role === 'customer') {
    // Their unread count for the Messages tab badge. Savepoint-guarded and
    // defaulted to zero: a missing badge is nothing, a broken portal is not.
    const unread = await withUser(
      { userId: session.userId, email: session.email, role: session.role },
      async (client) => {
        const rows = await optionalRows<{ n: string }>(
          client,
          'the unread message count for the tab bar',
          `select count(*) as n
           from public.project_messages m
           join public.projects p on p.id = m.project_id
           where m.sender_role = 'staff' and not m.is_internal and m.read_at is null
             and p.client_id in (select app.current_client_ids())`
        );
        return Number(rows[0]?.n ?? 0);
      }
    ).catch(() => 0);

    return (
      <div className="customer-app">
        <header className="app-bar">
          <Link href="/portal" className="app-bar-logo" aria-label="SolarFlow home">
            <Logo />
          </Link>
        </header>
        <main className="app-body">{children}</main>
        <TabBar unread={unread} />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link href={NAV[session.role][0].href} className="sidebar-logo">
          <Logo />
        </Link>
        <SideNav items={NAV[session.role]} />
        <Assistant />
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
