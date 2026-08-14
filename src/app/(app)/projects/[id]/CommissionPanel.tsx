'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface CommissionValue {
  baseAmount: number;
  adjustment: number;
  status: string;
  payableDate: string | null;
  paidDate: string | null;
  notes: string | null;
}

/**
 * The internal commission panel: what the dealer portal shows read-only, an
 * admin sets here — base, adjustment (adders / contract changes), status and
 * its dates. Every save is audited.
 */
export function CommissionPanel({
  projectId,
  initial,
  isAdmin,
}: {
  projectId: string;
  initial: CommissionValue | null;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState<CommissionValue>(
    initial ?? { baseAmount: 0, adjustment: 0, status: 'pending', payableDate: null, paidDate: null, notes: null }
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const total = v.baseAmount + v.adjustment;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/commission`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(v),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? `Save failed (${res.status}).`);
        return;
      }
      setEditing(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Commission</h2>
        {isAdmin && !editing && (
          <button className="btn secondary small" type="button" onClick={() => setEditing(true)}>
            {initial ? 'Edit' : 'Set'}
          </button>
        )}
      </div>

      {!editing ? (
        initial ? (
          <dl className="facts">
            <dt>Base</dt>
            <dd>${initial.baseAmount.toLocaleString()}</dd>
            <dt>Adjustment</dt>
            <dd>${initial.adjustment.toLocaleString()}</dd>
            <dt>Total</dt>
            <dd>
              <strong>${(initial.baseAmount + initial.adjustment).toLocaleString()}</strong>
            </dd>
            <dt>Status</dt>
            <dd>
              {initial.status}
              {initial.status === 'payable' && initial.payableDate
                ? ` · ${new Date(initial.payableDate).toLocaleDateString()}`
                : ''}
              {initial.status === 'paid' && initial.paidDate
                ? ` · ${new Date(initial.paidDate).toLocaleDateString()}`
                : ''}
            </dd>
            {initial.notes && (
              <>
                <dt>Notes</dt>
                <dd>{initial.notes}</dd>
              </>
            )}
          </dl>
        ) : (
          <p className="dim">
            Not set. The dealer portal shows this as pending until an admin enters it.
          </p>
        )
      ) : (
        <>
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <div className="form-grid">
            <label className="field">
              <span>Base commission ($)</span>
              <input
                type="number"
                step="0.01"
                value={v.baseAmount}
                onChange={(e) => setV({ ...v, baseAmount: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              <span>Adjustment ($)</span>
              <input
                type="number"
                step="0.01"
                value={v.adjustment}
                onChange={(e) => setV({ ...v, adjustment: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              <span>Status</span>
              <select value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })}>
                <option value="pending">pending (project active)</option>
                <option value="payable">payable (normally at PTO)</option>
                <option value="paid">paid</option>
              </select>
            </label>
            {v.status === 'payable' && (
              <label className="field">
                <span>Payable date</span>
                <input
                  type="date"
                  value={v.payableDate ?? ''}
                  onChange={(e) => setV({ ...v, payableDate: e.target.value || null })}
                />
              </label>
            )}
            {v.status === 'paid' && (
              <label className="field">
                <span>Paid date *</span>
                <input
                  type="date"
                  value={v.paidDate ?? ''}
                  onChange={(e) => setV({ ...v, paidDate: e.target.value || null })}
                />
              </label>
            )}
            <label className="field" style={{ gridColumn: '1 / -1' }}>
              <span>Notes</span>
              <textarea
                rows={2}
                value={v.notes ?? ''}
                onChange={(e) => setV({ ...v, notes: e.target.value || null })}
              />
            </label>
          </div>
          <p className="dim">Total: ${total.toLocaleString()}</p>
          <div className="dialog-actions">
            <button className="btn secondary" type="button" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="btn" type="button" disabled={busy} onClick={save}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
