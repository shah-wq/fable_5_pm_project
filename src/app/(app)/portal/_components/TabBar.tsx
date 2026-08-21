'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The bottom tabs. Fixed to the bottom, thumb-reachable, and the same set on
 * both platforms so a customer who switches phones is not relearning anything.
 *
 * Home is deliberately first and Documents deliberately third: the order is
 * how often a homeowner needs each, not how important we think it is.
 *
 * Six, not the mobile spec's five: the Project Chat spec asks for a Messages tab
 * in the portal and the app, and burying a conversation behind 'More' is how a
 * customer stops using it — which defeats the point of building it. Messages
 * sits next to Home because it is the tab someone opens with a question, and
 * questions are why they came.
 */
const TABS = [
  { href: '/portal', label: 'Home', icon: '☀' },
  { href: '/portal/messages', label: 'Messages', icon: '✉' },
  { href: '/portal/project', label: 'Project', icon: '▤' },
  { href: '/portal/documents', label: 'Docs', icon: '🗎' },
  { href: '/portal/photos', label: 'Photos', icon: '▣' },
  { href: '/portal/more', label: 'More', icon: '☰' },
];

export function TabBar({ unread = 0 }: { unread?: number }) {
  const pathname = usePathname();
  return (
    <nav className="tab-bar six" aria-label="Sections">
      {TABS.map((tab) => {
        const active = tab.href === '/portal' ? pathname === '/portal' : pathname.startsWith(tab.href);
        const badge = tab.href === '/portal/messages' && unread > 0 ? unread : 0;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={active ? 'active' : ''}
            aria-current={active ? 'page' : undefined}
          >
            <span className="tab-icon" aria-hidden>
              {tab.icon}
            </span>
            <span className="tab-label">{tab.label}</span>
            {badge > 0 && (
              <span className="tab-badge" aria-label={`${badge} unread messages`}>
                {badge}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
