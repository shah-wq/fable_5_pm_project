'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { EmbeddedSigning, EnvelopeList, type EnvelopeView } from '@/app/(app)/_components/Esign';
import { announceProjectsChanged } from '@/lib/projects/live';

interface ChangeOrder {
  id: string;
  number: number;
  status: string;
  reason: string | null;
  description: string | null;
  amountDelta: number;
  requiresSignature: boolean;
  documentId: string | null;
  approvedAt: string | null;
  createdAt: string;
}

interface Loaded {
  orders: ChangeOrder[];
  envelopes: EnvelopeView[];
  ready: boolean;
  reason: string | null;
  contractValue: number | null;
  signer: { name: string | null; email: string | null };
}

const STATUS: Record<string, string> = {
  draft: 'Draft',
  pending_approval: 'Out for signature',
  approved: 'Approved',
  rejected: 'Declined',
  void: 'Void',
};

const usd = (n: number | null) =>
  n === null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/**
 * Change orders on the project: raise one, send it to the homeowner through
 * PandaDoc, or approve it by hand when it needs no signature or was signed on
 * paper. Signed or approved, its amount is added to the contract value — in
 * the database, so the figure here, on the dashboard and in reports agree.
 */
export function ChangeOrdersPanel({ projectId, prefix }: { projectId: string; prefix: string }) {
  const router = useRouter();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ reason: '', description: '', amount: '', requiresSignature: true });
  const [sending, setSending] = useState<ChangeOrder | null>(null);
  const [signer, setSigner] = useState({ name: '', email: '', delivery: 'email' as 'email' | 'embedded' });
  const [embed, setEmbed] = useState<{ id: string; url: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/change-orders`);
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      setError(json?.error ?? `Could not load change orders (${res.status}).`);
      return;
    }
    setData(json);
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  function changed() {
    void load();
    announceProjectsChanged();
    router.refresh();
  }

  async function post(url: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? `That did not work (${res.status}).`);
        return null;
      }
      return json;
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    const json = await post(`/api/projects/${projectId}/change-orders`, {
      reason: draft.reason,
      description: draft.description,
      amountDelta: draft.amount,
      requiresSignature: draft.requiresSignature,
    });
    if (json) {
      setAdding(false);
      setDraft({ reason: '', description: '', amount: '', requiresSignature: true });
      changed();
    }
  }

  async function send() {
    if (!sending) return;
    const json = await post(`/api/projects/${projectId}/change-orders/${sending.id}`, {
      action: 'send',
      signerName: signer.name,
      signerEmail: signer.email,
      delivery: signer.delivery,
    });
    if (json) {
      setSending(null);
      if (json.sessionUrl) setEmbed({ id: json.envelope.id, url: json.sessionUrl });
      changed();
    }
  }

  async function act(co: ChangeOrder, action: 'approve' | 'void') {
    const question =
      action === 'approve'
        ? `Approve ${prefix}${co.number} without e-signature? ${usd(co.amountDelta)} is added to the contract value.`
        : `Void ${prefix}${co.number}? It can no longer be signed or approved.`;
    if (!window.confirm(question)) return;
    if (await post(`/api/projects/${projectId}/change-orders/${co.id}`, { action })) changed();
  }

  return (
    <section className="panel change-orders">
      <h2>Change orders</h2>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {!data ? (
        <p className="dim">Loading…</p>
      ) : (
        <>
          <p className="dim">
            Contract value {usd(data.contractValue)}
            {!data.ready && data.reason ? ` · E-signature off: ${data.reason}` : ''}
          </p>
          {data.orders.length === 0 && !adding && <p className="dim">None yet.</p>}
          <ul className="co-list">
            {data.orders.map((co) => {
              const envs = data.envelopes.filter((e) => e.changeOrderId === co.id);
              const open = ['draft', 'rejected'].includes(co.status);
              return (
                <li key={co.id} className={`co-row ${co.status}`}>
                  <div className="co-head">
                    <strong>{`${prefix}${co.number}`}</strong>
                    <span className={`chip co-${co.status}`}>{STATUS[co.status] ?? co.status}</span>
                    <span className="co-amount">
                      {co.amountDelta >= 0 ? '+' : ''}
                      {usd(co.amountDelta)}
                    </span>
                  </div>
                  <div>{co.reason}</div>
                  {co.description && <div className="dim small">{co.description}</div>}
                  {co.documentId && (
                    <a href={`/api/files/${co.documentId}`} target="_blank" rel="noreferrer">
                      Signed change order
                    </a>
                  )}
                  <EnvelopeList envelopes={envs} onChanged={changed} onSigned={changed} />
                  {(open || co.status === 'pending_approval') && (
                    <div className="co-actions">
                      {open && data.ready && co.requiresSignature && (
                        <button
                          className="btn small"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setSending(co);
                            setSigner({
                              name: data.signer.name ?? '',
                              email: data.signer.email ?? '',
                              delivery: 'email',
                            });
                          }}
                        >
                          Send for e-signature
                        </button>
                      )}
                      {open && (
                        <button
                          className="btn secondary small"
                          type="button"
                          disabled={busy}
                          onClick={() => void act(co, 'approve')}
                        >
                          {co.requiresSignature ? 'Signed on paper — approve' : 'Approve'}
                        </button>
                      )}
                      <button
                        className="btn secondary small danger"
                        type="button"
                        disabled={busy}
                        onClick={() => void act(co, 'void')}
                      >
                        Void
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {adding ? (
            <div className="co-form">
              <label className="field">
                <span>Reason</span>
                <input
                  value={draft.reason}
                  placeholder="e.g. Main panel upgrade required"
                  onChange={(e) => setDraft((d) => ({ ...d, reason: e.target.value }))}
                />
              </label>
              <label className="field">
                <span>Details</span>
                <textarea
                  rows={2}
                  value={draft.description}
                  onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                />
              </label>
              <label className="field">
                <span>Change to contract value ($, negative for a credit)</span>
                <input
                  type="number"
                  step="0.01"
                  value={draft.amount}
                  onChange={(e) => setDraft((d) => ({ ...d, amount: e.target.value }))}
                />
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={draft.requiresSignature}
                  onChange={(e) => setDraft((d) => ({ ...d, requiresSignature: e.target.checked }))}
                />
                <span>The homeowner must sign it</span>
              </label>
              <div className="dialog-actions">
                <button className="btn secondary" type="button" disabled={busy} onClick={() => setAdding(false)}>
                  Cancel
                </button>
                <button className="btn" type="button" disabled={busy} onClick={() => void create()}>
                  {busy ? 'Saving…' : 'Raise change order'}
                </button>
              </div>
            </div>
          ) : (
            <button className="btn secondary" type="button" onClick={() => setAdding(true)}>
              + New change order
            </button>
          )}
        </>
      )}

      {sending && (
        <div className="dialog-backdrop" onClick={() => !busy && setSending(null)}>
          <div
            className="dialog"
            role="dialog"
            aria-modal
            aria-label="Send the change order"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>{`Send ${prefix}${sending.number} for e-signature`}</h2>
            {error && <p className="notice error">{error}</p>}
            <label className="field">
              <span>Signer’s name</span>
              <input value={signer.name} onChange={(e) => setSigner((s) => ({ ...s, name: e.target.value }))} />
            </label>
            <label className="field">
              <span>Signer’s email</span>
              <input
                type="email"
                value={signer.email}
                onChange={(e) => setSigner((s) => ({ ...s, email: e.target.value }))}
              />
            </label>
            <fieldset className="radio-row">
              <label>
                <input
                  type="radio"
                  checked={signer.delivery === 'email'}
                  onChange={() => setSigner((s) => ({ ...s, delivery: 'email' }))}
                />{' '}
                Email it to them
              </label>
              <label>
                <input
                  type="radio"
                  checked={signer.delivery === 'embedded'}
                  onChange={() => setSigner((s) => ({ ...s, delivery: 'embedded' }))}
                />{' '}
                Sign on this screen
              </label>
            </fieldset>
            <div className="dialog-actions">
              <button className="btn secondary" type="button" disabled={busy} onClick={() => setSending(null)}>
                Cancel
              </button>
              <button className="btn" type="button" disabled={busy} onClick={() => void send()}>
                {busy ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}

      {embed && (
        <div className="dialog-backdrop">
          <div className="dialog wide-dialog" role="dialog" aria-modal aria-label="Sign the change order">
            <EmbeddedSigning
              sessionUrl={embed.url}
              envelopeId={embed.id}
              onClose={() => {
                setEmbed(null);
                changed();
              }}
              onDone={() => {
                setEmbed(null);
                changed();
              }}
            />
          </div>
        </div>
      )}
    </section>
  );
}
