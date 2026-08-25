import Link from 'next/link';
import { withUser, type SessionIdentity } from '@/lib/db';
import { shortDate } from '@/lib/dashboard/filters';
import { loadAttention, type DashboardContext } from '@/lib/dashboard/queries';
import { STAGE_LABELS } from '@/lib/stages/definitions';
import { loadProjectCards } from '@/lib/stages/service';
import { fmtInt } from './charts';

/**
 * Section 7 — needs attention.
 *
 * The one part of the dashboard that is a list rather than a chart, and the part
 * that will get used most: with no automation layer, this is what replaces the
 * Watchdog. Every row links straight to the project's stage form, because the
 * point of the list is to act on it, not to read it.
 */
export async function AttentionBand({
  session,
  ctx,
}: {
  session: SessionIdentity;
  ctx: DashboardContext;
}) {
  const lists = await withUser(session, (client) => loadAttention(client, ctx));

  // "Missing required fields — computed from the same validation the advance
  // button uses, so it needs no separate rules." That validation is
  // evaluateStage(), which loadProjectCards already runs for every project: this
  // list is the same evaluation, filtered, and cannot drift from the button.
  const cards = await loadProjectCards(session, {
    stage: ctx.filters.stage ?? undefined,
    dealerId: ctx.filters.dealer ?? undefined,
    status: ctx.filters.status ?? undefined,
  });
  const pmFilter = ctx.filters.pm ?? (ctx.filters.mine ? ctx.viewerId : null);
  const blocked = cards
    .filter((c) => c.status === 'active' && c.missing.length > 0)
    .filter((c) => !pmFilter || c.assignedPm === pmFilter)
    .slice(0, 50);

  return (
    <section className="attention-band" id="needs-attention">
      <h2 className="section-title">Needs attention</h2>
      <div className="chart-grid">
        {/* Stage feedback §5: an unhappy customer whose follow-up nobody has
            closed. First in the band on purpose — an ageing permit is a schedule
            problem, this is a person waiting for a call. */}
        <section className="panel attention">
          <h3>
            Unhappy customers <span className="count">{fmtInt(lists.unhappy.length)}</span>
          </h3>
          <p className="chart-caption">
            Rated 1 or 2 out of 5 and the follow-up is still open. Closing one needs a note saying
            what was done — see <Link href="/tasks">Follow-ups</Link>.
          </p>
          {lists.unhappy.length === 0 ? (
            <p className="chart-empty ok">No open follow-ups.</p>
          ) : (
            <ul className="attention-list">
              {lists.unhappy.map((r) => (
                <li key={r.id}>
                  <Link href={`/projects/${r.projectId}`}>{r.name}</Link>
                  <span className="dim">
                    {` ${r.score ?? '—'}/5 on ${r.stageLabel} · ${
                      r.days === 0 ? 'today' : r.days === 1 ? '1 day' : `${r.days} days`
                    }${r.pmName ? ` · ${r.pmName}` : ''}`}
                  </span>
                  {r.comment && <span className="attention-quote">{`“${r.comment}”`}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel attention">
          <h3>
            Ageing projects <span className="count">{fmtInt(lists.ageing.length)}</span>
          </h3>
          <p className="chart-caption">
            Past the day threshold for their current stage, oldest first. Thresholds are per stage
            and set in <Link href="/admin/settings">Admin → Settings</Link> — a week in Procurement
            is fine, a week in Installation is not.
          </p>
          {lists.ageing.length === 0 ? (
            <p className="chart-empty ok">Nothing is past its threshold.</p>
          ) : (
            <ul className="activity">
              {lists.ageing.map((r) => (
                <li key={r.id}>
                  <Link href={`/projects/${r.id}/stages/${r.stage}`}>{r.name}</Link>
                  {/* Template strings rather than adjacent JSX expressions:
                      React puts comment nodes between those in the rendered
                      HTML, which breaks the sentence for anything reading it. */}
                  <span className="over">{`${r.days}d in ${r.stageLabel}`}</span>
                  <span className="dim">
                    {`threshold ${r.threshold}d · ${r.pmName ?? 'Unassigned'} · ${r.dealerName ?? '—'}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel attention">
          <h3>
            On hold too long <span className="count">{fmtInt(lists.holds.length)}</span>
          </h3>
          <p className="chart-caption">
            Past their expected resume date, or held with no expected resume date at all — the worse
            of the two, and the easier to forget.
          </p>
          {lists.holds.length === 0 ? (
            <p className="chart-empty ok">No hold is overdue.</p>
          ) : (
            <ul className="activity">
              {lists.holds.map((r) => (
                <li key={r.id}>
                  <Link href={`/projects/${r.id}/stages/${r.stage}`}>{r.name}</Link>
                  <span className="over">{`${r.holdDays}d held`}</span>
                  <span className="dim">
                    {r.expectedResume
                      ? `expected back ${shortDate(r.expectedResume)}`
                      : 'no expected resume date'}
                    {r.heldSince ? ` · since ${shortDate(r.heldSince)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel attention">
          <h3>
            Missing required fields <span className="count">{fmtInt(blocked.length)}</span>
          </h3>
          <p className="chart-caption">
            The current stage cannot advance until these are filled. Computed from the same checks
            the advance button runs, so the two can never disagree.
          </p>
          {blocked.length === 0 ? (
            <p className="chart-empty ok">Every active project can advance.</p>
          ) : (
            <ul className="activity">
              {blocked.map((c) => (
                <li key={c.id}>
                  <Link href={`/projects/${c.id}/stages/${c.stage}`}>{c.name}</Link>
                  <span className="over">
                    {`${c.missing.length} missing in ${STAGE_LABELS[c.stage]}`}
                  </span>
                  <span className="dim">{c.missing.slice(0, 3).join(' · ')}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel attention">
          <h3>
            Recently cancelled <span className="count">{fmtInt(lists.cancelled.length)}</span>
          </h3>
          <p className="chart-caption">
            With the stage they were cancelled from and the reason, so patterns surface early.
          </p>
          {lists.cancelled.length === 0 ? (
            <p className="chart-empty ok">Nothing has been cancelled.</p>
          ) : (
            <ul className="activity">
              {lists.cancelled.map((r) => (
                <li key={r.id}>
                  <Link href={`/projects/${r.id}`}>{r.name}</Link>
                  <span className="dim">
                    {r.cancelledFrom
                      ? `from ${STAGE_LABELS[r.cancelledFrom as keyof typeof STAGE_LABELS] ?? r.cancelledFrom}`
                      : ''}
                    {r.reason ? ` · ${r.reason}` : ''}
                    {r.date ? ` · ${shortDate(r.date)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}
