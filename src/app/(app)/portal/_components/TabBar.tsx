'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The five tabs (spec §2). Fixed to the bottom, thumb-reachable, and the same
 * five on both platforms so a customer who switches phones is not relearning
 * anything.
 *
 * Home is deliberately first and Documents deliberately third: the order is
 * how often a homeowner needs each, not how important we think it is.
 */
const TABS = [
  { href: '/portal', label: 'Home', icon: '☀' },
  { href: '/portal/project', label: 'Project', icon: '▤' },
  { href: '/portal/documents', label: 'Documents', icon: '🗎' },
  { href: '/portal/photos', label: 'Photos', icon: '▣' },
  { href: '/portal/more', label: 'More', icon: '☰' },
];

export function TabBar() {
  const pathname = usePathname();
  return (
    <nav className="tab-bar" aria-label="Sections">
      {TABS.map((tab) => {
        const active = tab.href === '/portal' ? pathname === '/portal' : pathname.startsWith(tab.href);
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
          </Link>
        );
      })}
    </nav>
  );
}
