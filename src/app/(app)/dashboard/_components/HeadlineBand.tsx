import { withUser, type SessionIdentity } from '@/lib/db';
import { captionFor, projectsLink, statLabel } from '@/lib/dashboard/filters';
import { loadHeadline, type DashboardContext } from '@/lib/dashboard/queries';
import type { DashboardView } from '@/lib/dashboard/view';
import { StatCard, fmtDays, fmtInt, fmtMoney } from './charts';

/**
 * Band 1 — the state of the business in one glance (spec §3).
 *
 * Six numbers, each of which is a link. Three describe right now (active, on
 * hold, needs attention) and three describe the period (completed, average days,
 * and — where the role has it — pipeline value); the captions say which, because
 * a card that silently changes meaning when someone picks a date range is worse
 * than no card.
 */
export async function HeadlineBand({
  session,
  ctx,
  view,
  onHoldThreshold,
  names,
}: {
  session: SessionIdentity;
  ctx: DashboardContext;
  view: DashboardView;
  onHoldThreshold: number;
  names: { pm?: string | null; dealer?: string | null };
}) {
  const data = await withUser(session, (client) =>
    loadHeadline(client, ctx, { financial: view.financial, onHoldThreshold })
  );
  const f = ctx.filters;
  const caption = captionFor(ctx.period, f, names);

  return (
    <section aria-label="Headline numbers">
      <p className="band-caption">{caption}</p>
      <div className="stat-cards">
        <StatCard
          value={fmtInt(data.active)}
          label="Active projects"
          hint="Not complete or cancelled"
          href={projectsLink(f, { status: 'open' })}
          change={data.activeChange}
          changeLabel="vs end of last period"
          spark={data.sparkline.map((p) => p.count)}
        />
        <StatCard
          value={fmtInt(data.completed)}
          label="Completed this period"
          hint={ctx.period.label}
          href={projectsLink(f, { status: 'complete' })}
          change={ctx.period.previous ? data.completed - data.completedPrev : null}
        />
        <StatCard
          value={fmtDays(data.avgDaysToComplete)}
          label={`${statLabel(f)} days to complete`}
          hint={f.exHold ? 'Hold time excluded' : 'Created → completion date'}
          href={projectsLink(f, { status: 'complete' })}
          change={
            data.avgDaysToComplete !== null && data.avgDaysToCompletePrev !== null
              ? data.avgDaysToComplete - data.avgDaysToCompletePrev
              : null
          }
          // Getting faster is the good news, so a fall is the green arrow.
          goodDirection="down"
        />
        <StatCard
          value={fmtInt(data.onHold)}
          label="Projects on hold"
          hint={data.onHold > onHoldThreshold ? `Above the ${onHoldThreshold} threshold` : undefined}
          href={projectsLink(f, { status: 'on_hold' })}
          tone={data.onHold > onHoldThreshold ? 'amber' : 'plain'}
        />
        <StatCard
          value={fmtInt(data.needsAttention)}
          label="Needs attention"
          hint="Past its stage's threshold"
          // The list itself is further down the same page: this number IS that
          // list, and §7 is the part people use most.
          href="#needs-attention"
          tone={data.needsAttention > 0 ? 'danger' : 'ok'}
        />
        {view.financial && (
          <StatCard
            value={fmtMoney(data.pipelineValue)}
            label="Pipeline value"
            hint="Contract totals, active projects"
            href={projectsLink(f, { status: 'open' })}
          />
        )}
      </div>
    </section>
  );
}
