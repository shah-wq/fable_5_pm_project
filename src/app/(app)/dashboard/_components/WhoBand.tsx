import Link from 'next/link';
import { withUser, type SessionIdentity } from '@/lib/db';
import { captionFor, shortDate, statLabel } from '@/lib/dashboard/filters';
import {
  FUNNEL_STAGES,
  STAGE_DURATIONS,
  loadDealerComparison,
  loadDealerVolume,
  loadPmStats,
  loadRecent,
  loadStageMatrix,
  monthLabel,
  type DashboardContext,
} from '@/lib/dashboard/queries';
import { STAGE_LABELS } from '@/lib/stages/definitions';
import type { DashboardView } from '@/lib/dashboard/view';
import {
  Bars,
  Chart,
  HEAT_LEGEND,
  HeatMap,
  Legend,
  MultiLine,
  SERIES_COLOURS,
  STAGE_COLOURS,
  StackedBars,
  fmtDays,
  fmtInt,
  fmtMoney,
  fmtPct,
  stageLegend,
} from './charts';

/** Six lines is the most anyone can read at once; the rest are summed. */
const MAX_SERIES = 6;

/**
 * Band 4 — dealers, PMs and projects (spec §6).
 *
 * The stage matrix at the bottom is the densest thing on the page and worth the
 * space: reading down a column shows a systemic bottleneck, reading across a row
 * shows one troubled project.
 */
