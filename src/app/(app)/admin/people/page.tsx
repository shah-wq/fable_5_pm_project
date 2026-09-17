import Link from 'next/link';
import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { loadCustomers, loadDuplicateCandidates } from '@/lib/customers/service';
import { crmReady, loadPersonCrm } from '@/lib/people/service';
import { behindSentence, migrationState } from '@/lib/db-migrations';
import { isSchemaDrift } from '@/lib/db-drift';
import { AdminTabs } from '../_components/AdminTabs';
import { PeopleManager } from './PeopleManager';

export const dynamic = 'force-dynamic';

/**
 * Admin § People (Module 16).
 *
 * The Customers screen, unchanged in every behaviour it already had — the four
 * tabs, the guided merge, delete versus anonymise, portal access — now holding
 * people who have not signed anything yet. Part 4: "Renaming one screen is
 * cheaper than building a second one that does the same thing for people who
 * have not signed yet."
 *
 * The CRM roll-ups load separately and degrade to nothing, so this screen keeps
 * working on a database where 003400 has not been pasted in yet.
 */
export default async function AdminPeoplePage() {
  const session = await guardPath('/admin/people');

  // The list itself selects columns that a much older database does not have —
  // an alternate phone, an archived flag — and a query like that cannot degrade
  // to an empty result without claiming there are no contacts. So it is allowed
  // to fail, and the failure is answered with the files to paste rather than
  // with a crash page: an operator who sees "Application error" goes looking for
  // a bug in the product, which is the one place it is not.
  let data;
  try {
    data = await withUser(session, async (c) => {
      const ready = await crmReady(c);
      return {
        ready,
        behind: ready ? [] : (await migrationState(c)).behind,
        customers: await loadCustomers(c),
        crm: ready ? [...(await loadPersonCrm(c)).values()] : [],
        duplicates: await loadDuplicateCandidates(c),
        dealers: (await c.query('select id, name from public.dealers where is_active order by name')).rows,
      };
    });
  } catch (error) {
    if (!isSchemaDrift(error)) throw error;
    const behind = await withUser(session, async (c) => (await migrationState(c)).behind);
    return (
      <main className="table-page">
        <h1>Admin</h1>
        <AdminTabs />
        <h2 className="section-title">Contacts</h2>
        <p className="notice" role="alert">
          {`This screen needs part of the schema that is not there yet, so it cannot list anybody. ${behindSentence(behind)} Then reload this page.`}
        </p>
      </main>
    );
  }

  return (
    <main className="table-page">
      <h1>Admin</h1>
      <AdminTabs />
      <div className="section-head">
        <h2 className="section-title">Contacts</h2>
        <Link className="btn" href="/admin/people/new">
          + Create Contact
        </Link>
      </div>
      <p className="dim">
        Everybody, on one list: the ones who have signed, the ones being quoted, and the ones who
        only ever downloaded the e-book. The lifecycle chip on each row says which is which, and
        the filter narrows to customers when that is what you are after. One record carries several
        projects and several deals — a second property, a battery added later, a referral in the
        family — which is what gives you accurate history, one portal login and clean reporting.
      </p>

      {!data.ready && (
        <p className="notice">
          {`The database has not caught up yet, so lifecycle, deals and subscriptions are hidden — everything else on this screen works as it did. ${behindSentence(data.behind)}`}
        </p>
      )}

      <PeopleManager
        customers={data.customers}
        crm={data.crm}
        duplicates={data.duplicates}
        dealers={data.dealers}
        isAdmin={session.role === 'admin'}
        crmReady={data.ready}
      />
    </main>
  );
}
