import Link from 'next/link';
import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { dealsReady, loadDealCards } from '@/lib/deals/service';
import { behindSentence, migrationState } from '@/lib/db-migrations';
import { DEAL_COLUMNS, DEAL_STAGE_LABELS } from '@/lib/deals/definitions';
import { STAGES, STAGE_LABELS } from '@/lib/stages/definitions';
import { loadProjectCards } from '@/lib/stages/service';
import { Board } from '../pipeline/Board';

export const dynamic = 'force-dynamic';

/**
 * Module 17 · Deals — the board, and every deal as a table.
 *
 * The board follows a sale through delivery: Survey, Design, Permits,
 * Procurement, Install, Inspection & PTO, Complete, with Hold and Cancelled
 * beside them. It is the Pipeline's own board over the projects deals became —
 * not a copy of it — so a move on either is the same move on the same project,
 * and the two cannot disagree. The stages before a sale belong to the contact,
 * on Contact stages; a deal arrives here when its contact signs.
 *
 * The table is still every deal, signed or not, in the deal's own stages.
 */
export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; owner?: string }>;
}) {
  const session = await guardPath('/deals');
  const sp = await searchParams;
  const asTable = sp.view === 'table';

  const data = await withUser(session, async (c) => {
    const ready = await dealsReady(c);
    if (!ready) {
      return { ready, cards: [], behind: (await migrationState(c)).behind };
    }
    return { ready, behind: [] as string[], cards: await loadDealCards(c) };
  });

  if (!data.ready) {
    return (
      <main className="surface wide">
        <h1>Deals</h1>
        <p className="notice">
          {`The database has not caught up yet. ${behindSentence(data.behind)} Then reload this page.`}
        </p>
      </main>
    );
  }

  const open = data.cards.filter((c) => c.column !== 'won' && c.column !== 'lost');
  const weighted = open.reduce((sum, c) => sum + ((c.value ?? 0) * c.probability) / 100, 0);
  const needAction = open.filter((c) => !c.nextAction || c.nextActionDue).length;

  // The board's cards are projects: every stage, Complete and Cancelled
  // included, of the ones a deal became.
  const projects = asTable
    ? []
    : await loadProjectCards(session, {
        includeCompleted: true,
        fromDeals: true,
      });
  const held = projects.filter((p) => p.column === 'hold').length;
  const done = projects.filter((p) => p.column === 'complete').length;
  const inProgress = projects.filter(
    (p) => p.column !== 'hold' && p.column !== 'cancelled' && p.column !== 'complete'
  ).length;

  return (
    // The board takes the whole window, as Contact stages does: nine columns
    // at the reading width of a card do not fit in the page's usual measure,
    // and a pipeline you scroll sideways to see the end of is not a pipeline
    // you can read at a glance. The table keeps the narrower page.
    <main className={asTable ? 'surface wide' : 'surface full-bleed'}>
      <div className="board-header">
        <div>
          <h1>Deals</h1>
          {asTable ? (
            <p className="dim">
              {`${open.length} open · $${Math.round(
                open.reduce((s, c) => s + (c.value ?? 0), 0)
              ).toLocaleString()} in the pipeline · $${Math.round(weighted).toLocaleString()} weighted`}
              {needAction > 0 && ` · ${needAction} need a next action`}
            </p>
          ) : (
            <p className="dim">
              {`${inProgress} in progress · ${held} on hold · ${done} complete — the same board as Pipeline, updating live${
                !['admin', 'ops'].includes(session.role) ? ' · the project team moves the cards' : ''
              }`}
            </p>
          )}
        </div>
        <div className="board-actions">
          <Link className="btn-link" href={asTable ? '/deals' : '/deals?view=table'}>
            {asTable ? 'Board' : 'Table'}
          </Link>
          <Link className="btn" href="/deals/new">
            + New deal
          </Link>
        </div>
      </div>

      {asTable ? (
        data.cards.length === 0 ? (
          <section className="panel">
            <p className="chart-empty">
              No deals yet. Dealer submissions land in New automatically; anything else starts with
              the button above.
            </p>
          </section>
        ) : (
          <div className="table-wrap">
            <table className="projects-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Stage</th>
                  <th>Value</th>
                  <th>Probability</th>
                  <th>Owner</th>
                  <th>Next action</th>
                  <th>Days in stage</th>
                  <th>Missing</th>
                </tr>
              </thead>
              <tbody>
                {data.cards.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/deals/${c.id}`}>{c.personName}</Link>
                      <div className="dim">{c.address ?? c.code}</div>
                    </td>
                    <td>{DEAL_STAGE_LABELS[c.column]}</td>
                    <td>{c.value === null ? '—' : `$${c.value.toLocaleString()}`}</td>
                    <td>
                      {`${c.probability}%`}
                      {/* Part 11: an override is shown as an override, never as a
                        prediction the system made. */}
                      {c.probabilityIsOverride && <span className="dim"> · set by hand</span>}
                    </td>
                    <td>{c.ownerName ?? 'unassigned'}</td>
                    <td>
                      {c.nextAction ? (
                        <>
                          {c.nextAction}
                          <div className={c.nextActionDue ? 'overdue' : 'dim'}>
                            {c.nextActionAt}
                          </div>
                        </>
                      ) : (
                        <span className="overdue">none</span>
                      )}
                    </td>
                    <td>{c.column === 'won' || c.column === 'lost' ? '—' : `${c.daysInStage}d`}</td>
                    <td>
                      {c.missing.length === 0 ? (
                        '—'
                      ) : (
                        <span className="missing-badge" title={c.missing.join('\n')}>
                          {c.missing.length}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <>
          {open.length > 0 && (
            <p className="notice">
              {`${open.length} ${open.length === 1 ? 'deal is' : 'deals are'} not signed yet, so ${
                open.length === 1 ? 'it has' : 'they have'
              } no project on this board. `}
              <Link href="/deals?view=table">See them in the table</Link>
              {', or follow the contacts on '}
              <Link href="/admin/people/stages">Contact stages</Link>.
            </p>
          )}
          {projects.length === 0 ? (
            <section className="panel">
              <p className="chart-empty">
                No signed deals yet. A deal arrives here, at Survey, the moment its contact is moved
                to Contract signed.
              </p>
            </section>
          ) : (
            <Board
              cards={projects}
              isAdmin={session.role === 'admin'}
              className="deal-board"
              // Only the project team moves projects; a rep follows them here.
              readOnly={!['admin', 'ops'].includes(session.role)}
            />
          )}
        </>
      )}

      <p className="dim">
        {asTable
          ? `${DEAL_COLUMNS.map((c) => DEAL_STAGE_LABELS[c]).join(' → ')} — the deal's own stages, before and after signing.`
          : `${STAGES.map((st) => STAGE_LABELS[st]).join(' → ')}, with Hold and Cancelled beside them. One stage forward at a time with the stage form's checks, and an admin able to move a project back for a logged reason — the same rules as Pipeline, because it is the same board.`}
      </p>
    </main>
  );
}
