import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import {
  CREATE_CONTACT_MIGRATION_FILE,
  createContactReady,
  loadIntakeRefs,
} from '@/lib/crm/refs';
import { CreateContactForm } from './CreateContactForm';

export const dynamic = 'force-dynamic';

/**
 * Contacts § Create Contact.
 *
 * Its own page rather than the drawer: fifty fields in a side panel is a form
 * people abandon halfway. The drawer stays for editing somebody who already
 * exists, where the work is usually one field.
 */
export default async function CreateContactPage() {
  const session = await guardPath('/admin/people');
  const data = await withUser(session, async (c) => ({
    // Sequentially, on one connection: optionalRows uses savepoints.
    ready: await createContactReady(c),
    refs: await loadIntakeRefs(c),
  }));

  return (
    <main className="table-page">
      {!data.ready && (
        <p className="notice" role="alert">
          {`This database has not caught up yet, so a contact typed in here cannot be saved. Run ${CREATE_CONTACT_MIGRATION_FILE} in the SQL editor first — and the files before it, if this is the first of them — and the form below will then work as it stands.`}
        </p>
      )}
      <CreateContactForm refs={data.refs} ready={data.ready} />
    </main>
  );
}
