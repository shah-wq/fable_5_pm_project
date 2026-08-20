import Link from 'next/link';
import { STAGES, STAGE_LABELS } from '@/lib/stages/definitions';
import {
  PERIODS,
  PERIOD_LABELS,
  STATUSES,
  filterQuery,
  type DashboardFilters,
  type ResolvedPeriod,
} from '@/lib/dashboard/filters';
import type { DashboardView } from '@/lib/dashboard/view';
import { PrintButton } from './PrintButton';

/**
 * The sticky filter bar of spec §2: one set of choices applying to every chart
 * below at once, with the active set always visible.
 *
 * It is a plain GET form — the filters live in the URL, which means a filtered
 * dashboard can be bookmarked, sent to a colleague, and opened by the person who
 * has to act on it. That matters more here than an in-page interaction would:
 * the whole point of §7's attention lists is that somebody else opens them.
 *
 * The three toggles are links rather than form controls, so each takes effect on
 * its own click without the reader having to find Apply.
 */
export function FilterBar({
  filters,
  period,
  refs,
  view,
}: {
  filters: DashboardFilters;
  period: ResolvedPeriod;
  refs: { pms: Array<{ id: string; name: string }>; dealers: Array<{ id: string; name: string }> };
  view: DashboardView;
}) {
  const toggle = (key: string, on: boolean, value = '1') =>
    `/dashboard?${filterQuery(filters, { [key]: on ? null : value })}`;

  return (
    <div className="filter-bar">
      <form className="filters" method="get">
        <select name="period" defaultValue={filters.period} aria-label="Date range">
          {PERIODS.map((p) => (
            <option key={p} value={p}>
              {PERIOD_LABELS[p]}
            </option>
          ))}
        </select>
        {/* Always present, so choosing 'Custom range' and pressing Apply works
            in one pass rather than needing a round trip to reveal them. */}
        <input
          type="date"
          name="from"
          defaultValue={filters.customFrom ?? ''}
          aria-label="Custom range start"
        />
        <input
          type="date"
          name="to"
          defaultValue={filters.customTo ?? ''}
          aria-label="Custom range end"
        />

        {refs.pms.length > 0 && (
          <select name="pm" defaultValue={filters.pm ?? ''} aria-label="Project manager">
            <option value="">All PMs</option>
            {refs.pms.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <select name="dealer" defaultValue={filters.dealer ?? ''} aria-label="Dealer">
          <option value="">All dealers</option>
          {refs.dealers.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        {view.kind === 'operational' && (
          <>
            <select name="stage" defaultValue={filters.stage ?? ''} aria-label="Stage">
              <option value="">All stages</option>
              {STAGES.map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABELS[s]}
                </option>
              ))}
            </select>
            <select name="status" defaultValue={filters.status ?? ''} aria-label="Project status">
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace('_', ' ')}
                </option>
              ))}
            </select>
          </>
        )}
        {/* The toggles are outside the form's controls, so carry them across an
            Apply rather than silently resetting them. */}
        {filters.mine && <input type="hidden" name="mine" value="1" />}
        {filters.stat === 'average' && <input type="hidden" name="stat" value="average" />}
        {filters.exHold && <input type="hidden" name="exhold" value="1" />}
        <button className="btn" type="submit">
          Apply
        </button>
      </form>

      <div className="filter-toggles">
        {/* One text node: this line is the only attribution on a printed page,
            and React would otherwise split it around a comment node. */}
        <span className="active-period">{`Showing: ${period.label}`}</span>
        {view.mineToggle && (
          <Link className={`toggle-chip${filters.mine ? ' on' : ''}`} href={toggle('mine', filters.mine)}>
            My projects
          </Link>
        )}
        {view.kind === 'operational' && (
          <Link
            className={`toggle-chip${filters.exHold ? ' on' : ''}`}
            href={toggle('exhold', filters.exHold)}
          >
            Excluding hold time
          </Link>
        )}
        <span className="toggle-pair" role="group" aria-label="Average or median">
          <Link
            className={`toggle-chip${filters.stat === 'median' ? ' on' : ''}`}
            href={`/dashboard?${filterQuery(filters, { stat: null })}`}
          >
            Median
          </Link>
          <Link
            className={`toggle-chip${filters.stat === 'average' ? ' on' : ''}`}
            href={`/dashboard?${filterQuery(filters, { stat: 'average' })}`}
          >
            Average
          </Link>
        </span>
        {(filters.pm || filters.dealer || filters.stage || filters.status || filters.mine) && (
          <Link className="toggle-chip clear" href="/dashboard">
            Clear filters
          </Link>
        )}
        <PrintButton />
      </div>
    </div>
  );
}
