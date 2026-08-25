import Link from 'next/link';
import { loadSentiment, type Sentiment } from '@/lib/dashboard/queries';
import { withUser, type SessionIdentity } from '@/lib/db';
import { Bars, Columns, LineChart, STAGE_COLOURS, StatCard, WIDE_W } from './charts';

/**
 * Loaded inside its own Suspense boundary, like every other band: the ratings
 * are seven aggregate queries and the page must not wait on them to show the
 * headline numbers.
 */
export async function SentimentBandLoader({ session }: { session: SessionIdentity }) {
  const data = await withUser(session, (client) => loadSentiment(client));
  return <SentimentBand data={data} />;
}

/**
 * Customer sentiment on the dashboard (Stage feedback §7).
 *
 * The headline is deliberately not the average: §7 asks for "average score per
 * stage across the period, with response counts" and calls that the headline
 * view because "it names the stage that is costing you goodwill". One number for
 * the whole business tells you nothing you can act on; per stage tells you where
 * to look.
 *
 * Two rules from §6 and §7 shape what is on screen:
 *  - every average carries its sample size, because an average of three answers
 *    and an average of ninety are different facts;
 *  - the verbatim log is here rather than being summarised away. "The most useful
 *    part of the whole module — read it, do not just average it."
 */
export function SentimentBand({ data }: { data: Sentiment }) {
  if (!data.ready) {
    return (
      <section className="chart-band" id="sentiment">
        <h2 className="section-title">Customer ratings</h2>
        <section className="panel">
          <p className="chart-empty">
            Customer ratings arrive with <code>db/dist/20260803003200-stage-feedback.sql</code>. Run
            it in the SQL editor and this band fills itself from the next completed stage onwards.
          </p>
        </section>
      </section>
    );
  }

  const answered = data.channels.reduce((n, c) => n + c.responses, 0);
  const asked = data.channels.reduce((n, c) => n + c.requests, 0);
  const rate = asked === 0 ? null : Math.round((answered / asked) * 100);
  const emailShare =
    answered === 0
      ? null
      : Math.round(
          ((data.channels.find((c) => c.channel === 'email')?.responses ?? 0) / answered) * 100
        );

  return (
    <section className="chart-band" id="sentiment">
      <h2 className="section-title">Customer ratings</h2>

      <div className="stat-cards">
        <StatCard
          value={rate === null ? '—' : `${rate}%`}
          label="Response rate"
          href="#sentiment"
          hint={`${answered} answered of ${asked} asked`}
        />
        <StatCard
          value={data.nps.score === null ? '—' : String(data.nps.score)}
          label="Recommendation score"
          href="#sentiment"
          hint={
            data.nps.score === null
              ? 'No completed projects have answered yet'
              : `${data.nps.promoters} would recommend, ${data.nps.detractors} would not`
          }
        />
        <StatCard
          value={String(data.tasks.open)}
          label="Open follow-ups"
          href="/tasks"
          tone={data.tasks.open > 0 ? 'danger' : 'ok'}
          hint={
            data.tasks.oldestOpenDays === null
              ? 'Every low rating has been answered'
              : `Oldest ${data.tasks.oldestOpenDays} days`
          }
        />
        <StatCard
          value={data.tasks.avgDaysToClose === null ? '—' : `${data.tasks.avgDaysToClose}d`}
          label="Average time to close"
          href="/tasks"
          hint={`${data.tasks.closed} closed with a note`}
        />
      </div>

      <div className="chart-grid">
        {/* The headline (§7). Response counts sit beside every bar. */}
        <Columns
          label="Average rating by stage"
          unit=""
          width={WIDE_W}
          // The count travels with every average (§7): a 4.9 from two answers
          // and a 4.9 from ninety are different facts, and the chart has to say
          // which one it is showing.
          rows={data.byStage.map((s) => ({
            key: s.stage,
            label: s.label,
            value: s.avgScore,
            colour: STAGE_COLOURS[s.stage],
            sub:
              s.responses === 0
                ? 'no answers'
                : `${s.responses} ${s.responses === 1 ? 'answer' : 'answers'}`,
          }))}
        />

        {/* §7: "average score by month, so you can see whether a fix worked". */}
        <LineChart
          label="Rating trend"
          unit=""
          points={data.monthly.map((m) => ({
            label: m.month,
            value: m.avgScore,
            sub: `${m.responses} answered`,
          }))}
        />
      </div>

      <div className="chart-grid">
        {/* §6: sample sizes attached, minimum three responses, and framed as a
            prompt for a conversation rather than a league table. */}
        <section className="panel chart">
          <h3>By the people involved</h3>
          <p className="chart-caption">
            Lowest first, and only where at least three customers have answered. This is a prompt
            for a conversation, not a league table — one difficult project can move a small sample a
            long way.
          </p>
          {data.parties.length === 0 ? (
            <p className="chart-empty">
              Nobody has three answers yet. The table appears as the ratings come in.
            </p>
          ) : (
            <Bars
              label="Average rating by person"
              rows={data.parties.map((p) => ({
                key: `${p.kind}-${p.name}`,
                label: `${p.name} · ${p.kind}`,
                value: p.avgScore,
                valueLabel: p.avgScore.toFixed(1),
                valueSub: `${p.responses} answers`,
              }))}
            />
          )}
        </section>

        {/* §7: where the answers come from. "If the email fallback carries most
            responses, that tells you something about the portal." */}
        <section className="panel chart">
          <h3>Where answers come from</h3>
          <p className="chart-caption">
            {emailShare === null
              ? 'No answers yet.'
              : emailShare >= 60
                ? `${emailShare}% arrive by email rather than in the app — worth asking whether the sheet is appearing when people actually open the portal.`
                : `${emailShare}% arrive by email; the rest are answered in the portal or the app.`}
          </p>
          <table className="projects-table">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Asked</th>
                <th>Answered</th>
              </tr>
            </thead>
            <tbody>
              {data.channels.map((c) => (
                <tr key={c.channel}>
                  <td>{c.channel === 'unanswered' ? 'Not answered' : c.channel}</td>
                  <td>{c.requests}</td>
                  <td>{c.responses}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      {/* §7's "most useful part of the whole module". */}
      <section className="panel">
        <h3>What customers actually said</h3>
        <p className="chart-caption">
          The most recent comments, in full. <Link href="/feedback">Read and search them all</Link>.
        </p>
        {data.verbatims.length === 0 ? (
          <p className="chart-empty">No comments yet — a score on its own is still a score.</p>
        ) : (
          <ul className="verbatim-list">
            {data.verbatims.map((v) => (
              <li key={v.id}>
                <span className={`verbatim-score s${v.score ?? 0}`}>{v.score ?? '—'}</span>
                <div>
                  <p className="verbatim-text">{`“${v.comment}”`}</p>
                  <p className="dim">
                    {`${v.stageLabel} · `}
                    <Link href={`/projects/${v.projectId}`}>{v.projectName}</Link>
                    {v.pmName ? ` · ${v.pmName}` : ''}
                    {v.respondedAt ? ` · ${v.respondedAt.slice(0, 10)}` : ''}
                    {v.score !== null && v.score <= 2 ? (v.resolved ? ' · followed up' : ' · open') : ''}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
