import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { loadDetailRefs } from '@/lib/projects/details';
import { NewProjectForm } from './NewProjectForm';

export const dynamic = 'force-dynamic';

export default async function NewProjectPage() {
  const session = await guardPath('/projects');
  const refs = await withUser(session, (c) => loadDetailRefs(c));

  return (
    <main className="surface wide">
      <h1>New project</h1>
      <p className="dim">
        Creates the customer and the project card in Survey. Only the customer name, site address,
        and dealer are required — everything else can be filled in now or later from the
        project&apos;s Details tab.
      </p>
      <NewProjectForm refs={refs} defaultPm={session.userId} />
    </main>
  );
}
