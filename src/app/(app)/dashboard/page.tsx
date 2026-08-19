import Link from 'next/link';
import { Suspense } from 'react';
import { guardPath } from '@/lib/auth/session';
import { parseFilters } from '@/lib/dashboard/filters';
import { dashboardContext } from '@/lib/dashboard/queries';
import { viewFor } from '@/lib/dashboard/view';
import { AttentionBand } from './_components/AttentionBand';
import { CycleBand } from './_components/CycleBand';
import { FilterBar } from './_components/FilterBar';
import { FinanceBand } from './_components/FinanceBand';
import { HeadlineBand } from './_components/HeadlineBand';
import { WhereBand } from './_components/WhereBand';
import { WhoBand } from './_components/WhoBand';

export const dynamic = 'force-dynamic';

/**
 * The analytics dashboard: one scrolling page, four bands, densest information
 * at the top (spec §2).
 *
 * Two structural decisions worth naming.
 *
 * Progressive loading (§9): "Stat cards render first and fast; heavier charts
 * fill in behind them. A blank screen while ten queries run feels broken." Each
 * band is its own async component inside its own <Suspense>, so the headline
 * numbers stream to the browser while the heat map is still being aggregated. The
 * bands do not wait on each other, and one slow query cannot hold the page.
 *
 * Nothing is configured (§1). There is no list of PMs, dealers or stages in this
 * file — every chart is a live `group by` over whatever the database holds, so a
 * new project, PM or dealer appears on the next render with no dashboard edit.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await guardPath('/dashboard');
  const filters = parseFilters(await searchParams);
  const { ready, ctx, refs } = await dashboardContext(session, filters);
  const view = viewFor(session.role, refs.opsSeeFinancials);

  // The deployment and the database move separately here — code ships the moment
  // it is pushed, the SQL is pasted into a console by a person some time later.
  // In that window this page says what to do rather than throwing.
  if (!ready) {
    return (
      <main className="table-page">
        <h1>Dashboard</h1>
        <section className="panel">
          <h2>The database has not caught up yet</h2>
          <p>
            The dashboard reads a view called <code>public.project_metrics</code>, which arrives with
            the dashboard module’s migration. It is not in this database yet, so there is nothing to
            chart.
          </p>
          <p>
            Run <code>db/dist/20260803002800-dashboard.sql</code> in the SQL editor — the whole file,
            once. It is safe to run twice. Then reload this page.
          </p>
          <p className="dim">
            Everything else in the app keeps working in the meantime; this is the only surface that
            needs the new view. <Link href="/api/health">/api/health</Link> lists every migration this
            deployment expects.
          </p>
        </section>
      </main>
    );
  }

  const names = {
    pm: refs.pms.find((p) => p.id === filters.pm)?.name ?? null,
    dealer: refs.dealers.find((d) => d.id === filters.dealer)?.name ?? null,
  };
  // profiles is admin/ops-only by policy, so a role that cannot read it gets no
  // by-PM charts — the absence is the policy, not a rendering choice.
  const showPm = refs.pms.length > 0;

  return (
    <main className="dashboard">
      <div className="board-header">
        <h1>Dashboard</h1>
        <div className="board-actions">
          <Link className="btn-link" href="/pipeline">
            Pipeline board
          </Link>
          <Link className="btn-link" href="/reports">
            Reports
          </Link>
        </div>
      </div>

      <FilterBar filters={filters} period={ctx.period} refs={refs} view={view} />

      {view.kind === 'financial' ? (
        <Suspense fallback={<BandSkeleton label="Loading the finance view…" />}>
          <FinanceBand session={session} ctx={ctx} />
        </Suspense>
      ) : (
        <>
          <Suspense fallback={<BandSkeleton label="Counting projects…" cards />}>
            <HeadlineBand
              session={session}
              ctx={ctx}
              view={view}
              onHoldThreshold={refs.onHoldThreshold}
              names={names}
            />
          </Suspense>

          <h2 className="section-title">Where every project is</h2>
          <Suspense fallback={<BandSkeleton label="Building the funnel…" />}>
            <WhereBand session={session} ctx={ctx} names={names} showPm={showPm} />
          </Suspense>

          <h2 className="section-title">How long projects take</h2>
          <Suspense fallback={<BandSkeleton label="Measuring cycle times…" />}>
            <CycleBand session={session} ctx={ctx} names={names} />
          </Suspense>

          <h2 className="section-title">Dealers, PMs and projects</h2>
          <Suspense fallback={<BandSkeleton label="Comparing dealers and PMs…" />}>
            <WhoBand session={session} ctx={ctx} view={view} names={names} showPm={showPm} />
          </Suspense>

          <Suspense fallback={<BandSkeleton label="Finding what needs attention…" />}>
            <AttentionBand session={session} ctx={ctx} />
          </Suspense>
        </>
      )}
    </main>
  );
}

/**
 * What sits in a band's place while its queries run. Deliberately says which
 * band it is: a page of identical grey rectangles tells the reader nothing about
 * whether it is nearly done.
 */
function BandSkeleton({ label, cards }: { label: string; cards?: boolean }) {
  return (
    <div className={cards ? 'stat-cards' : 'chart-grid'} aria-live="polite">
      <div className="panel skeleton">
        <p className="dim">{label}</p>
      </div>
    </div>
  );
}
