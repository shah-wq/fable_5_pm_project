import { guardPath } from '@/lib/auth/session';
import { AdminTabs } from '../_components/AdminTabs';
import { NotificationRules } from './NotificationRules';

export const dynamic = 'force-dynamic';

export default async function AdminNotificationsPage() {
  await guardPath('/admin');
  return (
    <main className="table-page">
      <h1>Admin</h1>
      <AdminTabs />
      <h2 className="section-title">Notifications</h2>
      <p className="dim">
        Everything the system tells homeowners, project managers, sales reps, dealers and admins,
        and how. Switch a notification off and it is never raised; switch a channel off and it stays
        in the feed but is not emailed or pushed. Email needs SMTP; push needs the VAPID keys.
      </p>
      <NotificationRules />
    </main>
  );
}
