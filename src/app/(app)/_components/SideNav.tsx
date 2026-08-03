'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface NavItem {
  href: string;
  label: string;
  icon: string;
}

/** Sidebar navigation with active-route highlighting. */
export function SideNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav className="side-nav">
      {items.map((item) => {
        const active =
          pathname === item.href ||
          (pathname.startsWith(item.href + '/') &&
            // keep /admin from claiming /admin/finance
            !items.some((o) => o.href !== item.href && o.href.startsWith(item.href) && pathname.startsWith(o.href)));
        return (
          <Link key={item.href} href={item.href} className={active ? 'active' : ''}>
            <span className="nav-icon" aria-hidden>
              {item.icon}
            </span>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
