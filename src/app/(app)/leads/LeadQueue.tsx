'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Lead = Record<string, unknown> & { id: string; status: string };

/** Review / Convert / Decline actions over the dealer-submitted leads. */
export function LeadQueue({ leads }: { leads: Lead[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decline, setDecline] = useState<Lead | null>(null);
  const [reason, setReason] = useState('');

  async function act(lead: Lead, action: 'review' | 'convert' | 'decline', declinedReason?: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, declinedReason }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? `Action failed (${res.status}).`);
        return;
      }
      setDecline(null);
      setReason('');
      if (action === 'convert' && json?.projectId) {
        router.push(`/projects/${json.projectId}`);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const open = leads.filter((l) => ['submitted', 'under_review'].includes(l.status));
  const closed = leads.filter((l) => !['submitted', 'under_review'].includes(l.status));

  return (
    <>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      <div className="table-wrap">
        <table className="projects-table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Dealer</th>
              <th>Site address</th>
              <th>Contact</th>
              <th>Est. kW</th>
              <th>Deal</th>
              <th>Notes</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {[...open, ...closed].map((l) => (
              <tr key={l.id}>
                <td>
                  {String(l.customer_first)} {String(l.customer_last)}
                  <div className="dim">{new Date(String(l.created_at)).toLocaleDateString()}</div>
                </td>
                <td>{String(l.dealer_name ?? '—')}</td>
                <td>{String(l.address)}</td>
                <td>
                  {l.customer_email ? String(l.customer_email) : null}
                  {l.customer_email && l.customer_phone ? ' · ' : null}
                  {l.customer_phone ? String(l.customer_phone) : null}
                </td>
                <td>{l.estimated_size_kw === null ? '—' : String(l.estimated_size_kw)}</td>
                <td>{String(l.cash_or_financing_name ?? '—')}</td>
                <td className="dim">{l.notes ? String(l.notes) : '—'}</td>
                <td>
                  {l.status === 'converted' && l.converted_project_id ? (
                    <Link href={`/projects/${String(l.converted_project_id)}`}>Converted →</Link>
                  ) : l.status === 'declined' ? (
                    <span title={String(l.declined_reason ?? '')}>Declined</span>
                  ) : (
                    String(l.status).replaceAll('_', ' ')
                  )}
                </td>
                <td>
                  {['submitted', 'under_review'].includes(l.status) && (
                    <span className="ref-row">
                      {l.status === 'submitted' && (
                        <button
                          className="btn secondary small"
                          type="button"
                          disabled={busy}
                          onClick={() => act(l, 'review')}
                        >
                          Review
                        </button>
                      )}
                      <button
                        className="btn small"
                        type="button"
                        disabled={busy}
                        onClick={() => act(l, 'convert')}
                      >
                        Convert
                      </button>
                      <button
                        className="btn secondary small"
                        type="button"
                        disabled={busy}
                        onClick={() => setDecline(l)}
                      >
                        Decline
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {leads.length === 0 && (
              <tr>
                <td colSpan={9} className="dim">
                  No leads yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {decline && (
        <div className="dialog-backdrop">
          <div className="dialog" role="dialog" aria-modal>
            <h2>Decline lead</h2>
            <p>
              Decline <strong>{String(decline.customer_first)} {String(decline.customer_last)}</strong>?
              The dealer sees the reason.
            </p>
            <label className="field">
              <span>Reason *</span>
              <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <div className="dialog-actions">
              <button className="btn secondary" type="button" onClick={() => setDecline(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                type="button"
                disabled={busy || reason.trim().length < 3}
                onClick={() => act(decline, 'decline', reason.trim())}
              >
                Decline lead
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
