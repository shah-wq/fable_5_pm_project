import { withUser, type SessionIdentity } from '@/lib/db';
import { captionFor, shortDate, statLabel } from '@/lib/dashboard/filters';
import {
  STAGE_DURATIONS,
  loadCompletionTrend,
  loadProjection,
  loadStageDurations,
  loadTimeHistogram,
  type DashboardContext,
} from '@/lib/dashboard/queries';
import type { StageKey } from '@/lib/stages/definitions';
import {
  Bars,
  Chart,
  Columns,
  Legend,
  LineChart,
  STAGE_COLOURS,
  StackedColumns,
  WIDE_W,
  fmtDays,
  fmtInt,
} from './charts';

/** Which stage's colour each of the seven duration columns belongs to (§9). */
const DURATION_STAGE: Record<string, StageKey> = {
  survey: 'survey',
  design: 'design',
  permits: 'permits',
  procurement: 'procurement',
  install: 'install',
  inspection: 'inspection_pto',
  pto: 'inspection_pto',
};

/**
 * Band 3 — how long projects take (spec §5).
 *
 * Median by default, average on the toggle: one 90-day permit drags an average
 * badly, so the typical project and the total burden are two different questions
 * and the bar says which one it is answering.
 */
export async function CycleBand({
  session,
  ctx,
  names,
}: {
  session: SessionIdentity;
  ctx: DashboardContext;
  names: { pm?: string | null; dealer?: string | null };
}) {
  const { durations, trend, histogram, projection } = await withUser(session, async (client) => ({
    durations: await loadStageDurations(client, ctx),
    trend: await loadCompletionTrend(client, ctx),
    histogram: await loadTimeHistogram(client, ctx),
    projection: await loadProjection(client, ctx),
  }));

  const f = ctx.filters;
  const caption = captionFor(ctx.period, f, names);
  const stat = statLabel(f);
  const trendWindow = `12 months to ${shortDate(ctx.period.current.to)}`;
  const completions = trend.reduce((n, p) => n + p.completed, 0);

  // How much history the per-stage columns actually rest on.
  const biggestSample = Math.max(0, ...durations.map((d) => d.count));
  const thinSample = biggestSample > 0 && biggestSample <= 2;

  return (
    <>
      <Chart
        title={`${stat} days per stage`}
        caption={`${caption} · stages finished in the period`}
        empty="No stage has been completed in this period yet — the columns fill in as projects move. Widen the date range at the top of the page to see the stages your finished projects went through."
        isEmpty={durations.every((d) => d.value === null)}
        wide
        note={
          <>
            {/* A median of one project is that project, not a median. Saying so
                is the difference between a figure someone can use and a figure
                that quietly misleads — and the fix is a wider date range, which
                the reader will not think of unless told. */}
            {thinSample && (
              <>
                <strong>
                  {biggestSample === 1
                    ? 'Only one project finished a stage in this period'
                    : `At most ${biggestSample} projects finished any one stage in this period`}
                  , so these are single measurements rather than typical times.
                </strong>{' '}
                A solar project takes longer than a month, so a short date range rarely contains
                many finished stages — widen it at the top of the page for a figure worth acting
                on.{' '}
              </>
            )}
            {f.exHold
              ? 'Hold time is recorded per project, not per stage, so there is no honest way to subtract "the hold days that happened during Permit". With the toggle on, projects that were ever held are left out of these seven figures instead.'
              : 'Each column counts only projects that finished that stage inside the period, so a stage nobody completed shows no data rather than a zero.'}
          </>
        }
      >
        <Columns
          label={`${stat} days per stage`}
          width={WIDE_W}
          rows={durations.map((d) => ({
            key: d.key,
            label: d.label,
            value: d.value,
            colour: STAGE_COLOURS[DURATION_STAGE[d.key] ?? 'design'],
            // Plain words, not 'n=4'. The count is how much to trust the column
            // above it, which is exactly the sort of thing nobody reads if it is
            // written in statistics notation.
            sub:
              d.count === 0
                ? undefined
                : d.count === 1
                  ? '1 project'
                  : `${fmtInt(d.count)} projects`,
          }))}
        />
      </Chart>

      <div className="chart-grid">
        <Chart
          title="Completion time trend"
          caption={`${trendWindow} · ${stat.toLowerCase()} total days`}
          empty="No projects have been completed yet, so there is no trend to draw."
          isEmpty={trend.length === 0}
          note="A trend needs history, so this chart always shows the last twelve months rather than the selected period. The PM and dealer filters still apply."
        >
          <LineChart
            label="Median days to completion by month"
            points={trend.map((p) => ({
              label: p.label,
              value: p.value,
              sub: `${p.completed} completed`,
            }))}
          />
        </Chart>

        <Chart
          title="Time distribution"
          caption={`${caption} · projects completed in the period`}
          empty="No completed projects yet, so there is no spread to show."
          isEmpty={histogram.every((b) => b.count === 0)}
          note="The spread an average hides. The long tail on the right is where the problems live."
        >
          <Bars
            label="Projects by days to completion"
            colour={STAGE_COLOURS.permits}
            rows={histogram.map((b) => ({ key: b.label, label: b.label, value: b.count }))}
          />
        </Chart>
      </div>

      <Chart
        title="Stage time breakdown"
        caption={`${trendWindow} · average days per stage, for that month's completions`}
        empty="Nothing has completed in the last twelve months, so there is nothing to break down."
        isEmpty={completions === 0}
        wide
        note="Read the total shrinking month to month, and which stage caused it."
      >
        <StackedColumns
          label="Days per stage for projects completed each month"
          width={WIDE_W}
          points={trend.map((p) => ({ label: p.label, values: p.byStage }))}
          keys={STAGE_DURATIONS.map((s) => ({
            key: s.key === 'procurement' ? 'procurement' : s.key,
            label: s.label,
            colour: STAGE_COLOURS[DURATION_STAGE[s.key] ?? 'design'],
          }))}
        />
        <Legend
          items={STAGE_DURATIONS.map((s) => ({
            label: s.label,
            colour: STAGE_COLOURS[DURATION_STAGE[s.key] ?? 'design'],
          }))}
        />
      </Chart>

      <Chart
        title="Projected completion"
        caption={`Estimate · based on ${fmtInt(projection.basedOn)} completed ${projection.basedOn === 1 ? 'project' : 'projects'}`}
        empty="No projects have completed yet, so there is no history to project from. This chart appears once the first few finish."
        isEmpty={projection.basedOn === 0 || projection.rows.every((r) => r.daysRemaining === null)}
        png={false}
        note={
          projection.basedOn < 10
            ? `An estimate, and a thin one: ${projection.basedOn} completed ${projection.basedOn === 1 ? 'project is' : 'projects are'} not enough history to forecast from. Never quote it to a customer.`
            : 'An estimate: this company’s own average for the stages each project has left. Not a promise, and not a date to give a customer.'
        }
      >
        <table className="mini-table">
          <thead>
            <tr>
              <th scope="col">Currently in</th>
              <th scope="col">Active projects</th>
              <th scope="col">Typical days still to go</th>
            </tr>
          </thead>
          <tbody>
            {projection.rows.map((r) => (
              <tr key={r.stage}>
                <th scope="row">{r.label}</th>
                <td>{fmtInt(r.active)}</td>
                <td>{fmtDays(r.daysRemaining)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Chart>
    </>
  );
}
