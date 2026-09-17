'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  DEAL_STAGE_LABELS,
  DEAL_STAGE_MEANS,
  type DealColumn,
} from '@/lib/deals/definitions';
import type { DealCard } from '@/lib/deals/service';
import { DealSolarDetails } from './DealSolarDetails';

export interface RefLists {
  roofTypes: Array<{ id: string; name: string }>;
  utilities: Array<{ id: string; name: string }>;
  modules: Array<{ id: string; name: string }>;
  inverters: Array<{ id: string; name: string }>;
  batteries: Array<{ id: string; name: string }>;
  financingCompanies: Array<{ id: string; name: string }>;
  competitors: Array<{ id: string; name: string }>;
  lossReasons: Array<{ id: string; name: string }>;
  owners: Array<{ id: string; name: string }>;
  dealers: Array<{ id: string; name: string }>;
}

export interface DealFields {
  homeowner_confirmed: boolean;
  roof_type_id: string | null;
  roof_age: number | null;
  avg_monthly_bill: number | null;
  utility_id: string | null;
  credit_band: string | null;
  decision_maker_identified: boolean;
  system_size_kw: number | null;
  module_id: string | null;
  inverter_id: string | null;
  battery_id: string | null;
  net_price: number | null;
  financing_route: string | null;
  financing_company_id: string | null;
  expected_close_date: string | null;
  contract_value: number | null;
  competitor_id: string | null;
  owner_id: string | null;
  dealer_id: string | null;
  next_action: string | null;
  next_action_at: string | null;
}

/**
 * The deal record: the fields each stage gate reads, the activity log that gets
 * a deal out of New, and the stage actions.
 *
 * Laid out in stage order on purpose — a rep working a deal reads down the page
 * in the order the pipeline asks for things, and the missing-items list at the
 * top names whatever is still in the way.
 */
