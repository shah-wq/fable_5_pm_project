'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * A new deal, typed in by a rep.
 *
 * The duplicate check runs on save (Part 4: every creation path), and offers to
 * attach the deal to the person already on file rather than making a second
 * record of them.
 */
export function NewDealForm({
  sources,
  dealers,
  owners,
}: {
  sources: Array<{ id: string; name: string }>;
  dealers: Array<{ id: string; name: string }>;
  owners: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<
    Array<{ id: string; name: string; email: string | null; lifecycle: string; projects: number }>
  >([]);
  const [form, setForm] = useState({
    firstName: '', lastName: '', email: '', phone: '', address: '',
    sourceId: '', dealerId: '', ownerId: '', nextAction: '', nextActionAt: '',
  });
  const [attachTo, setAttachTo] = useState<string | null>(null);

  async function submit(allowDuplicate: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/deals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...form, clientId: attachTo, allowDuplicate }),
      });
      const json = await res.json().catch(() => null);
      if (res.status === 409 && json?.duplicates) {
        setDuplicates(json.duplicates);
        setError(json.error);
        return;
      }
      if (!res.ok) {
        setError(json?.error ?? `Could not create the deal (${res.status}).`);
        return;
      }
      router.push(`/deals/${json.id}`);
    } finally {
      setBusy(false);
    }
  }

  const field = (label: string, key: keyof typeof form, type = 'text') => (
    <label className="field" key={key}>
      <span>{label}</span>
      <input
        type={type}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    </label>
  );

  return (
    <form
      className="stage-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(false);
      }}
    >
      {error && (
        <div className="notice error" role="alert">
          {error}
          {duplicates.length > 0 && (
            <>
              <ul className="gap-list">
                {duplicates.map((d) => (
                  <li key={d.id}>
                    {`${d.name} — ${d.lifecycle.replaceAll('_', ' ')}, ${d.projects} project(s)`}{' '}
                    <button
                      className="btn secondary small"
                      type="button"
                      onClick={() => {
                        setAttachTo(d.id);
                        setError(null);
                        setDuplicates([]);
                      }}
                    >
                      Use this person
                    </button>
                  </li>
                ))}
              </ul>
              <button className="btn secondary small" type="button" disabled={busy}
                onClick={() => void submit(true)}>
                They really are somebody else — create a separate record
              </button>
            </>
          )}
        </div>
      )}

      {attachTo && (
        <p className="notice ok">
          This deal will be attached to the person already on file.{' '}
          <button className="linklike" type="button" onClick={() => setAttachTo(null)}>
            Undo
          </button>
        </p>
      )}

      <details className="track-card" open>
        <summary>
          <span className="track-title">Who and where</span>
        </summary>
        <div className="track-body">
          {field('First name', 'firstName')}
          {field('Last name', 'lastName')}
          {field('Email', 'email', 'email')}
          {field('Phone', 'phone')}
          {field('Property address', 'address')}
        </div>
      </details>

      <details className="track-card" open>
        <summary>
          <span className="track-title">Where it came from</span>
        </summary>
        <div className="track-body">
          <label className="field">
            <span>Source *</span>
            {/* Set once at creation and never overwritten (Part 4). */}
            <select value={form.sourceId} onChange={(e) => setForm({ ...form, sourceId: e.target.value })}>
              <option value="">—</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Dealer</span>
            <select value={form.dealerId} onChange={(e) => setForm({ ...form, dealerId: e.target.value })}>
              <option value="">None</option>
              {dealers.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Owner</span>
            <select value={form.ownerId} onChange={(e) => setForm({ ...form, ownerId: e.target.value })}>
              <option value="">Leave unassigned</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </label>
        </div>
      </details>

      <details className="track-card" open>
        <summary>
          <span className="track-title">Next action</span>
        </summary>
        <div className="track-body">
          {field('What happens next', 'nextAction')}
          {field('When', 'nextActionAt', 'date')}
        </div>
      </details>

      <div className="save-bar">
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create deal'}
        </button>
      </div>
    </form>
  );
}