export async function WhoBand({
  session,
  ctx,
  view,
  names,
  showPm,
}: {
  session: SessionIdentity;
  ctx: DashboardContext;
  view: DashboardView;
  names: { pm?: string | null; dealer?: string | null };
  showPm: boolean;
}) {
  const { dealers, volume, pms, matrix, completed, created } = await withUser(
    session,
    async (client) => ({
      dealers: await loadDealerComparison(client, ctx, { financial: view.financial }),
      volume: await loadDealerVolume(client, ctx),
      pms: showPm ? await loadPmStats(client, ctx) : [],
      matrix: await loadStageMatrix(client, ctx),
      completed: await loadRecent(client, ctx, 'completed'),
      created: await loadRecent(client, ctx, 'created'),
    })
  );

  const f = ctx.filters;
  const caption = captionFor(ctx.period, f, names);
  const stat = statLabel(f);
  const peakActive = Math.max(1, ...dealers.map((d) => d.active));

  // Top dealers by volume get their own line; everything below is one line, so
  // the total still adds up and the cap is visible rather than silent.
  const top = volume.dealers.slice(0, MAX_SERIES);
  const rest = volume.dealers.slice(MAX_SERIES);
  const series = [
    ...top.map((d, i) => ({
      key: d.id,
      label: d.name,
      values: d.counts,
      colour: SERIES_COLOURS[i % SERIES_COLOURS.length],
    })),
    ...(rest.length > 0
      ? [
          {
            key: 'others',
            label: `${rest.length} other dealers`,
            values: volume.months.map((_, i) => rest.reduce((n, d) => n + d.counts[i], 0)),
            colour: '#9aa2ae',
          },
        ]
      : []),
  ];

  return (
    <>
      <Chart
        title="Dealer comparison"
        caption={`${caption} · completions counted in the period`}
        empty="No dealer has a project yet."
        isEmpty={dealers.length === 0}
        wide
        png={false}
        note="Inline bars so the outliers are visible without reading the numbers. Cancellation rate is over each dealer's whole book, not the period."
      >
        <div className="table-wrap">
          <table className="projects-table">
            <thead>
              <tr>
                <th scope="col">Dealer</th>
                <th scope="col">Active</th>
                <th scope="col">Completed</th>
                <th scope="col">{stat} days</th>
                <th scope="col">Cancelled</th>
                {view.financial && <th scope="col">Pipeline</th>}
              </tr>
            </thead>
            <tbody>
              {dealers.map((d) => (
                <tr key={d.id}>
                  <th scope="row">
                    <Link href={`/projects?dealer=${d.id}`}>{d.name}</Link>
                  </th>
                  <td>
                    <span className="cell-bar" aria-hidden>
                      <span style={{ width: `${(d.active / peakActive) * 100}%` }} />
                    </span>
                    {fmtInt(d.active)}
                  </td>
                  <td>{fmtInt(d.completed)}</td>
                  <td>{fmtDays(d.avgDays)}</td>
                  <td>
                    {fmtInt(d.cancelled)}{' '}
                    <span className={d.cancellationRate > 0.15 ? 'rate bad' : 'rate'}>
                      {fmtPct(d.cancellationRate)}
                    </span>
                  </td>
                  {view.financial && <td>{fmtMoney(d.pipelineValue)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Chart>

      <div className="chart-grid">
        <Chart
          title="Dealer volume trend"
          caption={`12 months to ${shortDate(ctx.period.current.to)} · projects created`}
          empty="No projects have been created in the last twelve months."
          isEmpty={volume.months.length === 0}
          note={
            rest.length > 0
              ? `The ${MAX_SERIES} largest dealers have their own line; the remaining ${rest.length} are summed into one so the chart stays readable.`
              : 'Who is growing, and who has gone quiet.'
          }
        >
          <MultiLine
            label="Projects created per dealer per month"
            months={volume.months.map(monthLabel)}
            series={series}
          />
          <Legend items={series.map((s) => ({ label: s.label, colour: s.colour }))} />
        </Chart>

        <Chart
          title="Dealer stage spread"
          caption={`${caption} · active projects`}
          empty="No dealer has an active project yet."
          isEmpty={dealers.every((d) => Object.keys(d.byStage).length === 0)}
          note="Surfaces a dealer whose jobs consistently stall at one stage."
        >
          <StackedBars
            label="Active projects per dealer, by stage"
            rows={dealers
              .filter((d) => Object.keys(d.byStage).length > 0)
              .map((d) => ({
                key: d.id,
                label: d.name,
                total: Object.values(d.byStage).reduce((a, b) => a + b, 0),
                segments: FUNNEL_STAGES.map((stage) => ({
                  key: stage,
                  value: d.byStage[stage] ?? 0,
                  colour: STAGE_COLOURS[stage],
                  label: STAGE_LABELS[stage],
                })),
              }))}
          />
          <Legend items={stageLegend(FUNNEL_STAGES)} />
        </Chart>
      </div>

      {showPm && (
        <div className="chart-grid">
          <Chart
            title="Projects per PM"
            caption={`${caption} · active projects`}
            empty="No active projects are assigned yet."
            isEmpty={pms.every((p) => p.active === 0)}
            note="The load-balancing view."
          >
            <Bars
              label="Active projects per PM"
              colour={STAGE_COLOURS.design}
              rows={pms.map((p) => ({ key: p.id ?? p.name, label: p.name, value: p.active }))}
            />
          </Chart>

          <Chart
            title="Ageing projects by PM"
            caption={`${caption} · past the stage threshold`}
            empty="Nothing is past its threshold — every active project moved recently."
            isEmpty={pms.every((p) => p.ageing === 0)}
            note="The fairest workload signal on the page: it counts what is stuck, not what is assigned."
          >
            <Bars
              label="Ageing projects per PM"
              colour="#b3261e"
              rows={pms.map((p) => ({ key: p.id ?? p.name, label: p.name, value: p.ageing }))}
            />
          </Chart>

          <Chart
            title="Median reply time by PM"
            caption={`${caption} · hours to first reply on a customer message`}
            empty="No customer messages have been answered yet, so there is no reply time to show."
            isEmpty={pms.every((p) => p.replyHours === null)}
            note="From the project chat. Read it as a staffing signal, not a scoreboard: a PM covering for someone on leave will look slower, and that is the system working."
          >
            <Bars
              label="Median hours to first reply per PM"
              colour={STAGE_COLOURS.inspection_pto}
              rows={pms
                .filter((p) => p.replyHours !== null)
                .map((p) => ({
                  key: p.id ?? p.name,
                  label: p.name,
                  value: p.replyHours!,
                  valueLabel: `${p.replyHours}h`,
                  valueSub: `from ${p.replied}`,
                }))}
            />
          </Chart>

          <Chart
            title={`${stat} completion by PM`}
            caption={`${caption} · projects each PM closed in the period`}
            empty="No PM has completed a project in this period yet."
            isEmpty={pms.every((p) => p.avgDays === null)}
            note="Read this carefully. PMs do not get comparable projects — one difficult jurisdiction can account for the whole gap — so this is a prompt to ask why, not a league table."
          >
            <Bars
              label="Median days to completion per PM"
              colour={STAGE_COLOURS.procurement}
              rows={pms
                .filter((p) => p.avgDays !== null)
                .map((p) => ({
                  key: p.id ?? p.name,
                  label: p.name,
                  value: p.avgDays!,
                  // The figure and how many projects it averages, as two fields —
                  // the sample size is what stops this being read as a ranking,
                  // so it is written in words rather than as 'n=3'.
                  valueLabel: `${p.avgDays}d`,
                  valueSub: p.completed === 1 ? 'from 1' : `from ${p.completed}`,
                }))}
            />
          </Chart>
        </div>
      )}

      <Chart
        title="Project stage matrix"
        caption={`${caption} · days spent in each stage`}
        empty="No projects to map yet."
        isEmpty={matrix.rows.length === 0}
        wide
        png={false}
        note={
          matrix.total > matrix.rows.length
            ? `The ${matrix.rows.length} projects with the longest time in their current stage, of ${fmtInt(matrix.total)} matching the filter. Scrolls sideways on a narrow screen.`
            : 'Down a column is a systemic bottleneck; across a row is one troubled project.'
        }
      >
        <HeatMap
          rows={matrix.rows}
          columns={STAGE_DURATIONS.map((s) => ({ key: s.key, label: s.label }))}
        />
        <Legend items={HEAT_LEGEND} />
      </Chart>

      <div className="chart-grid">
        <section className="panel">
          <h2>Recently completed</h2>
          {completed.length === 0 ? (
            <p className="chart-empty">No completed projects yet.</p>
          ) : (
            <ul className="activity">
              {completed.map((r) => (
                <li key={r.id}>
                  <Link href={`/projects/${r.id}`}>{r.name}</Link>{' '}
                  <span className="dim">
                    {r.totalDays === null ? '' : `${r.totalDays}d · `}
                    {r.dealerName ?? '—'}
                    {r.date ? ` · ${shortDate(r.date)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>Recently created</h2>
          {created.length === 0 ? (
            <p className="chart-empty">No projects yet.</p>
          ) : (
            <ul className="activity">
              {created.map((r) => (
                <li key={r.id}>
                  <Link href={`/projects/${r.id}`}>{r.name}</Link>{' '}
                  <span className="dim">
                    {r.pmName ?? 'Unassigned'} · {r.dealerName ?? '—'}
                    {r.date ? ` · ${shortDate(r.date)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
