import Link from 'next/link';
import { notFound } from 'next/navigation';
import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { STAGES, STAGE_LABELS, stageIndex, type StageKey } from '@/lib/stages/definitions';

export const dynamic = 'force-dynamic';

/** Dealer-downloadable document categories (also enforced in read_document). */
const DEALER_DOC_CATEGORIES = ['signed_co', 'signature_docs', 'pto_letter', 'photo_completion'];

/** Never dealer-visible regardless of the admin visibility flags. */
const HARD_HIDDEN = /(notes|drive|manager|designer|vendor|cost|margin)/;

function fmt(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (value instanceof Date) return value.toLocaleDateString();
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(s).toLocaleDateString();
  if (s === 'true') return 'Yes';
  if (s === 'false') return 'No';
  return s.replaceAll('_', ' ');
}

/**
 * The dealer's project progress page: the seven-stage tracker with a
 * per-stage breakdown of the dealer-visible fields (admin-controlled flags,
 * internal fields stripped), milestone payments, commission, dealer-
 * appropriate documents, and the stage-move timeline. Entirely read-only.
 */
export default async function DealerProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await guardPath('/dealers');

  const data = await withUser(session, async (c) => {
    const { rows } = await c.query(
      `select p.*, sr.name as sales_rep_name, sr.email as sales_rep_email,
              st.name as system_type_name, mt.name as module_type_name,
              it.name as inverter_type_name, bt.name as battery_type_name,
              fp.name as finance_partner_name,
              coalesce((select max(e.changed_at) from public.project_stage_events e
                        where e.project_id = p.id), p.created_at) as stage_since
       from public.projects p
       left join public.sales_reps sr on sr.id = p.sales_rep_id
       left join public.system_types st on st.id = p.system_type_id
       left join public.module_types mt on mt.id = p.module_type_id
       left join public.inverter_types it on it.id = p.inverter_type_id
       left join public.battery_types bt on bt.id = p.battery_type_id
       left join public.finance_partners fp on fp.id = p.finance_partner_id
       where p.id = $1`,
      [id]
    );
    const project = rows[0];
    if (!project) return null;

    const one = async (table: string) =>
      (await c.query(`select * from public."${table}" where project_id = $1`, [id])).rows[0] ?? {};
    const s1 = await one('stage1_survey');
    const s2 = await one('stage2_design');
    const s3 = await one('stage3_permit');
    const s4 = await one('stage4_procurement');
    const s5 = await one('stage5_install');
    const s6 = await one('stage6_inspection');
    const s7 = await one('stage7_complete');
    const fin = await one('finance_milestones');

    const visible = await c.query(
      `select stage, name, label from public.dealer_visible_fields
       where is_active order by stage, label`
    );
    const hold = await c.query(
      `select reason, hold_start_date, expected_resume_date from public.project_holds
       where project_id = $1 and resume_date is null limit 1`,
      [id]
    );
    const cancel = await c.query(
      `select reason, cancellation_date from public.project_cancellation
       where project_id = $1 and reinstated_at is null limit 1`,
      [id]
    );
    const commission = await c.query(`select * from public.commissions where project_id = $1`, [id]);
    const docs = await c.query(
      `select id, title, category from public.documents
       where project_id = $1
         and (category = any($2) or category like 'permit_letter_%')
       order by created_at desc`,
      [id, DEALER_DOC_CATEGORIES]
    );
    const events = await c.query(
      `select changed_at, from_stage, to_stage from public.project_stage_events
       where project_id = $1 order by changed_at desc limit 30`,
      [id]
    );

    return {
      project,
      stageRows: { survey: s1, design: s2, permits: s3, procurement: s4,
                   install: s5, inspection_pto: s6, complete: s7 } as Record<StageKey, Record<string, unknown>>,
      finance: fin,
      visible: visible.rows,
      hold: hold.rows[0] ?? null,
      cancel: cancel.rows[0] ?? null,
      commission: commission.rows[0] ?? null,
      docs: docs.rows,
      events: events.rows,
    };
  });

  if (!data) notFound();
  const p = data.project;
  const stage = (STAGES as readonly string[]).includes(String(p.stage))
    ? (String(p.stage) as StageKey)
    : 'survey';
  const currentIndex = stageIndex(stage);
  const daysInStage = Math.max(
    0,
    Math.floor((Date.now() - new Date(p.stage_since).getTime()) / 86_400_000)
  );

  const visibleByStage = new Map<string, Array<{ name: string; label: string }>>();
  for (const row of data.visible) {
    if (HARD_HIDDEN.test(row.name)) continue;
    const list = visibleByStage.get(row.stage) ?? [];
    list.push({ name: row.name, label: row.label });
    visibleByStage.set(row.stage, list);
  }

  const partner = p.finance_partner_name ?? 'Finance';
  const milestones: Array<{ label: string; status: unknown; date: unknown }> = [
    { label: 'Down payment', status: data.stageRows.survey.down_payment_status,
      date: data.stageRows.survey.down_payment_received_date },
    { label: 'Cash M1', status: data.stageRows.survey.cash_m1_status,
      date: data.stageRows.survey.cash_m1_received_date },
    { label: 'Cash M2', status: data.stageRows.permits.cash_m2_status,
      date: data.stageRows.permits.cash_m2_received_date },
    { label: 'Cash M3', status: data.stageRows.install.cash_m3_status,
      date: data.stageRows.install.cash_m3_received_date },
    { label: `${partner} M1`, status: data.finance.m1_status, date: data.finance.m1_approved_date },
    { label: `${partner} M2`, status: data.finance.m2_status, date: data.finance.m2_approved_date },
  ];

  const cm = data.commission;
  const cmTotal = cm ? Number(cm.base_amount) + Number(cm.adjustment) : null;

  const systemBits = [
    p.system_size_kw ? `${p.system_size_kw} kW` : null,
    p.system_type_name,
    p.module_type_name && `${p.module_type_name}${p.module_quantity ? ` ×${p.module_quantity}` : ''}`,
    p.inverter_type_name && `${p.inverter_type_name}${p.inverter_quantity ? ` ×${p.inverter_quantity}` : ''}`,
    p.battery_type_name && `${p.battery_type_name}${p.battery_quantity ? ` ×${p.battery_quantity}` : ''}`,
  ].filter(Boolean);

  return (
    <main className="surface wide">
      <div className="board-header">
        <div>
          <h1>{p.name}</h1>
          <p className="dim">{p.address ?? '—'}</p>
        </div>
        <div className="board-actions">
          <Link className="btn-link" href="/dealers/projects">
            My projects
          </Link>
        </div>
      </div>

      <p>
        <span className={`stage-badge${p.status === 'on_hold' ? ' hold' : ''}${p.status === 'cancelled' ? ' cancelled' : ''}`}>
          {p.status === 'on_hold'
            ? `On hold — ${fmt(data.hold?.reason)}${data.hold?.expected_resume_date ? ` · expected resume ${fmt(data.hold.expected_resume_date)}` : ''}`
            : p.status === 'cancelled'
              ? `Cancelled ${fmt(data.cancel?.cancellation_date)} — ${fmt(data.cancel?.reason)}`
              : p.status === 'complete'
                ? `Complete${data.stageRows.complete.completion_date ? ` — ${fmt(data.stageRows.complete.completion_date)}` : ''}`
                : `${STAGE_LABELS[stage]} · ${daysInStage}d in stage`}
        </span>
      </p>

      <ol className="stepper">
        {STAGES.map((s, i) => (
          <li
            key={s}
            className={`step ${p.status === 'complete' || i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'locked'}`}
          >
            <span>
              <span className="step-num">{i + 1}</span>
              <span>{STAGE_LABELS[s]}</span>
            </span>
          </li>
        ))}
      </ol>

      <div className="detail-grid">
        <section className="panel">
          <h2>Project</h2>
          <dl className="facts">
            <dt>System</dt>
            <dd>{systemBits.length ? systemBits.join(' · ') : '—'}</dd>
            <dt>Sales rep</dt>
            <dd>
              {p.sales_rep_name ?? '—'}
              {p.sales_rep_email && <span className="dim"> · {p.sales_rep_email}</span>}
            </dd>
            <dt>Project total</dt>
            <dd>{p.contract_value ? `$${Number(p.contract_value).toLocaleString()}` : '—'}</dd>
          </dl>

          <h2>Stage progress</h2>
          {STAGES.map((s, i) => {
            const fields = visibleByStage.get(s) ?? [];
            const values = { ...data.stageRows[s], ...data.finance };
            return (
              <details key={s} open={i === currentIndex} className="stage-acc">
                <summary>
                  {i + 1} · {STAGE_LABELS[s]}
                  {i < currentIndex || p.status === 'complete' ? ' ✓' : ''}
                </summary>
                {fields.length === 0 ? (
                  <p className="dim">Nothing shared for this stage.</p>
                ) : (
                  <dl className="facts">
                    {fields.map((f) => (
                      <span key={f.name} style={{ display: 'contents' }}>
                        <dt>{f.label}</dt>
                        <dd>{fmt(values[f.name])}</dd>
                      </span>
                    ))}
                  </dl>
                )}
              </details>
            );
          })}
        </section>

        <section className="panel">
          <h2>Milestone payments</h2>
          <table className="projects-table">
            <thead>
              <tr>
                <th>Milestone</th>
                <th>Status</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {milestones.map((m) => (
                <tr key={m.label}>
                  <td>{m.label}</td>
                  <td>{fmt(m.status)}</td>
                  <td>{fmt(m.date)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>Commission</h2>
          {cm ? (
            <dl className="facts">
              <dt>Base</dt>
              <dd>${Number(cm.base_amount).toLocaleString()}</dd>
              <dt>Adjustment</dt>
              <dd>${Number(cm.adjustment).toLocaleString()}</dd>
              <dt>Total</dt>
              <dd>
                <strong>${cmTotal!.toLocaleString()}</strong>
              </dd>
              <dt>Status</dt>
              <dd>
                {fmt(cm.status)}
                {cm.status === 'payable' && cm.payable_date ? ` · ${fmt(cm.payable_date)}` : ''}
                {cm.status === 'paid' && cm.paid_date ? ` · ${fmt(cm.paid_date)}` : ''}
              </dd>
            </dl>
          ) : (
            <p className="dim">Not set yet.</p>
          )}

          <h2>Documents</h2>
          {data.docs.length === 0 ? (
            <p className="dim">Nothing shared yet.</p>
          ) : (
            <ul className="activity">
              {data.docs.map((d) => (
                <li key={d.id}>
                  <a href={`/api/files/${d.id}`}>{d.title ?? fmt(d.category)}</a>
                </li>
              ))}
            </ul>
          )}

          <h2>Timeline</h2>
          <ul className="activity">
            {data.events.map((e, i) => (
              <li key={i}>
                <span className="dim">{new Date(e.changed_at).toLocaleDateString()}</span>{' '}
                {e.from_stage ? `${STAGE_LABELS[e.from_stage as StageKey] ?? e.from_stage} → ` : ''}
                {STAGE_LABELS[e.to_stage as StageKey] ?? e.to_stage}
              </li>
            ))}
            {data.events.length === 0 && <li className="dim">No stage moves yet.</li>}
          </ul>
        </section>
      </div>
    </main>
  );
}
