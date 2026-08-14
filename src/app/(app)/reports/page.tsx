import Link from 'next/link';
import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { REPORT_TEMPLATES } from '@/lib/reports/templates';
import { ReportLibrary, type SavedReport } from './ReportLibrary';

export const dynamic = 'force-dynamic';

/**
 * The report library: the shipped templates (open configured, the fastest
 * route to value), then My reports and Shared with me. Nothing here is a
 * frozen result — every entry re-runs against live data.
 */
export default async function ReportsPage() {
  const session = await guardPath('/reports');

  const data = await withUser(session, async (c) => {
    const saved = await c.query(
      `select r.id, r.name, r.description, r.visibility, r.owner_id, r.last_run_at,
              r.updated_at, coalesce(pr.full_name, pr.email) as owner_name
       from public.report_definitions r
       left join public.profiles pr on pr.id = r.owner_id
       where not r.is_template
       order by r.updated_at desc
       limit 200`
    );
    const runs = await c.query(
      `select report_name, format, row_count, ran_at,
              coalesce(pr.full_name, pr.email) as ran_by_name
       from public.report_runs rr
       left join public.profiles pr on pr.id = rr.ran_by
       where rr.format <> 'preview'
       order by rr.ran_at desc limit 15`
    );
    return { saved: saved.rows, runs: runs.rows };
  });

  const reports: SavedReport[] = data.saved.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    visibility: r.visibility,
    ownerName: r.owner_name,
    isMine: r.owner_id === session.userId,
    updatedAt: String(r.updated_at),
  }));

  return (
    <main className="surface wide">
      <div className="board-header">
        <div>
          <h1>Reports</h1>
          <p className="dim">
            Drag fields onto a canvas, filter and group them, then export to Excel or CSV. Every
            field the team enters anywhere in SolarFlow is available, plus computed fields the
            system derives.
          </p>
        </div>
        <div className="board-actions">
          <Link className="btn-link primary" href="/reports/builder">
            + New report
          </Link>
        </div>
      </div>

      <section className="panel">
        <h2>Start from a template</h2>
        <div className="template-grid">
          {REPORT_TEMPLATES.map((t) => (
            <Link key={t.key} className="template-card" href={`/reports/builder?template=${t.key}`}>
              <span className="template-kind">{t.kind}</span>
              <strong>{t.name}</strong>
              <span className="dim">{t.description}</span>
            </Link>
          ))}
        </div>
      </section>

      <ReportLibrary reports={reports} />

      <section className="panel">
        <h2>Recent exports</h2>
        <ul className="activity">
          {data.runs.map((r, i) => (
            <li key={i}>
              <span className="dim">
                {new Date(String(r.ran_at)).toLocaleString(undefined, {
                  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                })}
              </span>{' '}
              {r.report_name} · {r.format} · {Number(r.row_count).toLocaleString()} rows
              {r.ran_by_name ? <span className="dim"> · {r.ran_by_name}</span> : null}
            </li>
          ))}
          {data.runs.length === 0 && <li className="dim">Nothing exported yet.</li>}
        </ul>
      </section>
    </main>
  );
}
