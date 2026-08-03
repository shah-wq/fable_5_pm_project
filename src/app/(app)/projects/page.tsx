import Link from 'next/link';
import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { STAGES, STAGE_LABELS, type StageKey } from '@/lib/stages/definitions';
import { loadProjectCards, type ProjectCard } from '@/lib/stages/service';

export const dynamic = 'force-dynamic';

const STATUSES = ['active', 'on_hold', 'complete', 'cancelled'] as const;

type Search = {
  q?: string;
  stage?: string;
  status?: string;
  jurisdiction?: string;
  dealer?: string;
  sort?: string;
  dir?: string;
};

function sortCards(cards: ProjectCard[], sort: string, dir: string): ProjectCard[] {
  const mul = dir === 'asc' ? 1 : -1;
  const by: Record<string, (a: ProjectCard, b: ProjectCard) => number> = {
    name: (a, b) => a.name.localeCompare(b.name),
    stage: (a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage),
    days: (a, b) => a.daysInStage - b.daysInStage,
    missing: (a, b) => a.missing.length - b.missing.length,
    size: (a, b) => (a.systemSizeKw ?? 0) - (b.systemSizeKw ?? 0),
    created: (a, b) => a.createdAt.localeCompare(b.createdAt),
  };
  return [...cards].sort((a, b) => mul * (by[sort] ?? by.created)(a, b));
}

/** The Projects tab: every project in a searchable, sortable, filterable table. */
export default async function ProjectsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await guardPath('/projects');
  const sp = await searchParams;

  const [cards, refs] = await Promise.all([
    loadProjectCards(session, {
      q: sp.q,
      stage: sp.stage && (STAGES as readonly string[]).includes(sp.stage) ? sp.stage : undefined,
      status: sp.status && (STATUSES as readonly string[]).includes(sp.status) ? sp.status : undefined,
      jurisdictionId: sp.jurisdiction,
      dealerId: sp.dealer,
      includeCompleted: true,
    }),
    withUser(session, async (c) => ({
      jurisdictions: (await c.query('select id, name from public.jurisdictions order by name')).rows,
      dealers: (await c.query('select id, name from public.dealers order by name')).rows,
    })),
  ]);

  const sort = sp.sort ?? 'created';
  const dir = sp.dir === 'asc' ? 'asc' : 'desc';
  const rows = sortCards(cards, sort, dir);

  const sortLink = (key: string) => {
    const params = new URLSearchParams(
      Object.entries(sp).filter(([, v]) => v) as [string, string][]
    );
    params.set('sort', key);
    params.set('dir', sort === key && dir === 'desc' ? 'asc' : 'desc');
    return `/projects?${params.toString()}`;
  };

  return (
    <main className="table-page">
      <div className="board-header">
        <h1>Projects</h1>
        <div className="board-actions">
          <Link className="btn-link" href="/pipeline">
            Pipeline board
          </Link>
          <Link className="btn-link primary" href="/projects/new">
            + New project
          </Link>
        </div>
      </div>

      <form className="filters" method="get">
        <input type="search" name="q" placeholder="Search customer, address, code…" defaultValue={sp.q ?? ''} />
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
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </select>
        <select name="jurisdiction" defaultValue={sp.jurisdiction ?? ''}>
          <option value="">All jurisdictions</option>
          {refs.jurisdictions.map((j) => (
            <option key={j.id} value={j.id}>
              {j.name}
            </option>
          ))}
        </select>
        <select name="dealer" defaultValue={sp.dealer ?? ''}>
          <option value="">All dealers</option>
          {refs.dealers.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <button className="btn" type="submit">
          Filter
        </button>
      </form>

      <div className="table-wrap">
        <table className="projects-table">
          <thead>
            <tr>
              <th><Link href={sortLink('name')}>Customer</Link></th>
              <th>Address</th>
              <th><Link href={sortLink('size')}>kW</Link></th>
              <th><Link href={sortLink('stage')}>Stage</Link></th>
              <th><Link href={sortLink('days')}>Days in stage</Link></th>
              <th><Link href={sortLink('missing')}>Missing</Link></th>
              <th>Jurisdiction</th>
              <th>Dealer</th>
              <th>PM</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link href={`/projects/${p.id}`}>{p.name}</Link>
                  <div className="dim">{p.code}</div>
                </td>
                <td>{p.address ?? '—'}</td>
                <td>{p.systemSizeKw ?? '—'}</td>
                <td>{STAGE_LABELS[p.stage as StageKey] ?? p.stage}</td>
                <td>{p.daysInStage}</td>
                <td>
                  {p.status === 'complete' ? (
                    '—'
                  ) : p.missing.length > 0 ? (
                    <span className="missing-badge" title={p.missing.join('\n')}>
                      {p.missing.length}
                    </span>
                  ) : (
                    <span className="ok-dot" title="Ready to advance">✓</span>
                  )}
                </td>
                <td>{p.jurisdictionName ?? '—'}</td>
                <td>{p.dealerName ?? '—'}</td>
                <td>{p.pmName ?? '—'}</td>
                <td>{p.status.replace('_', ' ')}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="dim">
                  No projects match. <Link href="/projects/new">Create the first one</Link>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
