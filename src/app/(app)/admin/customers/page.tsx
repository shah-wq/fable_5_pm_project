import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { loadCustomers, loadDuplicateCandidates } from '@/lib/customers/service';
import { AdminTabs } from '../_components/AdminTabs';
import { CustomersManager } from './CustomersManager';

export const dynamic = 'force-dynamic';

/**
 * Admin § Customers. Customers are created by the New project form, so this
 * section is about finding, correcting, merging and controlling portal access
 * for records that already exist — and seeing every project a person has with
 * you in one place.
 */
export default async function AdminCustomersPage() {
  const session = await guardPath('/admin/customers');

  const data = await withUser(session, async (c) => ({
    customers: await loadCustomers(c),
    duplicates: await loadDuplicateCandidates(c),
    dealers: (await c.query('select id, name from public.dealers where is_active order by name')).rows,
  }));

  return (
    <main className="table-page">
      <h1>Admin</h1>
      <AdminTabs />
      <h2 className="section-title">Customers</h2>
      <p className="dim">
        The customer is a person; the project is a job. One record can carry several
        projects — a second property, a battery added later, a referral in the family —
        which is what gives you accurate history, one portal login and clean reporting.
      </p>
      <CustomersManager
        customers={data.customers}
        duplicates={data.duplicates}
        dealers={data.dealers}
        isAdmin={session.role === 'admin'}
      />
    </main>
  );
}
