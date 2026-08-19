import Link from 'next/link';
import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { loadDealerDashboard } from '@/lib/dealer/dashboard';
import { dealerScope, loadDealerProjects, loadDealerStats } from '@/lib/dealer/portal';
import { AGE_BANDS } from '@/lib/dashboard/queries';
import { STAGE_LABELS } from '@/lib/stages/definitions';
import { BAND_COLOURS, Legend, StackedBars, bandLegend } from '../dashboard/_components/charts';

export const dynamic = 'force-dynamic';

/** Days in one stage before a project shows up in Needs attention. */
const ATTENTION_DAYS = 21;

/**
 * Dealer dashboard: four stat cards, projects by stage, and the two things a
 * dealer opens the portal for — what is moving (recent activity) and what is
 * stuck (needs attention). Read-only over the PM's data, RLS-scoped to their
 * own book.
 */
export default async function DealerDashboard() {
  const session = await guardPath('/dealers');

  const data = await withUser(session, async (c) => {
    const stats = await loadDealerStats(c, session);
    const projects = await loadDealerProjects(c, session);
    const scope = await dealerScope(c, session);
    const activity = await c.query(
      `select e.changed_at, e.to_stage, p.name
       from public.project_stage_events e
       join public.projects p on p.id = e.project_id
       where true ${scope.clause.replace('$SCOPE$', '$1')}
       order by e.changed_at desc limit 20`,
      scope.params
    );
    // The dashboard module's reduced dealer view. Degrades to the older
    // hand-rolled figures below if the database has not run 002800 yet.
    const dash = await loadDealerDashboard(c, session);
    return { stats, projects, activity: activity.rows, dash };
  });

  // The staff dashboard's per-stage thresholds when they are available, and the
  // old flat 21 days when they are not — the same list either way, so the page
  // never loses a section over a migration that has not been pasted yet.
  const attention = data.dash.available
    ? []
    : data.projects.filter(
        (p) => p.status === 'on_hold' || (p.status === 'active' && p.daysInStage > ATTENTION_DAYS)
      );

  return (
    <main className="surface wide">
      <div className="board-header">
        <h1>Dashboard</h1>
        <div className="board-actions">
          <Link className="btn-link primary" href="/dealers/leads">
            + Submit a lead
          </Link>
        </div>
      </div>

      <div className="stat-cards">
        <div className="stat-card">
          <span className="stat-value">{data.stats.active}</span>
          <span className="stat-label">Active projects</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{data.stats.completedThisQuarter}</span>
          <span className="stat-label">Completed this quarter</span>
        </div>
        <div className="stat-card">
          {/* Median once the dashboard view is available: one slow permit drags
              an average badly, and a dealer with four projects would see it. */}
          <span className="stat-value">
            {data.dash.available
              ? (data.dash.medianDaysToComplete ?? '—')
              : (data.stats.avgDaysToCompletion ?? '—')}
          </span>
          <span className="stat-label">
            {data.dash.available ? 'Median days to completion' : 'Avg. days to completion'}
          </span>
          {data.dash.available && data.dash.completedTotal > 0 && (
            <span className="stat-hint">
              over {data.dash.completedTotal} completed{' '}
              {data.dash.completedTotal === 1 ? 'project' : 'projects'}
            </span>
          )}
        </div>
        <div className="stat-card">
          <span className="stat-value">
            ${data.stats.commissionPending.toLocaleString()}
          </span>
          <span className="stat-label">Commission pending</span>
        </div>
      </div>

      {/* Their projects by stage, coloured by how long each has been sitting —
          the same chart the PM sees, over the same view, scoped by RLS to this
          dealer's own book (spec §8). */}
      {data.dash.available && data.dash.activeTotal > 0 && (
        <section className="panel chart">
          <header className="chart-head">
            <div>
              <h2>Your projects by stage</h2>
              <p className="chart-caption">
                Active projects, coloured by days in stage. Click a stage to open the list.
              </p>
            </div>
          </header>
          <StackedBars
            label="Your active projects per stage, by age"
            rows={data.dash.spread.map((s) => ({
              key: s.stage,
              label: s.label,
              total: s.count,
              href: `/dealers/projects?stage=${s.stage}`,
              segments: AGE_BANDS.map((band) => ({
                key: band,
                value: s.bands[band],
                colour: BAND_COLOURS[band],
                label: `${band} days in stage`,
              })),
            }))}
          />
          <Legend items={bandLegend()} />
        </section>
      )}

      <section className="panel">
        <h2>Projects by stage</h2>
        <div className="stage-chips">
          {data.stats.byColumn.map((c) => (
            <Link
              key={c.key}
              className={`stage-chip${c.count === 0 ? ' empty' : ''}`}
              href={
                c.key === 'hold'
                  ? '/dealers/projects?status=on_hold'
                  : c.key === 'cancelled'
                    ? '/dealers/projects?status=cancelled'
                    : `/dealers/projects?stage=${c.key}`
              }
            >
              {c.label} <strong>{c.count}</strong>
            </Link>
          ))}
        </div>
      </section>

      <div className="detail-grid">
        <section className="panel">
          <h2>Needs attention</h2>
          {data.dash.available ? (
            data.dash.ageing.length === 0 ? (
              <p className="dim">Nothing stuck — every active project moved recently.</p>
            ) : (
              <ul className="activity">
                {data.dash.ageing.map((p) => (
                  <li key={p.id}>
                    <Link href={`/dealers/projects/${p.id}`}>{p.name}</Link>{' '}
                    {/* One template string, not a row of JSX expressions: React
                        separates adjacent expressions with comment nodes in the
                        server-rendered HTML, which would break the sentence up
                        for anything reading the markup. */}
                    <span className="dim">
                      {`${p.days}d in ${p.stageLabel} — past ${p.threshold}d`}
                    </span>
                  </li>
                ))}
              </ul>
            )
          ) : attention.length === 0 ? (
            <p className="dim">Nothing stuck — every active project moved recently.</p>
          ) : (
            <ul className="activity">
              {attention.map((p) => (
                <li key={p.id}>
                  <Link href={`/dealers/projects/${p.id}`}>{p.name}</Link>{' '}
                  {p.status === 'on_hold' ? (
                    <span className="hold-chip">On hold</span>
                  ) : (
                    <span className="dim">
                      {p.daysInStage}d in {STAGE_LABELS[p.stage]}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>Recent activity</h2>
          <ul className="activity">
            {data.activity.map((e, i) => (
              <li key={i}>
                <span className="dim">
                  {new Date(e.changed_at).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                  })}
                </span>{' '}
                {e.name} moved to {STAGE_LABELS[e.to_stage as keyof typeof STAGE_LABELS] ?? e.to_stage}
              </li>
            ))}
            {data.activity.length === 0 && <li className="dim">No stage moves yet.</li>}
          </ul>
        </section>
      </div>
    </main>
  );
}
