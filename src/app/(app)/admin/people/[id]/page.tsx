import { notFound } from 'next/navigation';
import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { optionalRows } from '@/lib/db-optional';
import { loadCustomers } from '@/lib/customers/service';
import { isSchemaDrift } from '@/lib/db-drift';
import { behindSentence, migrationState } from '@/lib/db-migrations';
import { ContactRecord } from './ContactRecord';

export const dynamic = 'force-dynamic';

/**
 * Contacts § one contact.
 *
 * Its own page rather than a panel over the list, so that editing a contact and
 * creating one are the same screen at the same width. The drawer stays on the
 * list for a glance and a one-field correction.
 */
export default async function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await guardPath('/admin/people');

  let data;
  try {
    data = await withUser(session, async (c) => ({
      // The list loader, filtered to one: the record needs every roll-up the
      // row has, and one query that both screens share cannot disagree with
      // itself about what a person looks like.
      customer: (await loadCustomers(c)).find((row) => row.id === id) ?? null,
      dealers: (await c.query('select id, name from public.dealers where is_active order by name')).rows,
      // The deal whose system was recorded at signing, if there is one. Until
      // there is, the record says nothing about systems at all — there is
      // nothing true to say. Degrades to none on a database without 003900.
      signed:
        (
          await optionalRows<{
            id: string;
            stage: string;
            system_recorded_at: string;
            project_id: string | null;
            project_code: string | null;
          }>(
            c,
            'the signed system',
            `select d.id, d.stage, d.system_recorded_at::text,
                    p.id as project_id, p.code as project_code
               from public.deals d
               left join public.projects p on p.id = d.project_id
              where d.client_id = $1 and d.system_recorded_at is not null
              order by d.system_recorded_at desc limit 1`,
            [id]
          )
        )[0] ?? null,
    }));
  } catch (error) {
    if (!isSchemaDrift(error)) throw error;
    const behind = await withUser(session, async (c) => (await migrationState(c)).behind);
    return (
      <main className="table-page">
        <p className="notice" role="alert">
          {`This screen needs part of the schema that is not there yet. ${behindSentence(behind)}`}
        </p>
      </main>
    );
  }

  if (!data.customer) notFound();

  return (
    <main className="table-page">
      <ContactRecord
        customer={data.customer}
        dealers={data.dealers}
        isAdmin={session.role === 'admin'}
        signed={data.signed}
      />
    </main>
  );
}
