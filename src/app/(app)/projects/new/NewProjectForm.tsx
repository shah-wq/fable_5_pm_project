'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Option {
  id: string;
  name: string;
}

export function NewProjectForm({
  dealers,
  financePartners,
  pms,
  defaultPm,
}: {
  dealers: Option[];
  financePartners: Option[];
  pms: Option[];
  defaultPm: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const f = new FormData(e.currentTarget);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          customerFirst: f.get('first'),
          customerLast: f.get('last'),
          customerEmail: f.get('email'),
          customerPhone: f.get('phone'),
          address: f.get('address'),
          dealerId: f.get('dealer'),
          financePartnerId: f.get('finance') || undefined,
          systemSizeKw: f.get('kw') ? Number(f.get('kw')) : undefined,
          contractValue: f.get('contract') ? Number(f.get('contract')) : undefined,
          assignedPm: f.get('pm'),
        }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.projectId) {
        router.replace(`/projects/${json.projectId}`);
        router.refresh();
        return;
      }
      setError(json?.error ?? `Could not create the project (${res.status}).`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack-form" onSubmit={onSubmit}>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div className="form-grid">
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
      </div>
      <label className="field">
        <span>Site address *</span>
        <input name="address" required placeholder="Street, city, state ZIP" />
      </label>
      <div className="form-grid">
        <label className="field">
          <span>Dealer *</span>
          <select name="dealer" required defaultValue="">
            <option value="" disabled>
              Select dealer…
            </option>
            {dealers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Finance partner</span>
          <select name="finance" defaultValue="">
            <option value="">Cash / none</option>
            {financePartners.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>System size (kW)</span>
          <input name="kw" type="number" step="0.01" min="0" />
        </label>
        <label className="field">
          <span>Contract total ($)</span>
          <input name="contract" type="number" step="0.01" min="0" />
        </label>
        <label className="field">
          <span>Assigned PM</span>
          <select name="pm" defaultValue={defaultPm}>
            {pms.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button className="btn" type="submit" disabled={busy}>
        {busy ? 'Creating…' : 'Create project'}
      </button>
    </form>
  );
}
