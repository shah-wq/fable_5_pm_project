import Link from 'next/link';
import { notFound } from 'next/navigation';
import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { loadDetailRefs } from '@/lib/projects/details';
import { STAGE_LABELS, isStageKey } from '@/lib/stages/definitions';
import { loadBundles } from '@/lib/stages/service';
import { evaluateStage } from '@/lib/stages/requirements';
import { CommissionPanel, type CommissionValue } from './CommissionPanel';
import { CustomerPanel } from './CustomerPanel';
import { DetailsPanel } from './DetailsPanel';
import { ProjectActions } from './ProjectActions';
import { Stepper } from './Stepper';

export const dynamic = 'force-dynamic';

/**
 * Project detail: stage stepper across the top (completed green, current
 * highlighted, future locked), the Details tab (the New Project form's four
 * blocks, editable from any stage), the current-stage checklist, and the
 * recent activity trail.
 */
export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await guardPath('/projects');

  const data = await withUser(session, async (c) => {
    const { rows } = await c.query(
      `select p.*, cl.first_name as client_first, cl.last_name as client_last,
              cl.first_name || ' ' || cl.last_name as client_name,
              cl.email as client_email, cl.phone as client_phone,
              dl.name as dealer_name, j.name as jurisdiction_name,
              u.name as utility_name, fp.name as finance_partner_name,
              pm.full_name as pm_name,
              sr.name as sales_rep_name, st.name as system_type_name,
              mt.name as module_type_name, it.name as inverter_type_name,
              bt.name as battery_type_name, cf.name as cash_or_financing_name,
              fc.name as financing_company_name
       from public.projects p
       left join public.clients cl on cl.id = p.client_id
       left join public.dealers dl on dl.id = p.dealer_id
       left join public.jurisdictions j on j.id = p.jurisdiction_id
       left join public.utilities u on u.id = p.utility_id
       left join public.finance_partners fp on fp.id = p.finance_partner_id
       left join public.profiles pm on pm.id = p.assigned_pm
       left join public.sales_reps sr on sr.id = p.sales_rep_id
       left join public.system_types st on st.id = p.system_type_id
       left join public.module_types mt on mt.id = p.module_type_id
       left join public.inverter_types it on it.id = p.inverter_type_id
       left join public.battery_types bt on bt.id = p.battery_type_id
       left join public.cash_financing_options cf on cf.id = p.cash_or_financing_id
       left join public.financing_companies fc on fc.id = p.financing_company_id
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
    const refs = await loadDetailRefs(c);
    const commission = await c.query(`select * from public.commissions where project_id = $1`, [id]);
    // What the PM has asked this customer for and not yet received.
    const asks = await c.query(
      `select id, kind, label, detail, created_at from public.customer_asks
       where project_id = $1 and fulfilled_at is null and cancelled_at is null
       order by created_at desc`,
      [id]
    );
    const requests = await c.query(
      `select id, kind, message, preferred_dates, time_window, contact_phone, contact_email,
              document_id, status, pm_reply, created_at
       from public.customer_requests where project_id = $1 order by created_at desc limit 30`,
      [id]
    );
    const documents = await c.query(
      `select id, title, category, customer_visible, created_at from public.documents
       where project_id = $1 order by created_at desc limit 100`,
      [id]
    );
    const portalUser = await c.query<{ n: number }>(
      `select count(*)::int as n from public.clients cl
       where cl.id = (select client_id from public.projects where id = $1)
         and cl.user_id is not null`,
      [id]
    );
    return {
      project: rows[0],
      events: events.rows,
      refs,
      commission: commission.rows[0] ?? null,
      requests: requests.rows,
      asks: asks.rows,
      documents: documents.rows,
      hasPortalAccess: (portalUser.rows[0]?.n ?? 0) > 0,
    };
  });

  if (!data) notFound();
  const p = data.project;
  const rawStage = String(p.stage);
  // Projects completed before the stage column carried 'complete' still land
  // on the Complete step here.
  const stage =
    p.status === 'complete' ? 'complete' : isStageKey(rawStage) ? rawStage : 'survey';

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

      <DetailsPanel
        projectId={id}
        initialValues={{
          first_name: p.client_first,
          last_name: p.client_last,
          email: p.client_email,
          phone: p.client_phone,
          address: p.address,
          dealer_id: p.dealer_id,
          sales_rep_id: p.sales_rep_id,
          contract_value: p.contract_value === null ? null : Number(p.contract_value),
          assigned_pm: p.assigned_pm,
          system_type_id: p.system_type_id,
          module_type_id: p.module_type_id,
          module_quantity: p.module_quantity,
          inverter_type_id: p.inverter_type_id,
          inverter_quantity: p.inverter_quantity,
          battery_type_id: p.battery_type_id,
          battery_quantity: p.battery_quantity,
          system_size_kw: p.system_size_kw === null ? null : Number(p.system_size_kw),
          cash_or_financing_id: p.cash_or_financing_id,
          financing_company_id: p.financing_company_id,
          finance_partner_id: p.finance_partner_id,
          financing_notes: p.financing_notes,
        }}
        refs={data.refs}
        fallbackLabels={{
          dealer_id: p.dealer_name,
          sales_rep_id: p.sales_rep_name,
          assigned_pm: p.pm_name,
          system_type_id: p.system_type_name,
          module_type_id: p.module_type_name,
          inverter_type_id: p.inverter_type_name,
          battery_type_id: p.battery_type_name,
          cash_or_financing_id: p.cash_or_financing_name,
          financing_company_id: p.financing_company_name,
          finance_partner_id: p.finance_partner_name,
        }}
        status={String(p.status)}
        isAdmin={session.role === 'admin'}
        canEdit={['admin', 'ops'].includes(session.role)}
      />

      <div className="detail-grid">
        {['admin', 'ops'].includes(session.role) && (
          <CustomerPanel
            projectId={id}
            estimate={p.customer_estimate ?? null}
            hasPortalAccess={data.hasPortalAccess}
            customerEmail={p.client_email ?? null}
            requests={data.requests.map((r) => ({
              id: r.id,
              kind: String(r.kind),
              message: r.message,
              preferredDates: r.preferred_dates,
              timeWindow: r.time_window,
              contactPhone: r.contact_phone,
              contactEmail: r.contact_email,
              documentId: r.document_id,
              status: String(r.status),
              reply: r.pm_reply,
              created: new Date(String(r.created_at)).toLocaleDateString(),
            }))}
            asks={data.asks.map((a) => ({
              id: a.id,
              kind: String(a.kind),
              label: String(a.label),
              detail: a.detail,
              created: new Date(String(a.created_at)).toLocaleDateString(),
            }))}
            documents={data.documents.map((d) => ({
              id: d.id,
              title: d.title ?? String(d.category ?? 'file'),
              category: String(d.category ?? ''),
              customerVisible: d.customer_visible === true,
              created: new Date(String(d.created_at)).toLocaleDateString(),
            }))}
          />
        )}
        {['admin', 'ops'].includes(session.role) && (
          <CommissionPanel
            projectId={id}
            isAdmin={session.role === 'admin'}
            initial={
              data.commission
                ? ({
                    baseAmount: Number(data.commission.base_amount),
                    adjustment: Number(data.commission.adjustment),
                    status: String(data.commission.status),
                    payableDate: data.commission.payable_date
                      ? String(data.commission.payable_date)
                      : null,
                    paidDate: data.commission.paid_date ? String(data.commission.paid_date) : null,
                    notes: data.commission.notes,
                  } satisfies CommissionValue)
                : null
            }
          />
        )}
        <section className="panel">
          <h2>
            {p.status === 'complete' ? 'Completed' : `Current stage: ${STAGE_LABELS[stage]}`}
          </h2>
          {p.status === 'complete' ? (
            <p className="dim">
              This project reached PTO and is complete. The completion record and document
              trail stay editable below.
            </p>
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
          <Link className="btn-link primary" href={`/projects/${id}/stages/${stage}`}>
            Open stage form
          </Link>
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
