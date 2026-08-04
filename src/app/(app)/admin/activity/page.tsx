import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { AdminTabs } from '../_components/AdminTabs';

export const dynamic = 'force-dynamic';

/**
 * Admin panel §6 — the global activity log viewer: read-only, searchable by
 * action, actor, project and date.
 */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; action?: string; from?: string; to?: string }>;
}) {
  const session = await guardPath('/admin');
  const sp = await searchParams;

  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, v: unknown) => {
    params.push(v);
    where.push(clause.replace('?', `$${params.length}`));
  };
  if (sp.action) add('a.action ilike ?', `%${sp.action}%`);
  if (sp.from) add('a.occurred_at >= ?::date', sp.from);
  if (sp.to) add('a.occurred_at < (?::date + 1)', sp.to);
  if (sp.q) {
    add(
      `(p.name ilike ? or pr.full_name ilike '%' || $${params.length + 1} || '%' or a.entity_type ilike '%' || $${params.length + 1} || '%')`,
      `%${sp.q}%`
    );
  }

  const { rows } = await withUser(session, (c) =>
    c.query(
      `select a.occurred_at, a.action, a.entity_type, a.actor_role, a.context,
              pr.full_name as actor_name, p.name as project_name
       from public.audit_log a
       left join public.profiles pr on pr.id = a.actor_id
       left join public.projects p on p.id = a.project_id
       ${where.length ? 'where ' + where.join(' and ') : ''}
       order by a.occurred_at desc
       limit 200`,
      params
    )
  );

  return (
    <main className="table-page">
      <h1>Admin</h1>
      <AdminTabs />
      <h2 className="section-title">Activity log</h2>
      <form className="filters" method="get">
        <input type="search" name="q" placeholder="Project, user, entity…" defaultValue={sp.q ?? ''} />
        <input type="text" name="action" placeholder="Action (e.g. stage.)" defaultValue={sp.action ?? ''} />
        <input type="date" name="from" defaultValue={sp.from ?? ''} />
        <input type="date" name="to" defaultValue={sp.to ?? ''} />
        <button className="btn" type="submit">
          Filter
        </button>
      </form>
      <div className="table-wrap">
        <table className="projects-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Actor</th>
              <th>Project</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  {new Date(r.occurred_at).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </td>
                <td>{r.action}</td>
                <td>{r.entity_type}</td>
                <td>
                  {r.actor_name ?? '—'}
                  {r.actor_role ? <span className="dim"> ({r.actor_role})</span> : null}
                </td>
                <td>{r.project_name ?? '—'}</td>
                <td className="dim ctx">
                  {r.context && Object.keys(r.context).length > 0
                    ? JSON.stringify(r.context)
                    : '—'}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="dim">
                  Nothing matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
