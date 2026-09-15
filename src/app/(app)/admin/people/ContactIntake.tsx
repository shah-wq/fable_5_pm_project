'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { IntakeForm, type IntakeDoc, type IntakeRefs, type IntakeValues } from '@/app/(app)/_components/IntakeForm';
import type { IntakeField } from '@/lib/crm/intake';

interface DealOption {
  id: string;
  code: string | null;
  stage: string;
  updated_at: string;
}

/**
 * The intake tab on a contact: every field, against the deal being worked.
 *
 * The deal picker at the top is the honest part. A person with one deal never
 * sees a choice; a person with two gets told which set of system details they
 * are looking at, because "System size 8.4 kW" is meaningless on a record that
 * covers two houses.
 */
export function ContactIntake({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [values, setValues] = useState<IntakeValues>({});
  const [refs, setRefs] = useState<IntakeRefs | null>(null);
  const [docs, setDocs] = useState<IntakeDoc[]>([]);
  const [deals, setDeals] = useState<DealOption[]>([]);
  const [dealId, setDealId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load(deal?: string | null) {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/customers/${clientId}/intake${deal ? `?deal=${deal}` : ''}`
      );
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? `Could not load the contact (${res.status}).`);
        return;
      }
      setValues(json.values ?? {});
      setRefs(json.refs ?? null);
      setDocs(json.documents ?? []);
      setDeals(json.deals ?? []);
      setDealId(json.dealId ?? null);
      setDirty(false);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // clientId is the only thing that should re-fetch from scratch.
  }, [clientId]);

  function change(field: IntakeField, value: unknown) {
    setValues((v) => ({ ...v, [field.name]: value }));
    setDirty(true);
    setNotice(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/customers/${clientId}/intake`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dealId, values }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? `Save failed (${res.status}).`);
        return;
      }
      setDirty(false);
      setNotice('Saved.');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function upload(category: string, files: FileList | null) {
    if (!files || files.length === 0 || !dealId) return;
    setError(null);
    const body = new FormData();
    body.append('category', category);
    body.append('file', files[0]);
    const res = await fetch(`/api/deals/${dealId}/documents`, { method: 'POST', body });
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      setError(json?.error ?? `Upload failed (${res.status}).`);
      return;
    }
    await load(dealId);
  }

  async function removeDoc(id: string) {
    if (!window.confirm('Remove this file? (Logged to the activity log.)')) return;
    const res = await fetch(`/api/documents/${id}`, { method: 'DELETE' });
    if (res.ok) await load(dealId);
  }

  if (loading) return <p className="dim">Loading…</p>;

  return (
    <>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {notice && !dirty && <p className="notice ok">{notice}</p>}

      {deals.length === 0 ? (
        <p className="notice">
          The system, price and document fields belong to a deal, and this person has none yet.
          Create one from the Deals board and they will fill in here.
        </p>
      ) : deals.length > 1 ? (
        <label className="field">
          <span>Which deal</span>
          <select
            value={dealId ?? ''}
            onChange={(e) => {
              setDealId(e.target.value);
              void load(e.target.value);
            }}
          >
            {deals.map((d) => (
              <option key={d.id} value={d.id}>
                {`${d.code ?? d.id.slice(0, 8)} · ${d.stage.replaceAll('_', ' ')} · updated ${d.updated_at.slice(0, 10)}`}
              </option>
            ))}
          </select>
          <em className="field-note">
            This person has {deals.length} deals. The system and price fields below belong to the
            one selected here.
          </em>
        </label>
      ) : null}

      {refs && (
        <IntakeForm
          values={values}
          refs={refs}
          documents={docs}
          dealId={dealId}
          onChange={change}
          onUpload={upload}
          onRemoveDoc={removeDoc}
        />
      )}

      <div className="save-bar">
        {dirty && <span className="save-dirty">Unsaved changes</span>}
        <button className="btn" type="button" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>
  );
}
