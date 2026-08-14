'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** The dealer's lead form. Name + address + (email or phone) are required. */
export function LeadForm({
  cashFinancing,
  defaultRep,
}: {
  cashFinancing: Array<{ id: string; name: string }>;
  defaultRep: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    setBusy(true);
    setError(null);
    setOk(false);
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          customerFirst: fd.get('first'),
          customerLast: fd.get('last'),
          customerEmail: fd.get('email'),
          customerPhone: fd.get('phone'),
          address: fd.get('address'),
          salesRepName: fd.get('rep'),
          estimatedSizeKw: fd.get('kw') ? Number(fd.get('kw')) : null,
          cashOrFinancingId: fd.get('cash') || null,
          notes: fd.get('notes'),
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? `Submission failed (${res.status}).`);
        return;
      }
      form.reset();
      setOk(true);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {ok && <p className="notice ok">Lead submitted — the PM team will review it.</p>}
      <form className="form-grid" onSubmit={onSubmit}>
        <label className="field">
          <span>Customer first name *</span>
          <input name="first" required />
        </label>
        <label className="field">
          <span>Customer last name *</span>
          <input name="last" required />
        </label>
        <label className="field">
          <span>Customer email</span>
          <input name="email" type="email" />
        </label>
        <label className="field">
          <span>Customer phone</span>
          <input name="phone" />
        </label>
        <label className="field">
          <span>Site address *</span>
          <input name="address" required placeholder="Street, city, state ZIP" />
        </label>
        <label className="field">
          <span>Sales rep</span>
          <input name="rep" defaultValue={defaultRep} />
        </label>
        <label className="field">
          <span>Estimated system size (kW)</span>
          <input name="kw" type="number" step="any" min={0} />
        </label>
        <label className="field">
          <span>Cash or Financing</span>
          <select name="cash" defaultValue="">
            <option value="">—</option>
            {cashFinancing.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ gridColumn: '1 / -1' }}>
          <span>Notes — anything the PM should know</span>
          <textarea name="notes" rows={3} />
        </label>
        <div>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Submitting…' : 'Submit lead'}
          </button>
          <p className="dim">Email or phone — at least one is required.</p>
        </div>
      </form>
    </section>
  );
}
