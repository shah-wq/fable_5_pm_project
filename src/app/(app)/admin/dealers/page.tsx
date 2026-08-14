import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { AdminTabs } from '../_components/AdminTabs';
import { DealersManager, type DealerRow, type DealerUser } from './DealersManager';

export const dynamic = 'force-dynamic';

/**
 * Admin §Dealers — the dealer-company list with the numbers an admin acts
 * on (active/completed projects, pending commission, user accounts), the
 * full-record drawer, and the guarded deactivate/delete flow.
 */
export default async function AdminDealersPage() {
  const session = await guardPath('/admin');

  const data = await withUser(session, async (c) => {
    const dealers = await c.query(
      `select d.*,
         (select count(*) from public.projects p
           where p.dealer_id = d.id and p.status not in ('complete', 'cancelled')) as active_projects,
         (select count(*) from public.projects p
           where p.dealer_id = d.id and p.status = 'complete') as completed_projects,
         (select count(*) from public.projects p where p.dealer_id = d.id) as total_projects,
         (select count(*) from public.leads l where l.dealer_id = d.id) as lead_count,
         coalesce((select sum(cm.base_amount + cm.adjustment)
           from public.commissions cm
           join public.projects p on p.id = cm.project_id
           where p.dealer_id = d.id and cm.status <> 'paid'), 0) as commission_pending
       from public.dealers d
       order by d.name`
    );
    const memberships = await c.query(
      `select du.dealer_id, pr.id as user_id, pr.full_name, pr.email, pr.is_active
       from public.dealer_users du
       join public.profiles pr on pr.id = du.user_id
       order by pr.full_name nulls last, pr.email`
    );
    const repEmails = await c.query(
      `select dealer_id, lower(email) as email from public.sales_reps
       where email is not null and dealer_id is not null`
    );
    return { dealers: dealers.rows, memberships: memberships.rows, repEmails: repEmails.rows };
  });

  const usersByDealer = new Map<string, DealerUser[]>();
  const repSet = new Set(data.repEmails.map((r) => `${r.dealer_id}:${r.email}`));
  for (const m of data.memberships) {
    const list = usersByDealer.get(m.dealer_id) ?? [];
    list.push({
      userId: m.user_id,
      name: m.full_name,
      email: m.email,
      isActive: m.is_active,
      repLinked: m.email ? repSet.has(`${m.dealer_id}:${String(m.email).toLowerCase()}`) : false,
    });
    usersByDealer.set(m.dealer_id, list);
  }

  const rows: DealerRow[] = data.dealers.map((d) => ({
    id: d.id,
    name: d.name,
    code: d.code,
    email: d.email,
    phone: d.phone,
    primaryContactName: d.primary_contact_name,
    primaryContactEmail: d.primary_contact_email,
    companyAddress: d.company_address,
    taxId: d.tax_id,
    defaultCommissionBasis: d.default_commission_basis,
    defaultCommissionRate:
      d.default_commission_rate === null ? null : Number(d.default_commission_rate),
    paymentTerms: d.payment_terms,
    notificationRecipients: d.notification_recipients,
    notes: d.notes,
    repsSeeOwnOnly: Boolean(d.reps_see_own_only),
    isActive: d.is_active,
    activeProjects: Number(d.active_projects),
    completedProjects: Number(d.completed_projects),
    totalProjects: Number(d.total_projects),
    leadCount: Number(d.lead_count),
    commissionPending: Number(d.commission_pending),
    users: usersByDealer.get(d.id) ?? [],
  }));

  return (
    <main className="table-page">
      <h1>Admin</h1>
      <AdminTabs />
      <h2 className="section-title">Dealers</h2>
      <p className="dim">
        The organisation records dealer users and projects point at. Renaming flows through
        everywhere instantly; deactivating hides a company from new projects without touching
        its history; deletion is only possible for a company with nothing attached.
      </p>
      <DealersManager rows={rows} />
    </main>
  );
}
