'use client';

import { useCallback, useEffect, useState } from 'react';
import type { IntakeDoc, IntakeRefs, IntakeValues } from '@/app/(app)/_components/IntakeForm';
import type { IntakeField } from '@/lib/crm/intake';

export interface DealOption {
  id: string;
  code: string | null;
  stage: string;
  updated_at: string;
}

/**
 * Loading and saving one intake, wherever it is being shown.
 *
 * The contact record and the deal record show different halves of the same
 * registry against the same two rows, so they read and write through the same
 * endpoint. Keeping the fetching here means the two screens cannot drift into
 * disagreeing about what saving means — which is the whole reason the field list
 * is data in the first place.
 */
export function useIntake(clientId: string | null, fixedDealId?: string | null) {
  const [loading, setLoading] = useState(true);
  const [values, setValues] = useState<IntakeValues>({});
  const [refs, setRefs] = useState<IntakeRefs | null>(null);
  const [documents, setDocuments] = useState<IntakeDoc[]>([]);
  const [deals, setDeals] = useState<DealOption[]>([]);
  const [dealId, setDealId] = useState<string | null>(fixedDealId ?? null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (deal?: string | null) => {
      if (!clientId) {
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const want = deal ?? fixedDealId ?? null;
        const res = await fetch(
          `/api/customers/${clientId}/intake${want ? `?deal=${want}` : ''}`
        );
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          setError(json?.error ?? `Could not load the record (${res.status}).`);
          return;
        }
        setValues(json.values ?? {});
        setRefs(json.refs ?? null);
        setDocuments(json.documents ?? []);
        setDeals(json.deals ?? []);
        setDealId(json.dealId ?? null);
        setDirty(false);
      } finally {
        setLoading(false);
      }
    },
    [clientId, fixedDealId]
  );

  useEffect(() => {
    void load();
  }, [load]);

  function change(field: IntakeField, value: unknown) {
    setValues((v) => ({ ...v, [field.name]: value }));
    setDirty(true);
    setNotice(null);
  }

  async function save(onSaved?: () => void) {
    if (!clientId) return;
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
      onSaved?.();
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

  return {
    loading, values, refs, documents, deals, dealId, dirty, busy, error, notice,
    setDealId, load, change, save, upload, removeDoc,
  };
}
