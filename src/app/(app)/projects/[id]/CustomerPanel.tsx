'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface CustomerRequestRow {
  id: string;
  kind: string;
  message: string | null;
  preferredDates: string | null;
  timeWindow: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  documentId: string | null;
  status: string;
  reply: string | null;
  created: string;
}

export interface ProjectDocumentRow {
  id: string;
  title: string;
  category: string;
  customerVisible: boolean;
  created: string;
}

const KIND_LABELS: Record<string, string> = {
  availability: 'Availability offered',
  question: 'Question',
  contact_update: 'Contact details changed',
  document: 'Document sent',
};

/**
 * The PM's side of the customer portal: what the customer asked for, the
 * completion estimate they see (blank shows 'being scheduled' rather than a
 * guess), and which documents are shared with them.
 */
export function CustomerPanel({
  projectId,
  requests,
  documents,
  estimate,
  hasPortalAccess,
  customerEmail,
}: {
  projectId: string;
  requests: CustomerRequestRow[];
  documents: ProjectDocumentRow[];
  estimate: string | null;
  hasPortalAccess: boolean;
  customerEmail: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<CustomerRequestRow | null>(null);
  const [reply, setReply] = useState('');
  const [estimateDraft, setEstimateDraft] = useState(estimate ?? '');

  const open = requests.filter((r) => r.status === 'open');

  async function call(url: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? `Failed (${res.status}).`);
        return false;
      }
      router.refresh();
      return true;
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Customer portal</h2>
        {open.length > 0 && <span className="missing-badge">{open.length}</span>}
      </div>

      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      {!hasPortalAccess && (
        <p className="dim">
          {customerEmail
            ? 'No portal login yet — invite them from Admin → Users (role Customer, linked to this client).'
            : 'No customer email on this project, so there is no portal access. Add one on the Details tab.'}
        </p>
      )}

      <label className="field">
        <span>Estimated completion shown to the customer</span>
        <input
          value={estimateDraft}
          onChange={(e) => setEstimateDraft(e.target.value)}
          placeholder="e.g. October 2026, or mid-November"
        />
        <small className="dim">
          Left blank, the portal says scheduling is in progress rather than guessing a date.
        </small>
      </label>
      <button
        className="btn secondary small"
        type="button"
        disabled={busy || estimateDraft === (estimate ?? '')}
        onClick={() =>
          call(`/api/projects/${projectId}/details`, {
            values: { customer_estimate: estimateDraft.trim() || null },
          })
        }
      >
        Save estimate
      </button>

      <h3 className="drawer-sub">Requests from the customer</h3>
      {requests.length === 0 ? (
        <p className="dim">Nothing yet.</p>
      ) : (
        <ul className="activity">
          {requests.map((r) => (
            <li key={r.id}>
              <span className="dim">{r.created}</span>{' '}
              <strong>{KIND_LABELS[r.kind] ?? r.kind}</strong>
              {r.status === 'open' ? <span className="hold-chip"> open</span> : null}
              <div>
                {r.message}
                {r.preferredDates && (
                  <div>
                    Prefers: {r.preferredDates}
                    {r.timeWindow ? ` (${r.timeWindow})` : ''}
                  </div>
                )}
                {(r.contactPhone || r.contactEmail) && (
                  <div className="dim">
                    New contact: {[r.contactPhone, r.contactEmail].filter(Boolean).join(' · ')}
                  </div>
                )}
                {r.documentId && (
                  <div>
                    <a href={`/api/files/${r.documentId}`}>Open the file they sent</a>
                  </div>
                )}
                {r.reply && (
                  <div>
                    <strong>Your reply:</strong> {r.reply}
                  </div>
                )}
              </div>
              {r.status === 'open' && (
                <span className="ref-row">
                  <button
                    className="btn secondary small"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setReply('');
                      setReplyTo(r);
                    }}
                  >
                    Reply
                  </button>
                  <button
                    className="btn secondary small"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      call(`/api/projects/${projectId}/requests/${r.id}`, { resolve: true })
                    }
                  >
                    Mark handled
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className="drawer-sub">Shared with the customer</h3>
      {documents.length === 0 ? (
        <p className="dim">No documents uploaded yet.</p>
      ) : (
        <ul className="activity">
          {documents.map((d) => (
            <li key={d.id}>
              <label className="check-inline">
                <input
                  type="checkbox"
                  checked={d.customerVisible}
                  disabled={busy}
                  onChange={(e) =>
                    call(`/api/documents/${d.id}`, { customerVisible: e.target.checked })
                  }
                />
                {d.title}
                <span className="dim"> · {d.category.replaceAll('_', ' ')}</span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {replyTo && (
        <div className="dialog-backdrop">
          <div className="dialog" role="dialog" aria-modal>
            <h2>Reply to the customer</h2>
            <p className="dim">
              {KIND_LABELS[replyTo.kind] ?? replyTo.kind}
              {replyTo.message ? `: ${replyTo.message}` : ''}
            </p>
            <label className="field">
              <span>Your reply *</span>
              <textarea rows={4} value={reply} onChange={(e) => setReply(e.target.value)} />
            </label>
            <div className="dialog-actions">
              <button className="btn secondary" type="button" onClick={() => setReplyTo(null)}>
                Cancel
              </button>
              <button
                className="btn"
                type="button"
                disabled={busy || reply.trim().length < 2}
                onClick={() =>
                  call(`/api/projects/${projectId}/requests/${replyTo.id}`, {
                    reply: reply.trim(),
                    resolve: true,
                  }).then((ok) => ok && setReplyTo(null))
                }
              >
                Send reply
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
