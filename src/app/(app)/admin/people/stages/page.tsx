import Link from 'next/link';
import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { contactStagesReady, loadContactStageBoard } from '@/lib/contacts/stages';
import { behindSentence, migrationState } from '@/lib/db-migrations';
import { ContactStageBoard } from './ContactStageBoard';

export const dynamic = 'force-dynamic';

/**
 * Contacts § Contact stages.
 *
 * The contact list as a board, in the stages the business works: created,
 * scheduled, rescheduled, no-show, quoted, financing approved, contract signed,
 * lost. Every contact has one card from the moment they exist, because the stage
 * belongs to the person rather than to a deal somebody may not have opened yet.
 */
export default async function ContactStagesPage() {
  const session = await guardPath('/admin/people');

  const data = await withUser(session, async (c) => {
    const ready = await contactStagesReady(c);
    return {
      ready,
      behind: ready ? [] : (await migrationState(c)).behind,
      cards: ready ? await loadContactStageBoard(c) : [],
    };
  });

  return (
    <main className="surface full-bleed">
      <div className="board-header">
        <div>
          <h1>Contact stages</h1>
          <p className="dim">
            {data.ready
              ? `${data.cards.length} contacts. Drag a card into any column — these stages move sideways and backwards as often as forwards.`
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
            No contacts yet. Create one and they will appear in the first column.
          </p>
        </section>
      ) : (
        <ContactStageBoard cards={data.cards} />
      )}
    </main>
  );
}
