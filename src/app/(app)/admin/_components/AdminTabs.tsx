'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const GROUPS: Array<{ label?: string; tabs: Array<{ href: string; label: string }> }> = [
  {
    tabs: [
      { href: '/admin', label: 'Users & roles' },
      { href: '/admin/surveyors', label: 'Surveyors' },
      { href: '/admin/designers', label: 'Designers' },
      { href: '/admin/crews', label: 'Install crews' },
      { href: '/admin/vendors', label: 'Vendors' },
      { href: '/admin/dealers', label: 'Dealers' },
      { href: '/admin/customers', label: 'Customers' },
      { href: '/admin/sales_reps', label: 'Sales reps' },
      { href: '/admin/canned_replies', label: 'Canned replies' },
      { href: '/admin/settings', label: 'Settings' },
      { href: '/admin/activity', label: 'Activity log' },
    ],
  },
  {
    label: 'Equipment & financing lists',
    tabs: [
      { href: '/admin/system_types', label: 'System types' },
      { href: '/admin/module_types', label: 'Module types' },
      { href: '/admin/inverter_types', label: 'Inverter types' },
      { href: '/admin/battery_types', label: 'Battery types' },
      { href: '/admin/financing_companies', label: 'Financing companies' },
      { href: '/admin/cash_financing_options', label: 'Cash or Financing' },
      { href: '/admin/finance_partners', label: 'Finance partners' },
      { href: '/admin/dealer_visible_fields', label: 'Dealer visibility' },
    ],
  },
];

export function AdminTabs() {
  const pathname = usePathname();
  return (
    <div className="admin-tab-groups">
      {GROUPS.map((group, i) => (
        <div key={i} className="admin-tab-group">
          {group.label && <span className="admin-tab-label">{group.label}</span>}
          <div className="admin-tabs">
            {group.tabs.map((tab) => (
              <Link
                key={tab.href}
                href={tab.href}
                className={pathname === tab.href ? 'active' : ''}
              >
                {tab.label}
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
