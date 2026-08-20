import Link from 'next/link';
import { withUser, type SessionIdentity } from '@/lib/db';
import { captionFor, projectsLink } from '@/lib/dashboard/filters';
import { AGE_BANDS, FUNNEL_STAGES, loadFunnel, loadWorkload, type DashboardContext } from '@/lib/dashboard/queries';
import { STAGE_LABELS } from '@/lib/stages/definitions';
import {
  BAND_COLOURS,
  Chart,
  Legend,
  STAGE_COLOURS,
  StackedBars,
  WIDE_W,
  bandLegend,
  fmtInt,
  fmtPct,
  stageLegend,
  type BarRow,
} from './charts';

/**
 * Band 2 — where every project is (spec §4).
 *
 * The funnel is coloured by age rather than by stage, which is the whole point of
 * §4's aside: a plain funnel tells you seven projects are in Permit, while
 * colouring by how long they have sat there tells you whether that is a healthy
 * queue or six weeks of silence from one AHJ. Same chart, twice the work, from
 * data already stored.
 */
export async function WhereBand({
  session,
  ctx,
  names,
  showPm,
}: {
  session: SessionIdentity;
  ctx: DashboardContext;
  names: { pm?: string | null; dealer?: string | null };
  showPm: boolean;
}) {
  const { funnel, byPm, byDealer } = await withUser(session, async (client) => ({
    funnel: await loadFunnel(client, ctx),
    byPm: showPm ? await loadWorkload(client, ctx, 'pm') : [],
    byDealer: await loadWorkload(client, ctx, 'dealer'),
  }));

  const f = ctx.filters;
  const caption = captionFor(ctx.period, f, names);

  const funnelRows: BarRow[] = funnel.stages.map((s) => ({
    key: s.stage,
    label: s.label,
    total: s.count,
    href: projectsLink(f, { stage: s.stage, status: 'active' }),
    // The count and its share of the active book are two facts, so they are two
    // fields: "3" and "75%", not the string "3 75%".
    valueLabel: fmtInt(s.count),
    valueSub: s.count === 0 ? undefined : fmtPct(s.share),
    segments: AGE_BANDS.map((band) => ({
      key: band,
      value: s.bands[band],
      colour: BAND_COLOURS[band],
      label: `${band} days in stage`,
    })),
  }));

  const workloadRows = (rows: Awaited<ReturnType<typeof loadWorkload>>): BarRow[] =>
    rows.map((r) => ({
      key: r.key ?? r.label,
      label: r.label,
      total: r.total,
      segments: FUNNEL_STAGES.map((stage) => ({
        key: stage,
        value: r.byStage[stage] ?? 0,
        colour: STAGE_COLOURS[stage],
        label: STAGE_LABELS[stage],
      })),
    }));

  return (
    <>
      <Chart
        title="Where every project is"
        caption={`${caption} · active projects, coloured by days in stage`}
        empty="No active projects to show. New projects appear here the moment they are created."
        isEmpty={funnel.activeTotal === 0}
        wide
        note={
          <>
            Bars are coloured by how long each project has been in its stage, not by the stage
            itself — a busy stage and a jammed one look different. Click a stage to open its
            project list.
          </>
        }
      >
        <StackedBars rows={funnelRows} label="Projects per stage, segmented by age" width={WIDE_W} />
        <Legend items={bandLegend()} />
        {/* Hold and Cancelled sit apart from the flow, per §4: they are not
            stages projects pass through. */}
        <div className="funnel-aside">
          <span className="dim">Outside the flow:</span>
          <Link className="stage-chip" href={projectsLink(f, { status: 'on_hold', stage: null })}>
            On hold <strong>{fmtInt(funnel.onHold)}</strong>
          </Link>
          <Link className="stage-chip" href={projectsLink(f, { status: 'cancelled', stage: null })}>
            Cancelled <strong>{fmtInt(funnel.cancelled)}</strong>
          </Link>
        </div>
        <details className="stage-detail">
          <summary>Stage detail — average days, and the oldest project in each</summary>
          <table className="mini-table">
            <thead>
              <tr>
                <th scope="col">Stage</th>
                <th scope="col">Projects</th>
                <th scope="col">Avg. days in stage</th>
                <th scope="col">Oldest</th>
              </tr>
            </thead>
            <tbody>
              {funnel.stages.map((s) => (
                <tr key={s.stage}>
                  <th scope="row">{s.label}</th>
                  <td>{fmtInt(s.count)}</td>
                  <td>{s.avgDaysInStage === null ? '—' : `${s.avgDaysInStage}d`}</td>
                  <td>
                    {s.oldest ? (
                      <>
                        <Link href={`/projects/${s.oldest.id}`}>{s.oldest.name}</Link>{' '}
                        <span className="dim">{s.oldest.days}d</span>
                      </>
                    ) : (
                      <span className="dim">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </Chart>

      <div className="chart-grid">
        {showPm && (
          <Chart
            title="Workload by PM"
            caption={`${caption} · active projects`}
            empty="No active projects are assigned yet."
            isEmpty={byPm.length === 0}
            note="Grouped by assigned PM, so a new PM appears the first time a project is assigned to them. Sorted by total — the person to help is at the top."
          >
            <StackedBars rows={workloadRows(byPm)} label="Active projects per PM, by stage" />
            <Legend items={stageLegend(FUNNEL_STAGES)} />
          </Chart>
        )}

        <Chart
          title="Workload by dealer"
          caption={`${caption} · active projects`}
          empty="No dealer has an active project yet."
          isEmpty={byDealer.length === 0}
          note="Dealers with no projects are left out rather than shown as empty rows."
        >
          <StackedBars rows={workloadRows(byDealer)} label="Active projects per dealer, by stage" />
          <Legend items={stageLegend(FUNNEL_STAGES)} />
        </Chart>
      </div>
    </>
  );
}
