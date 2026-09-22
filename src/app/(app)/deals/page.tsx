import Link from 'next/link';
import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { optionalRows } from '@/lib/db-optional';
import { dealsReady, loadDealCards } from '@/lib/deals/service';
import { behindSentence, migrationState } from '@/lib/db-migrations';
import { DEAL_COLUMNS, DEAL_STAGE_LABELS } from '@/lib/deals/definitions';
import { DealBoard } from './DealBoard';

export const dynamic = 'force-dynamic';

/**
 * Module 17 · Deals — the board, and the same list as a table.
 *
 * Part 1: the board mirrors the Pipeline board, "same components, same card
 * layout, same drag behaviour, same missing-items badge, same column-header
 * counts", because a second board that behaves differently on the same gesture
 * is worse than no second board.
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
      return { ready, cards: [], lossReasons: [], behind: (await migrationState(c)).behind };
    }
    return {
      ready,
      behind: [] as string[],
      cards: await loadDealCards(c),
      lossReasons: await optionalRows<{ id: string; name: string }>(
        c,
        'the loss reasons (public.deal_loss_reasons)',
        `select id, name from public.deal_loss_reasons where is_active order by sort_order, name`
      ),
    };
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

  return (
    // The board takes the whole window, as Contact stages does: eight columns
    // at the reading width of a card do not fit in the page's usual measure,
    // and a pipeline you scroll sideways to see the end of is not a pipeline
    // you can read at a glance. The table keeps the narrower page.
    <main className={asTable ? 'surface wide' : 'surface full-bleed'}>
      <div className="board-header">
        <div>
          <h1>Deals</h1>
          <p className="dim">
            {`${open.length} open · $${Math.round(
              open.reduce((s, c) => s + (c.value ?? 0), 0)
            ).toLocaleString()} in the pipeline · $${Math.round(weighted).toLocaleString()} weighted`}
            {needAction > 0 && ` · ${needAction} need a next action`}
          </p>
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

      {data.cards.length === 0 ? (
        <section className="panel">
          <p className="chart-empty">
            No deals yet. Dealer submissions land in New automatically; anything else starts
            with the button above.
          </p>
        </section>
      ) : asTable ? (
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
                        <div className={c.nextActionDue ? 'overdue' : 'dim'}>{c.nextActionAt}</div>
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
      ) : (
        <DealBoard
          cards={data.cards}
          isAdmin={session.role === 'admin'}
          lossReasons={data.lossReasons}
        />
      )}

      <p className="dim">
        {DEAL_COLUMNS.map((c) => DEAL_STAGE_LABELS[c]).join(' → ')}. Forward-only, with an
        admin able to move a deal back for a logged reason — the same rule the project board
        follows, through the same service.
      </p>
    </main>
  );
}
