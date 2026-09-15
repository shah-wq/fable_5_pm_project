import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { loadIntakeRefs } from '@/lib/crm/refs';
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
  const refs = await withUser(session, (c) => loadIntakeRefs(c));

  return (
    <main className="table-page">
      <CreateContactForm refs={refs} />
    </main>
  );
}
