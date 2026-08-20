import { withUser, type SessionIdentity } from '@/lib/db';
import { shortDate, statLabel } from '@/lib/dashboard/filters';
import { loadFinanceView, type DashboardContext } from '@/lib/dashboard/queries';
import {
  Chart,
  Legend,
  LineChart,
  StackedBars,
  StatCard,
  fmtDays,
  fmtInt,
  fmtMoney,
  OK,
  AMBER,
} from './charts';

/**
 * The finance role's dashboard (spec §8): "Pipeline value, completion volumes and
 * milestone-payment status; no workload or stage-detail charts."
 *
 * It reads public.project_financial_metrics, a whitelisted definer view — finance
 * has no read access to public.projects at all. That is why there is no funnel,
 * no workload and no per-stage timing here: the data behind those charts is not
 * reachable from this role, rather than merely not rendered.
 */
export async function FinanceBand({
  session,
  ctx,
}: {
  session: SessionIdentity;
  ctx: DashboardContext;
}) {
  const data = await withUser(session, (client) => loadFinanceView(client, ctx));
  const stat = statLabel(ctx.filters);
  const outstanding = data.invoiced - data.paid;

  return (
    <>
      <p className="band-caption">
        {ctx.period.label} · finance view — pipeline, completions and milestone payments
      </p>
      <div className="stat-cards">
        <StatCard
          value={fmtMoney(data.pipelineValue)}
          label="Pipeline value"
          hint="Contract totals, active projects"
          href="/reports"
        />
        <StatCard value={fmtMoney(data.invoiced)} label="Invoiced" href="/reports" />
        <StatCard value={fmtMoney(data.paid)} label="Paid" href="/reports" />
        <StatCard
          value={fmtMoney(outstanding)}
          label="Outstanding"
          hint="Invoiced, not yet paid"
          href="/reports"
          tone={outstanding > 0 ? 'amber' : 'ok'}
        />
        <StatCard
          value={fmtInt(data.completed)}
          label="Completed this period"
          hint={ctx.period.label}
          href="/reports"
          change={ctx.period.previous ? data.completed - data.completedPrev : null}
        />
        <StatCard
          value={fmtDays(data.avgDays)}
          label={`${stat} days to complete`}
          href="/reports"
          goodDirection="down"
        />
      </div>

      <div className="chart-grid">
        <Chart
          title="Completion volume"
          caption={`12 months to ${shortDate(ctx.period.current.to)} · projects completed`}
          empty="No projects have been completed yet."
          isEmpty={data.volume.length === 0}
        >
          <LineChart
            label="Projects completed per month"
            unit=""
            points={data.volume.map((v) => ({ label: v.label, value: v.completed }))}
          />
        </Chart>

        <Chart
          title="Milestone payments"
          caption={`${ctx.period.label} · every project not cancelled`}
          empty="No projects to report on yet."
          isEmpty={data.milestones.every((m) => m.received + m.pending + m.na === 0)}
          note="N/A is a legitimate answer — a cash deal has no finance milestones — so it is counted separately rather than shown as a gap."
        >
          <StackedBars
            label="Milestone payment status"
            rows={data.milestones.map((m) => ({
              key: m.label,
              label: m.label,
              total: m.received + m.pending + m.na,
              valueLabel: fmtInt(m.received),
              valueSub: 'received',
              segments: [
                { key: 'received', value: m.received, colour: OK, label: 'Received' },
                { key: 'pending', value: m.pending, colour: AMBER, label: 'Outstanding' },
                { key: 'na', value: m.na, colour: '#c9ccd2', label: 'Not applicable' },
              ],
            }))}
          />
          <Legend
            items={[
              { label: 'Received', colour: OK },
              { label: 'Outstanding', colour: AMBER },
              { label: 'Not applicable', colour: '#c9ccd2' },
            ]}
          />
        </Chart>
      </div>

      <p className="dim">
        Workload and stage-detail charts are not part of the finance view. The operational dashboard
        is available to the PM and admin roles; ask an admin if you need a figure from it.
      </p>
    </>
  );
}
