'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  /** Heading this item sits under. Items with no group come first, ungrouped. */
  group?: string;
}

/** Sidebar navigation with active-route highlighting, in labelled groups. */
export function SideNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  // Order is the order the groups first appear, so the array stays the single
  // place navigation is arranged.
  const groups: Array<{ label: string | null; items: NavItem[] }> = [];
  for (const item of items) {
    const label = item.group ?? null;
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }

  const link = (item: NavItem) => {
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
  };

  return (
    <nav className="side-nav">
      {groups.map((group, i) => (
        <div className="nav-group" key={group.label ?? `top-${i}`}>
          {group.label && <p className="nav-group-label">{group.label}</p>}
          {group.items.map(link)}
        </div>
      ))}
    </nav>
  );
}
