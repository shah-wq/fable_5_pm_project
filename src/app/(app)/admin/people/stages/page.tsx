import Link from 'next/link';
import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { optionalRows } from '@/lib/db-optional';
import { loadContactStageBoard } from '@/lib/contacts/stages';
import { NO_DEAL } from '@/lib/contacts/stage-columns';
import { dealsReady } from '@/lib/deals/service';
import { behindSentence, migrationState } from '@/lib/db-migrations';
import { ContactStageBoard } from './ContactStageBoard';

export const dynamic = 'force-dynamic';

/**
 * Contacts § Contact stages.
 *
 * The contact list as a board. Same people as the table, one card each, in a
 * column for where they have got to — with a first column for everybody nobody
 * has opened a deal for yet, which is the column a contact list needs and a deal
 * board cannot have.
 */
export default async function ContactStagesPage() {
  const session = await guardPath('/admin/people');

  const data = await withUser(session, async (c) => {
    const ready = await dealsReady(c);
    return {
      ready,
      // Only when something is wrong: one extra query on a healthy database
      // buys nothing, and on a broken one it is the whole answer.
      behind: ready ? [] : (await migrationState(c)).behind,
      cards: ready ? await loadContactStageBoard(c) : [],
      lossReasons: ready
        ? await optionalRows<{ id: string; name: string }>(
            c,
            'the loss reasons (public.deal_loss_reasons)',
            `select id, name from public.deal_loss_reasons where is_active order by sort_order, name`
          )
        : [],
    };
  });

  const working = data.cards.filter(
    (c) => c.column !== NO_DEAL && c.column !== 'won' && c.column !== 'lost'
  ).length;
  const waiting = data.cards.filter((c) => c.column === NO_DEAL).length;

  return (
    <main className="surface wide">
      <div className="board-header">
        <div>
          <h1>Contact stages</h1>
          <p className="dim">
            {data.ready
              ? `${data.cards.length} contacts · ${working} being worked · ${waiting} on file with nothing open`
              : 'Every contact, in a column for where they have got to.'}
          </p>
        </div>
        <div className="board-actions">
          <Link className="btn-link" href="/admin/people">
            Table
          </Link>
          <Link className="btn" href="/admin/people/new">
            + Create Contact
          </Link>
        </div>
      </div>

      {!data.ready ? (
        <p className="notice">
          {`The database has not caught up yet, so there are no stages to show. ${behindSentence(data.behind)} Then reload this page.`}
        </p>
      ) : data.cards.length === 0 ? (
        <section className="panel">
          <p className="dim">
            No contacts yet. Create one and they will appear in the first column, waiting for
            somebody to open a deal.
          </p>
        </section>
      ) : (
        <ContactStageBoard
          cards={data.cards}
          isAdmin={session.role === 'admin'}
          lossReasons={data.lossReasons}
        />
      )}
    </main>
  );
}
