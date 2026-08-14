'use client';

import { useEffect, useState } from 'react';

interface MergeRecord {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  alternate_phone: string | null;
  mailing_address: string | null;
  preferred_contact: string | null;
  preferred_language: string | null;
  internal_notes: string | null;
  user_id: string | null;
  login_email: string | null;
  created_at: string;
  projects: number;
  documents: number;
  messages: number;
  leads: number;
}

const FIELD_LABELS: Record<string, string> = {
  first_name: 'First name',
  last_name: 'Last name',
  email: 'Email (portal login)',
  phone: 'Phone',
  alternate_phone: 'Alternate phone',
  mailing_address: 'Mailing address',
  preferred_contact: 'Preferred contact',
  preferred_language: 'Preferred language',
  internal_notes: 'Internal notes',
};

/**
 * Merge duplicates. The admin picks which record survives, then chooses field
 * by field which value to keep where they differ — shown side by side, not
 * guessed — and sees exactly what will move before anything happens.
 */
export function MergeDialog({
  ids,
  onClose,
  onMerged,
}: {
  ids: string[];
  onClose: () => void;
  onMerged: (summary: Record<string, number>) => void;
}) {
  const [records, setRecords] = useState<MergeRecord[] | null>(null);
  const [fieldKeys, setFieldKeys] = useState<string[]>([]);
  const [survivorId, setSurvivorId] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [keepLogin, setKeepLogin] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    fetch(`/api/customers/merge?ids=${ids.join(',')}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.error) {
          setError(j.error);
          return;
        }
        setRecords(j.records);
        setFieldKeys(j.fields ?? []);
        // Default survivor: the oldest record, which usually holds the history.
        const first = (j.records as MergeRecord[])[0];
        setSurvivorId(first?.id ?? null);
        setKeepLogin((j.records as MergeRecord[]).find((r) => r.user_id)?.user_id ?? null);
      })
      .catch(() => setError('Could not load those records.'));
  }, [ids]);

  const survivor = records?.find((r) => r.id === survivorId) ?? null;
  const losers = (records ?? []).filter((r) => r.id !== survivorId);

  const totals = (records ?? []).reduce(
    (acc, r) => ({
      projects: acc.projects + r.projects,
      documents: acc.documents + r.documents,
      messages: acc.messages + r.messages,
      leads: acc.leads + r.leads,
      logins: acc.logins + (r.user_id ? 1 : 0),
    }),
    { projects: 0, documents: 0, messages: 0, leads: 0, logins: 0 }
  );

  const value = (r: MergeRecord, key: string) => (r as unknown as Record<string, string | null>)[key];

  async function merge() {
    if (!survivorId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/customers/merge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          survivorId,
          mergeIds: losers.map((r) => r.id),
          fields: choices,
          keepLoginUserId: keepLogin,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? `Merge failed (${res.status}).`);
        return;
      }
      onMerged(json.summary ?? {});
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop">
      <div className="dialog wide-dialog" role="dialog" aria-modal>
        <h2>Merge {ids.length} customer records</h2>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}

        {!records ? (
          <p className="dim">Loading…</p>
        ) : (
          <>
            <h3>Which record survives?</h3>
            <div className="stage-scope">
              {records.map((r) => (
                <label className="check-inline" key={r.id}>
                  <input
                    type="radio"
                    name="survivor"
                    checked={survivorId === r.id}
                    onChange={() => {
                      setSurvivorId(r.id);
                      setChoices({});
                    }}
                  />
                  {r.first_name} {r.last_name}
                  <span className="dim">
                    {' '}· {r.email ?? 'no email'} · {r.projects} project(s) · created{' '}
                    {String(r.created_at).slice(0, 10)}
                  </span>
                </label>
              ))}
            </div>

            <h3>Where the records differ, keep…</h3>
            <table className="projects-table">
              <thead>
                <tr>
                  <th>Field</th>
                  {records.map((r) => (
                    <th key={r.id}>
                      {r.first_name} {r.last_name}
                      {r.id === survivorId ? ' (survivor)' : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {fieldKeys
                  .filter((key) => {
                    const values = records.map((r) => (value(r, key) ?? '').trim());
                    return new Set(values.filter(Boolean)).size > 1;
                  })
                  .map((key) => (
                    <tr key={key}>
                      <td>{FIELD_LABELS[key] ?? key}</td>
                      {records.map((r) => {
                        const v = (value(r, key) ?? '').trim();
                        const chosen = (choices[key] ?? (value(survivor!, key) ?? '').trim()) === v;
                        return (
                          <td key={r.id}>
                            {v ? (
                              <label className="check-inline">
                                <input
                                  type="radio"
                                  name={`field-${key}`}
                                  checked={chosen}
                                  onChange={() => setChoices((c) => ({ ...c, [key]: v }))}
                                />
                                {v}
                              </label>
                            ) : (
                              <span className="dim">—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                {fieldKeys.filter((key) => {
                  const values = records.map((r) => (value(r, key) ?? '').trim());
                  return new Set(values.filter(Boolean)).size > 1;
                }).length === 0 && (
                  <tr>
                    <td colSpan={records.length + 1} className="dim">
                      Nothing conflicts — the surviving record already has every value.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            {totals.logins > 1 && (
              <>
                <h3>Which login remains?</h3>
                <div className="stage-scope">
                  {records.filter((r) => r.user_id).map((r) => (
                    <label className="check-inline" key={r.user_id}>
                      <input
                        type="radio"
                        name="login"
                        checked={keepLogin === r.user_id}
                        onChange={() => setKeepLogin(r.user_id)}
                      />
                      {r.login_email ?? r.email ?? 'login'}
                    </label>
                  ))}
                </div>
                <p className="dim">
                  The other portal account is disabled, not deleted — a customer login is never
                  left pointing at nothing.
                </p>
              </>
            )}

            <div className="notice hold">
              <strong>What will move onto the surviving record:</strong>{' '}
              {totals.projects} project(s), {totals.documents} document(s), {totals.messages}{' '}
              message(s), {totals.leads} lead(s)
              {totals.logins > 0 ? `, ${totals.logins} portal account(s)` : ''}. Nothing is
              deleted — the merged records are archived, and the merge is logged with both
              originals so it can be reconstructed.
            </div>

            <label className="check-inline">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              I have checked the surviving values above
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
            disabled={busy || !records || !survivorId || !confirmed || losers.length === 0}
            onClick={merge}
          >
            {busy ? 'Merging…' : `Merge ${losers.length} into this record`}
          </button>
        </div>
      </div>
    </div>
  );
}
