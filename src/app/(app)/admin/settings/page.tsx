import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { AdminTabs } from '../_components/AdminTabs';
import { SettingsForm } from './SettingsForm';

export const dynamic = 'force-dynamic';

/** Admin panel §6 — company-wide defaults. */
export default async function AdminSettingsPage() {
  const session = await guardPath('/admin');

  const data = await withUser(session, async (c) => {
    const settings = await c.query('select * from public.app_settings where id');
    const signers = await c.query(
      `select id, coalesce(full_name, email) as name from public.profiles
       where role in ('admin', 'ops') and is_active and deleted_at is null order by 2`
    );
    return { settings: settings.rows[0], signers: signers.rows };
  });

  return (
    <main className="table-page">
      <h1>Admin</h1>
      <AdminTabs />
      <h2 className="section-title">Settings</h2>
      <p className="dim">
        Company details print on work orders and change orders; the turnaround default pre-fills
        Stage 2 due dates; the CO numbering feeds change orders.
      </p>
      <SettingsForm settings={data.settings} signers={data.signers} />
    </main>
  );
}
