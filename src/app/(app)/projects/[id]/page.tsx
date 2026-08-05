import Link from 'next/link';
import { notFound } from 'next/navigation';
import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { STAGE_LABELS, isStageKey } from '@/lib/stages/definitions';
import { loadBundles } from '@/lib/stages/service';
import { evaluateStage } from '@/lib/stages/requirements';
import { ProjectActions } from './ProjectActions';
import { Stepper } from './Stepper';

export const dynamic = 'force-dynamic';

/**
 * Project detail: stage stepper across the top (completed green, current
 * highlighted, future locked), header facts, current-stage checklist, and the
 * recent activity trail.
 */
export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await guardPath('/projects');

  const data = await withUser(session, async (c) => {
    const { rows } = await c.query(
      `select p.*, cl.first_name || ' ' || cl.last_name as client_name,
              cl.email as client_email, cl.phone as client_phone,
              dl.name as dealer_name, j.name as jurisdiction_name,
              u.name as utility_name, fp.name as finance_partner_name,
              pm.full_name as pm_name
       from public.projects p
       left join public.clients cl on cl.id = p.client_id
       left join public.dealers dl on dl.id = p.dealer_id
       left join public.jurisdictions j on j.id = p.jurisdiction_id
       left join public.utilities u on u.id = p.utility_id
       left join public.finance_partners fp on fp.id = p.finance_partner_id
       left join public.profiles pm on pm.id = p.assigned_pm
       where p.id = $1`,
      [id]
    );
    if (!rows[0]) return null;
    const events = await c.query(
      `select occurred_at, action, actor_role, context
       from public.audit_log where project_id = $1
       order by occurred_at desc limit 12`,
      [id]
    );
    return { project: rows[0], events: events.rows };
  });

  if (!data) notFound();
  const p = data.project;
  const rawStage = String(p.stage);
  const stage = isStageKey(rawStage) ? rawStage : 'survey';

  const missing =
    p.status === 'complete'
      ? []
      : await withUser(session, async (c) => {
          const bundles = await loadBundles(c, [id]);
          const bundle = bundles.get(id);
          return bundle ? evaluateStage(stage, bundle) : [];
        });

  return (
    <main className="surface wide">
      <div className="board-header">
        <div>
          <h1>{p.name}</h1>
          <p className="dim">
            {p.address ?? '—'} · {p.code}
            {p.status !== 'active' && <strong> · {String(p.status).replace('_', ' ')}</strong>}
          </p>
        </div>
        <div className="board-actions">
          <Link className="btn-link" href="/pipeline">
            Board
          </Link>
          <Link className="btn-link" href="/projects">
            Projects
          </Link>
        </div>
      </div>

      {['admin', 'ops'].includes(session.role) && (
        <ProjectActions projectId={id} status={String(p.status)} isAdmin={session.role === 'admin'} />
      )}

      <Stepper projectId={id} current={stage} completed={p.status === 'complete'} />

      <div className="detail-grid">
        <section className="panel">
          <h2>Project</h2>
          <dl className="facts">
            <dt>Customer</dt>
            <dd>
              {p.client_name ?? '—'}
              {p.client_phone && <span className="dim"> · {p.client_phone}</span>}
            </dd>
            <dt>Dealer</dt>
            <dd>{p.dealer_name ?? '—'}</dd>
            <dt>Jurisdiction</dt>
            <dd>{p.jurisdiction_name ?? 'not set'}</dd>
            <dt>Utility</dt>
            <dd>{p.utility_name ?? 'not set'}</dd>
            <dt>Finance partner</dt>
            <dd>{p.finance_partner_name ?? 'cash / none'}</dd>
            <dt>System size</dt>
            <dd>{p.system_size_kw ? `${p.system_size_kw} kW` : '—'}</dd>
            <dt>Contract total</dt>
            <dd>{p.contract_value ? `$${Number(p.contract_value).toLocaleString()}` : '—'}</dd>
            <dt>PM</dt>
            <dd>{p.pm_name ?? '—'}</dd>
          </dl>
        </section>

        <section className="panel">
          <h2>
            {p.status === 'complete' ? 'Completed' : `Current stage: ${STAGE_LABELS[stage]}`}
          </h2>
          {p.status === 'complete' ? (
            <p className="dim">This project reached PTO and is archived with its document trail.</p>
          ) : missing.length === 0 ? (
            <p className="ok-line">✓ All required items complete — ready to advance.</p>
          ) : (
            <>
              <p className="dim">Missing before this stage can advance:</p>
              <ul className="gap-list">
                {missing.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </>
          )}
          {p.status !== 'complete' && (
            <Link className="btn-link primary" href={`/projects/${id}/stages/${stage}`}>
              Open stage form
            </Link>
          )}
        </section>

        <section className="panel">
          <h2>Activity</h2>
          <ul className="activity">
            {data.events.map((e, i) => (
              <li key={i}>
                <span className="dim">
                  {new Date(e.occurred_at).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>{' '}
                {e.action}
                {e.actor_role ? <span className="dim"> · {e.actor_role}</span> : null}
              </li>
            ))}
            {data.events.length === 0 && <li className="dim">Nothing yet.</li>}
          </ul>
        </section>
      </div>
    </main>
  );
}
