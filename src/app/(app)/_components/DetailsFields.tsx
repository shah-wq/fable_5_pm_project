'use client';

import { useState } from 'react';
import {
  fieldVisible,
  type DetailBlock,
  type RefKey,
  type RefOption,
} from '@/lib/projects/details';
import { Combobox } from './Combobox';

export type DetailValues = Record<string, unknown>;
export type DetailRefs = Record<RefKey, RefOption[]>;

/**
 * Renders one block of the New Project form / Details tab from the shared
 * registry: conditional visibility (Battery Type, Financing Company…),
 * type-ahead comboboxes for the long lists, and '+ Add new' inline for the
 * Sales Reps list.
 */
export function DetailsFields({
  block,
  values,
  refs,
  onChange,
  onRefAdded,
}: {
  block: DetailBlock;
  values: DetailValues;
  refs: DetailRefs;
  onChange: (name: string, value: unknown) => void;
  onRefAdded: (key: RefKey, option: RefOption) => void;
}) {
  const [addNew, setAddNew] = useState<{ field: string; refKey: RefKey } | null>(null);

  return (
    <div className="form-grid">
      {block.fields.map((f) => {
        if (!fieldVisible(f, values, refs)) return null;
        const value = values[f.name];
        return (
          <label className="field" key={f.name}>
            <span>
              {f.label}
              {f.required ? ' *' : ''}
            </span>
            {f.type === 'ref' && f.combo ? (
              <Combobox
                options={refs[f.refKey!]}
                value={(value as string) ?? null}
                onChange={(id) => onChange(f.name, id)}
              />
            ) : f.type === 'ref' ? (
              <span className="ref-row">
                <select
                  value={(value as string) ?? ''}
                  required={f.required}
                  onChange={(e) => onChange(f.name, e.target.value || null)}
                >
                  <option value="">{f.required ? 'Select…' : '—'}</option>
                  {refs[f.refKey!].map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
                {f.addNew && (
                  <button
                    className="btn secondary small"
                    type="button"
                    onClick={() => setAddNew({ field: f.name, refKey: f.refKey! })}
                  >
                    + Add new
                  </button>
                )}
              </span>
            ) : f.type === 'textarea' ? (
              <textarea
                rows={3}
                value={(value as string) ?? ''}
                onChange={(e) => onChange(f.name, e.target.value)}
              />
            ) : (
              <input
                type={
                  f.type === 'email'
                    ? 'email'
                    : f.type === 'number' || f.type === 'currency'
                      ? 'number'
                      : 'text'
                }
                step={f.type === 'currency' ? '0.01' : f.type === 'number' ? 'any' : undefined}
                min={f.type === 'currency' || f.type === 'number' ? 0 : undefined}
                required={f.required}
                value={value === null || value === undefined ? '' : String(value)}
                placeholder={f.note}
                onChange={(e) => onChange(f.name, e.target.value)}
              />
            )}
            {f.note && <small className="dim">{f.note}</small>}
          </label>
        );
      })}

      {addNew && (
        <AddRefDialog
          refKey={addNew.refKey}
          onClose={() => setAddNew(null)}
          onCreated={(option) => {
            onRefAdded(addNew.refKey, option);
            onChange(addNew.field, option.id);
            setAddNew(null);
          }}
        />
      )}
    </div>
  );
}

function AddRefDialog({
  refKey,
  onClose,
  onCreated,
}: {
  refKey: RefKey;
  onClose: () => void;
  onCreated: (option: RefOption) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isRep = refKey === 'salesReps';

  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/refs/${refKey === 'salesReps' ? 'sales_reps' : 'dealers'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), email: email.trim() || null, phone: phone.trim() || null }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.id) {
        setError(json?.error ?? `Could not add (${res.status}).`);
        return;
      }
      onCreated({ id: json.id, name: name.trim() });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal>
        <h2>{isRep ? 'Add sales rep' : 'Add dealer'}</h2>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <label className="field">
          <span>Name *</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>Phone</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>
        <div className="dialog-actions">
          <button className="btn secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="button" disabled={busy || !name.trim()} onClick={submit}>
            {busy ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}
