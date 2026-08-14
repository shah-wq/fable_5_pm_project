'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

type ActionKind = 'availability' | 'question' | 'contact_update' | 'document';

const TITLES: Record<ActionKind, string> = {
  availability: 'Send us your availability',
  question: 'Ask your project manager a question',
  contact_update: 'Update your contact details',
  document: 'Send us a document or photo',
};

/**
 * The four things a customer can actually do. Each one lands in the project
 * manager's queue — availability is a request, not a booking, so the portal
 * never promises a date the company has not confirmed.
 */
export function CustomerActions({
  projectId,
  requests,
  pmName,
}: {
  projectId: string;
  requests: Array<{ id: string; kind: string; created: string; message: string | null; reply: string | null; status: string }>;
  pmName: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<ActionKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  async function submit(kind: ActionKind, body: Record<string, unknown>, file?: File | null) {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'document') {
        if (!file) {
          setError('Choose a file first.');
          return;
        }
        const form = new FormData();
        form.append('file', file);
        form.append('projectId', projectId);
        form.append('note', String(body.message ?? ''));
        const res = await fetch('/api/portal/uploads', { method: 'POST', body: form });
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          setError(json?.error ?? `Upload failed (${res.status}).`);
          return;
        }
      } else {
        const res = await fetch('/api/portal/requests', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId, kind, ...body }),
        });
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          setError(json?.error ?? `Could not send (${res.status}).`);
          return;
        }
      }
      setOpen(null);
      setSent(
        kind === 'availability'
          ? `Thank you — ${pmName ?? 'your project manager'} will confirm the actual date with you.`
          : kind === 'question'
            ? `Sent — ${pmName ?? 'your project manager'} will reply by email or phone.`
            : kind === 'document'
              ? 'Received, thank you. It is now in your documents below.'
              : 'Thank you — we have passed your new details to your project manager.'
      );
      setTimeout(() => setSent(null), 8000);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel portal-actions">
      <h2>Contact us</h2>
      {sent && <p className="notice ok">{sent}</p>}
      {error && !open && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div className="action-row">
        {(Object.keys(TITLES) as ActionKind[]).map((kind) => (
          <button key={kind} className="btn secondary" type="button" onClick={() => { setError(null); setOpen(kind); }}>
            {TITLES[kind]}
          </button>
        ))}
      </div>

      {requests.length > 0 && (
        <>
          <h2>Your messages</h2>
          <ul className="activity">
            {requests.map((r) => (
              <li key={r.id}>
                <span className="dim">{r.created}</span>{' '}
                {r.kind === 'availability' ? 'Availability sent'
                  : r.kind === 'question' ? 'Question sent'
                  : r.kind === 'document' ? 'Document sent'
                  : 'Contact details updated'}
                {r.message ? `: ${r.message}` : ''}
                {r.reply && (
                  <div>
                    <strong>Reply:</strong> {r.reply}
                  </div>
                )}
                {r.status === 'open' && <span className="dim"> · awaiting reply</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {open && (
        <ActionDialog
          kind={open}
          busy={busy}
          error={error}
          onClose={() => setOpen(null)}
          onSubmit={(body, file) => submit(open, body, file)}
        />
      )}
    </section>
  );
}

function ActionDialog({
  kind,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  kind: ActionKind;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>, file?: File | null) => void;
}) {
  const [message, setMessage] = useState('');
  const [dates, setDates] = useState('');
  const [window_, setWindow] = useState('morning');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [preferred, setPreferred] = useState('phone');
  const [file, setFile] = useState<File | null>(null);

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal>
        <h2>{TITLES[kind]}</h2>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}

        {kind === 'availability' && (
          <>
            <p className="dim">
              Tell us the days that suit you and we&apos;ll confirm the actual appointment — this
              is a request, not a booking.
            </p>
            <label className="field">
              <span>Days that work for you *</span>
              <input
                value={dates}
                onChange={(e) => setDates(e.target.value)}
                placeholder="e.g. Tue 12th or Wed 13th"
              />
            </label>
            <label className="field">
              <span>Time of day</span>
              <select value={window_} onChange={(e) => setWindow(e.target.value)}>
                <option value="morning">Morning</option>
                <option value="afternoon">Afternoon</option>
                <option value="any">Any time</option>
              </select>
            </label>
          </>
        )}

        {kind === 'question' && (
          <label className="field">
            <span>Your question *</span>
            <textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} />
          </label>
        )}

        {kind === 'contact_update' && (
          <>
            <label className="field">
              <span>Phone</span>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </label>
            <label className="field">
              <span>Email</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="field">
              <span>Best way to reach you</span>
              <select value={preferred} onChange={(e) => setPreferred(e.target.value)}>
                <option value="phone">Phone call</option>
                <option value="text">Text message</option>
                <option value="email">Email</option>
              </select>
            </label>
          </>
        )}

        {kind === 'document' && (
          <>
            <p className="dim">A utility bill, HOA paperwork, or a photo we asked for. PDF or image, up to 25 MB.</p>
            <label className="field">
              <span>File *</span>
              <input
                type="file"
                accept="image/*,application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <label className="field">
              <span>Anything we should know</span>
              <input value={message} onChange={(e) => setMessage(e.target.value)} />
            </label>
          </>
        )}

        <div className="dialog-actions">
          <button className="btn secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn"
            type="button"
            disabled={
              busy
              || (kind === 'availability' && dates.trim().length < 3)
              || (kind === 'question' && message.trim().length < 3)
              || (kind === 'document' && !file)
              || (kind === 'contact_update' && !phone.trim() && !email.trim())
            }
            onClick={() =>
              onSubmit(
                {
                  message: message.trim() || null,
                  preferredDates: dates.trim() || null,
                  timeWindow: kind === 'availability' ? window_ : null,
                  contactPhone: phone.trim() || null,
                  contactEmail: email.trim() || null,
                  preferredContact: kind === 'contact_update' ? preferred : null,
                },
                file
              )
            }
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