export function DealRecord({
  deal,
  fields,
  refs,
  proposals,
  timeline,
  isAdmin,
}: {
  deal: DealCard;
  fields: DealFields;
  refs: RefLists;
  proposals: Array<{
    id: string; version: number; netPrice: number | null;
    sentAt: string | null; viewedAt: string | null; createdAt: string;
  }>;
  timeline: Array<{ at: string; kind: string; action: string; actor: string | null }>;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = useState<DealFields>(fields);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [lostReason, setLostReason] = useState('');
  const [showLost, setShowLost] = useState(false);
  const [log, setLog] = useState({ kind: 'call', note: '', reached: true });

  const terminal = deal.column === 'won' || deal.column === 'lost';

  function set<K extends keyof DealFields>(key: K, value: DealFields[K]) {
    setValues((v) => ({ ...v, [key]: value }));
    setDirty(true);
    setNotice(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/deals', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: deal.id, ...values }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? `Save failed (${res.status}).`);
        return;
      }
      setDirty(false);
      setNotice('Saved.');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function move(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setMissing([]);
    try {
      const res = await fetch(`/api/deals/${deal.id}/move`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? `That move was refused (${res.status}).`);
        setMissing(json?.missing ?? []);
        return;
      }
      if (json?.projectId) {
        router.push(`/projects/${json.projectId}`);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function logActivity() {
    if (!log.note.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/deals/${deal.id}/activity`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(log),
      });
      if (res.ok) {
        setLog({ kind: 'call', note: '', reached: true });
        router.refresh();
      } else {
        const json = await res.json().catch(() => null);
        setError(json?.error ?? 'Could not log that.');
      }
    } finally {
      setBusy(false);
    }
  }

  const refSelect = (
    label: string,
    key: keyof DealFields,
    options: Array<{ id: string; name: string }>
  ) => (
    <label className="field" key={String(key)}>
      <span>{label}</span>
      <select
        value={(values[key] as string) ?? ''}
        onChange={(e) => set(key, (e.target.value || null) as DealFields[typeof key])}
        disabled={terminal}
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="stage-form">
      {error && (
        <p className="notice error" role="alert">
          {error}
          {missing.length > 0 && (
            <ul className="gap-list">
              {missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
        </p>
      )}
      {notice && <p className="notice ok">{notice}</p>}

      {deal.projectId && (
        <p className="notice ok">
          This deal was won and became a project.{' '}
          <Link href={`/projects/${deal.projectId}`}>Open it</Link>. The deal is read-only now;
          a project that falls over afterwards is cancelled as a project, with its own reason.
        </p>
      )}

      <details className="track-card" open>
        <summary>
          <span className="track-title">Where it is</span>
          <span className={`chip status-${deal.column}`}>{DEAL_STAGE_LABELS[deal.column]}</span>
          {!terminal && <span className="chip days">{`${deal.daysInStage}d in stage`}</span>}
        </summary>
        <div className="track-body">
          <p className="dim">{DEAL_STAGE_MEANS[deal.column]}</p>
          {deal.missing.length > 0 && !terminal && (
            <>
              <p className="dim">Before it can leave this stage:</p>
              <ul className="gap-list">
                {deal.missing.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </>
          )}
          <div className="board-actions">
            {!terminal && (
              <>
                <button className="btn" type="button" disabled={busy}
                  onClick={() => move({ move: 'forward' })}>
                  Advance
                </button>
                <button className="btn" type="button" disabled={busy}
                  onClick={() => move({ move: 'won' })}>
                  Mark won
                </button>
                <button className="btn secondary" type="button" disabled={busy}
                  onClick={() => setShowLost(true)}>
                  Mark lost
                </button>
              </>
            )}
            {deal.column === 'lost' && (
              <button className="btn secondary" type="button" disabled={busy}
                onClick={() => move({ move: 'reopen' })}>
                Reopen
              </button>
            )}
          </div>
          {showLost && (
            <div className="dialog-backdrop">
              <div className="dialog" role="dialog" aria-modal>
                <h2>Mark lost?</h2>
                <label className="field">
                  <span>Reason *</span>
                  <select value={lostReason} onChange={(e) => setLostReason(e.target.value)}>
                    <option value="">Pick a reason…</option>
                    {refs.lossReasons.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="dialog-actions">
                  <button className="btn secondary" type="button" onClick={() => setShowLost(false)}>
                    Cancel
                  </button>
                  <button className="btn" type="button" disabled={busy || !lostReason}
                    onClick={async () => {
                      setShowLost(false);
                      await move({ move: 'lost', lostReasonId: lostReason });
                    }}>
                    Mark lost
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </details>

      <details className="track-card" open>
        <summary>
          <span className="track-title">Next action</span>
          {!deal.nextAction && <span className="chip status-none">none</span>}
        </summary>
        <div className="track-body">
          {/* Part 5: "Required on every open deal." */}
          <label className="field">
            <span>What happens next</span>
            <input value={values.next_action ?? ''} disabled={terminal}
              onChange={(e) => set('next_action', e.target.value || null)} />
          </label>
          <label className="field">
            <span>When</span>
            <input type="date" value={values.next_action_at ?? ''} disabled={terminal}
              onChange={(e) => set('next_action_at', e.target.value || null)} />
          </label>
          {refSelect('Owner', 'owner_id', refs.owners)}
          {refSelect('Dealer', 'dealer_id', refs.dealers)}
        </div>
      </details>

      <details className="track-card" open>
        <summary>
          <span className="track-title">Qualification</span>
        </summary>
        <div className="track-body">
          <label className="check-inline">
            <input type="checkbox" checked={values.homeowner_confirmed} disabled={terminal}
              onChange={(e) => set('homeowner_confirmed', e.target.checked)} />
            Homeowner confirmed
          </label>
          <label className="check-inline">
            <input type="checkbox" checked={values.decision_maker_identified} disabled={terminal}
              onChange={(e) => set('decision_maker_identified', e.target.checked)} />
            Decision makers identified
          </label>
          {refSelect('Roof type', 'roof_type_id', refs.roofTypes)}
          <label className="field">
            <span>Roof age (years)</span>
            <input type="number" value={values.roof_age ?? ''} disabled={terminal}
              onChange={(e) => set('roof_age', e.target.value === '' ? null : Number(e.target.value))} />
          </label>
          {refSelect('Utility', 'utility_id', refs.utilities)}
          <label className="field">
            <span>Average monthly bill ($)</span>
            <input type="number" value={values.avg_monthly_bill ?? ''} disabled={terminal}
              onChange={(e) =>
                set('avg_monthly_bill', e.target.value === '' ? null : Number(e.target.value))} />
          </label>
          <label className="field">
            <span>Financing appetite</span>
            <select value={values.credit_band ?? ''} disabled={terminal}
              onChange={(e) => set('credit_band', e.target.value || null)}>
              <option value="">—</option>
              <option value="cash">Cash</option>
              <option value="strong">Finance — strong</option>
              <option value="fair">Finance — fair</option>
              <option value="weak">Finance — weak</option>
              <option value="unknown">Not discussed</option>
            </select>
          </label>
        </div>
      </details>

      <details className="track-card" open>
        <summary>
          <span className="track-title">Proposal</span>
          {proposals.length > 0 && (
            <span className="chip days">{`v${proposals[0].version}`}</span>
          )}
        </summary>
        <div className="track-body">
          <label className="field">
            <span>System size (kW)</span>
            <input type="number" step="0.01" value={values.system_size_kw ?? ''} disabled={terminal}
              onChange={(e) =>
                set('system_size_kw', e.target.value === '' ? null : Number(e.target.value))} />
          </label>
          {refSelect('Module', 'module_id', refs.modules)}
          {refSelect('Inverter', 'inverter_id', refs.inverters)}
          {refSelect('Battery', 'battery_id', refs.batteries)}
          <label className="field">
            <span>Net price ($)</span>
            <input type="number" value={values.net_price ?? ''} disabled={terminal}
              onChange={(e) =>
                set('net_price', e.target.value === '' ? null : Number(e.target.value))} />
          </label>
          <label className="field">
            <span>Financing route</span>
            <select value={values.financing_route ?? ''} disabled={terminal}
              onChange={(e) => set('financing_route', e.target.value || null)}>
              <option value="">—</option>
              <option value="cash">Cash</option>
              <option value="loan">Loan</option>
              <option value="lease">Lease</option>
              <option value="ppa">PPA</option>
            </select>
          </label>
          {refSelect('Financing company', 'financing_company_id', refs.financingCompanies)}

          {proposals.length > 0 && (
            <>
              <h3>Versions</h3>
              {/* Part 5: versioned rows, not overwrites — "What did we quote
                  them in March?" has to have an answer. */}
              <ul className="gap-list">
                {proposals.map((p) => (
                  <li key={p.id}>
                    {`v${p.version}`}
                    {p.netPrice !== null && ` — $${p.netPrice.toLocaleString()}`}
                    <span className="dim">
                      {p.sentAt ? ` · sent ${p.sentAt.slice(0, 10)}` : ' · draft'}
                      {p.viewedAt ? ` · viewed ${p.viewedAt.slice(0, 10)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </details>

      <details className="track-card" open>
        <summary>
          <span className="track-title">Commercial</span>
        </summary>
        <div className="track-body">
          <label className="field">
            <span>Expected close date</span>
            <input type="date" value={values.expected_close_date ?? ''} disabled={terminal}
              onChange={(e) => set('expected_close_date', e.target.value || null)} />
          </label>
          <label className="field">
            <span>Contract value ($)</span>
            <input type="number" value={values.contract_value ?? ''} disabled={terminal}
              onChange={(e) =>
                set('contract_value', e.target.value === '' ? null : Number(e.target.value))} />
          </label>
          {refSelect('Competitor', 'competitor_id', refs.competitors)}
          <p className="dim">
            {`Probability ${deal.probability}% — from the stage`}
            {deal.probabilityIsOverride ? ', overridden by hand' : ''}.
          </p>
        </div>
      </details>

      <details className="track-card">
        <summary>
          <span className="track-title">Solar details</span>
          <span className="dim">
            {' '}system, usage, price and the paperwork
          </span>
        </summary>
        <div className="track-body wide-body">
          <DealSolarDetails clientId={deal.clientId} dealId={deal.id} readOnly={terminal} />
        </div>
      </details>

      <details className="track-card" open>
        <summary>
          <span className="track-title">Activity</span>
        </summary>
        <div className="track-body">
          {!terminal && (
            <>
              <div className="filters">
                <select value={log.kind} onChange={(e) => setLog({ ...log, kind: e.target.value })}>
                  <option value="call">Call</option>
                  <option value="email">Email</option>
                  <option value="sms">Text</option>
                  <option value="meeting">Meeting</option>
                  <option value="note">Note</option>
                </select>
                <label className="check-inline">
                  <input type="checkbox" checked={log.reached}
                    onChange={(e) => setLog({ ...log, reached: e.target.checked })} />
                  {/* A voicemail is an attempt: logged, but it does not move the
                      deal out of New. */}
                  They answered
                </label>
              </div>
              <label className="field">
                <span>What happened</span>
                <textarea rows={2} value={log.note}
                  onChange={(e) => setLog({ ...log, note: e.target.value })} />
              </label>
              <button className="btn secondary" type="button" disabled={busy || !log.note.trim()}
                onClick={() => void logActivity()}>
                Log it
              </button>
            </>
          )}
          <ul className="activity">
            {timeline.length === 0 && <li className="dim">Nothing logged yet.</li>}
            {timeline.map((t, i) => (
              <li key={i}>
                <span className="dim">{new Date(t.at).toLocaleString()}</span>
                {t.kind && t.kind !== 'field_change' && (
                  <span className="stage-chip-sm">{t.kind.replaceAll('_', ' ')}</span>
                )}{' '}
                {t.action}
                {t.actor ? <span className="dim">{` · ${t.actor}`}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      </details>

      {!terminal && (
        <div className="save-bar">
          {dirty && <span className="save-dirty">Unsaved changes</span>}
          <button className="btn" type="button" onClick={() => void save()} disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  );
}
