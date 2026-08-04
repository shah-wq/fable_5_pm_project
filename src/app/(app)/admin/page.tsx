import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { AdminTabs } from './_components/AdminTabs';
import { UsersManager, type UserRow } from './_components/UsersManager';

export const dynamic = 'force-dynamic';

/** Admin panel §1 — Users & roles. */
export default async function AdminUsersPage() {
  const session = await guardPath('/admin');

  const data = await withUser(session, async (c) => {
    const users = await c.query<UserRow>('select * from auth.admin_list_users()');
    const dealers = await c.query('select id, name from public.dealers order by name');
    const clients = await c.query(
      `select c.id, c.first_name || ' ' || c.last_name || coalesce(' — ' || p.name, '') as name
       from public.clients c
       left join public.projects p on p.client_id = c.id
       order by 2 limit 500`
    );
    return { users: users.rows, dealers: dealers.rows, clients: clients.rows };
  });

  return (
    <main className="table-page">
      <h1>Admin</h1>
      <AdminTabs />
      <h2 className="section-title">Users &amp; roles</h2>
      <p className="dim">
        Who can log in and what they can see. Every create, edit, role change, password change,
        disable and delete is written to the activity log — password values never are.
      </p>
      <UsersManager users={data.users} dealers={data.dealers} clients={data.clients} me={session.userId} />
    </main>
  );
}
