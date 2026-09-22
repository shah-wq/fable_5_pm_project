'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

/** An envelope as the e-signature APIs return it (src/lib/esign/service.ts). */
export interface EnvelopeView {
  id: string;
  purpose: 'contract' | 'change_order';
  status: string;
  delivery: 'email' | 'embedded';
  signerName: string | null;
  signerEmail: string;
  createdAt: string;
  sentAt: string | null;
  viewedAt: string | null;
  completedAt: string | null;
  appliedAt: string | null;
  lastError: string | null;
  projectId: string | null;
  projectCode: string | null;
  documentId: string | null;
  changeOrderId: string | null;
}

export const ESIGN_STATUS_LABELS: Record<string, string> = {
  preparing: 'Preparing',
  sent: 'Sent — awaiting signature',
  viewed: 'Opened by signer',
  completed: 'Signed',
  declined: 'Declined',
  voided: 'Voided',
  failed: 'Failed',
};

export async function envelopeAction(
  id: string,
  action: 'refresh' | 'session' | 'void'
): Promise<{ ok: boolean; envelope?: EnvelopeView; sessionUrl?: string | null; error?: string }> {
  const res = await fetch(`/api/esign/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: json?.error ?? `That did not work (${res.status}).` };
  return { ok: true, envelope: json?.envelope, sessionUrl: json?.sessionUrl ?? null };
}

/**
 * PandaDoc's signing screen, inside ours, for signing with the homeowner in
 * the room.
 *
 * PandaDoc tells the page it is embedded in when the document is completed
 * (a postMessage whose type names document.completed). That is taken as a cue,
 * not as proof: the page then asks the server to check with PandaDoc, and only
 * the server's answer finishes anything. "I've finished" does the same by
 * hand, for a browser that blocks the message.
 */
export function EmbeddedSigning({
  sessionUrl,
  envelopeId,
  onDone,
  onClose,
}: {
  sessionUrl: string;
  envelopeId: string;
  onDone: (envelope: EnvelopeView) => void;
  onClose: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    setNote(null);
    try {
      const r = await envelopeAction(envelopeId, 'refresh');
      if (!r.ok || !r.envelope) {
        setNote(r.error ?? 'Could not check.');
        return;
      }
      if (r.envelope.status === 'completed') onDone(r.envelope);
      else setNote(`PandaDoc says: ${ESIGN_STATUS_LABELS[r.envelope.status] ?? r.envelope.status}.`);
    } finally {
      setChecking(false);
    }
  }, [envelopeId, onDone]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!/pandadoc\.com$/.test(new URL(e.origin, window.location.href).hostname)) return;
      const text = typeof e.data === 'string' ? e.data : JSON.stringify(e.data ?? '');
      if (/document\.completed/.test(text)) void check();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [check]);

  return (
    <div className="esign-embed">
      <iframe src={sessionUrl} title="Sign the document" allow="camera; geolocation" />
      {note && <p className="dim">{note}</p>}
      <div className="dialog-actions">
        <button className="btn secondary" type="button" onClick={onClose} disabled={checking}>
          Close — they will sign later
        </button>
        <button className="btn" type="button" onClick={() => void check()} disabled={checking}>
          {checking ? 'Checking…' : 'I’ve finished signing'}
        </button>
      </div>
    </div>
  );
}

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

/**
 * The documents sent for signature on one record, newest first, with what can
 * be done about each: check where it is, sign it here, or withdraw it.
 */
export function EnvelopeList({
  envelopes,
  onChanged,
  onSigned,
}: {
  envelopes: EnvelopeView[];
  onChanged: () => void;
  onSigned?: (envelope: EnvelopeView) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [embed, setEmbed] = useState<{ id: string; url: string } | null>(null);

  async function act(env: EnvelopeView, action: 'refresh' | 'session' | 'void') {
    if (action === 'void' && !window.confirm('Withdraw this document? The signer can no longer sign it.')) return;
    setBusy(env.id);
    setError(null);
    try {
      const r = await envelopeAction(env.id, action);
      if (!r.ok) {
        setError(r.error ?? 'That did not work.');
        return;
      }
      if (action === 'session' && r.sessionUrl) {
        setEmbed({ id: env.id, url: r.sessionUrl });
        return;
      }
      if (r.envelope?.status === 'completed' && r.envelope.appliedAt && !env.appliedAt) {
        onSigned?.(r.envelope);
      }
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  if (envelopes.length === 0) return null;
  return (
    <div className="esign-list">
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <ul>
        {envelopes.map((env) => {
          const open = ['preparing', 'sent', 'viewed'].includes(env.status);
          const stuck = env.status === 'completed' && !env.appliedAt;
          return (
            <li key={env.id} className={`esign-row ${env.status}${stuck ? ' stuck' : ''}`}>
              <div>
                <strong>{ESIGN_STATUS_LABELS[env.status] ?? env.status}</strong>
                <span className="dim">
                  {' · '}
                  {env.signerName ? `${env.signerName} <${env.signerEmail}>` : env.signerEmail}
                  {' · '}
                  {env.completedAt
                    ? `signed ${when(env.completedAt)}`
                    : env.viewedAt
                      ? `opened ${when(env.viewedAt)}`
                      : env.sentAt
                        ? `sent ${when(env.sentAt)}`
                        : `created ${when(env.createdAt)}`}
                </span>
                {env.projectCode && env.projectId && (
                  <>
                    {' · '}
                    <Link href={`/projects/${env.projectId}`}>{env.projectCode}</Link>
                  </>
                )}
                {env.documentId && (
                  <>
                    {' · '}
                    <a href={`/api/files/${env.documentId}`} target="_blank" rel="noreferrer">
                      Signed PDF
                    </a>
                  </>
                )}
                {env.lastError && <p className="field-error">{env.lastError}</p>}
              </div>
              <div className="esign-actions">
                {(open || stuck) && (
                  <button
                    className="btn secondary small"
                    type="button"
                    disabled={busy === env.id}
                    onClick={() => void act(env, 'refresh')}
                  >
                    {stuck ? 'Finish' : 'Check status'}
                  </button>
                )}
                {open && env.status !== 'preparing' && (
                  <button
                    className="btn secondary small"
                    type="button"
                    disabled={busy === env.id}
                    onClick={() => void act(env, 'session')}
                  >
                    Sign here now
                  </button>
                )}
                {(open || env.status === 'failed') && (
                  <button
                    className="btn secondary small danger"
                    type="button"
                    disabled={busy === env.id}
                    onClick={() => void act(env, 'void')}
                  >
                    Void
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {embed && (
        <div className="dialog-backdrop">
          <div className="dialog wide-dialog" role="dialog" aria-modal aria-label="Sign the document">
            <EmbeddedSigning
              sessionUrl={embed.url}
              envelopeId={embed.id}
              onClose={() => {
                setEmbed(null);
                onChanged();
              }}
              onDone={(envelope) => {
                setEmbed(null);
                if (envelope.appliedAt) onSigned?.(envelope);
                onChanged();
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
