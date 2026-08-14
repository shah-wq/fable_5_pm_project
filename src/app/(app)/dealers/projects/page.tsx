import Link from 'next/link';
import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { loadDealerProjects } from '@/lib/dealer/portal';
import { STAGES, STAGE_LABELS } from '@/lib/stages/definitions';
import { DealerProjectsTable } from './DealerProjectsTable';

export const dynamic = 'force-dynamic';

/** My projects — the dealer's searchable, filterable list with CSV export. */
export default async function DealerProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; stage?: string; status?: string }>;
}) {
  const session = await guardPath('/dealers');
  const sp = await searchParams;

  const rows = await withUser(session, (c) =>
    loadDealerProjects(c, session, { q: sp.q, stage: sp.stage, status: sp.status })
  );

  return (
    <main className="surface wide">
      <div className="board-header">
        <h1>My projects</h1>
        <div className="board-actions">
          <Link className="btn-link" href="/dealers">
            Dashboard
          </Link>
        </div>
      </div>

      <form className="filters" method="get">
        <input type="search" name="q" placeholder="Search customer or address…" defaultValue={sp.q ?? ''} />
        <select name="stage" defaultValue={sp.stage ?? ''}>
          <option value="">All stages</option>
          {STAGES.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABELS[s]}
            </option>
          ))}
        </select>
        <select name="status" defaultValue={sp.status ?? ''}>
          <option value="">All statuses</option>
          <option value="active">active</option>
          <option value="on_hold">on hold</option>
          <option value="complete">complete</option>
          <option value="cancelled">cancelled</option>
        </select>
        <button className="btn" type="submit">
          Filter
        </button>
      </form>

      <DealerProjectsTable rows={rows} />
    </main>
  );
}
