'use client';

import { useRouter } from 'next/navigation';
import type { CustomerRow } from '@/lib/customers/service';
import { PersonDrawer } from '../PersonDrawer';

/**
 * One contact, at its own address.
 *
 * The record itself is the same component the list opens as a drawer, asked to
 * render as a page: same tabs, same fields, same saves. What changes is the
 * room it has — the contact's fields lay out across the page exactly as they do
 * on Create Contact, which is the point.
 */
export function ContactRecord({
  customer,
  dealers,
  isAdmin,
}: {
  customer: CustomerRow;
  dealers: Array<{ id: string; name: string }>;
  isAdmin: boolean;
}) {
  const router = useRouter();
  return (
    <PersonDrawer
      customer={customer}
      dealers={dealers}
      isAdmin={isAdmin}
      variant="page"
      onClose={() => router.push('/admin/people')}
      // Deleting or anonymising leaves nothing here to look at; everything else
      // just needs the server components on this page to read again.
      onSaved={() => router.refresh()}
    />
  );
}
