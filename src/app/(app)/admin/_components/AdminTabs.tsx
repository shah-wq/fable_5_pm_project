'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/admin', label: 'Users & roles' },
  { href: '/admin/surveyors', label: 'Surveyors' },
  { href: '/admin/designers', label: 'Designers' },
  { href: '/admin/crews', label: 'Install crews' },
  { href: '/admin/vendors', label: 'Vendors' },
  { href: '/admin/dealers', label: 'Dealers' },
  { href: '/admin/jurisdictions', label: 'Jurisdictions' },
  { href: '/admin/utilities', label: 'Utilities' },
  { href: '/admin/hoas', label: 'HOAs' },
  { href: '/admin/finance_partners', label: 'Finance partners' },
  { href: '/admin/settings', label: 'Settings' },
  { href: '/admin/activity', label: 'Activity log' },
];

export function AdminTabs() {
  const pathname = usePathname();
  return (
    <div className="admin-tabs">
      {TABS.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          className={pathname === tab.href ? 'active' : ''}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}
