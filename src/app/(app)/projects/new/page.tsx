import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { NewProjectForm } from './NewProjectForm';

export const dynamic = 'force-dynamic';

export default async function NewProjectPage() {
  const session = await guardPath('/projects');

  const refs = await withUser(session, async (c) => ({
    dealers: (await c.query(`select id, name from public.dealers where is_active order by name`)).rows,
    financePartners: (
      await c.query(`select id, name from public.finance_partners where is_active order by name`)
    ).rows,
    pms: (
      await c.query(
        `select id, coalesce(full_name, email) as name from public.profiles
         where role in ('admin', 'ops') and is_active order by 2`
      )
    ).rows,
  }));

  return (
    <main className="surface">
      <h1>New project</h1>
      <p className="dim">
        Creates the customer and the project card in Survey. Everything else is entered on the
        stage forms.
      </p>
      <NewProjectForm
        dealers={refs.dealers}
        financePartners={refs.financePartners}
        pms={refs.pms}
        defaultPm={session.userId}
      />
    </main>
  );
}
