'use client';

import { useState } from 'react';

export interface SuggestionItem {
  id: string;
  projectId: string;
  documentId: string | null;
  documentTitle: string | null;
  category: string | null;
  stage: string;
  field: string;
  label: string;
  value: unknown;
  display: string;
  confidence: number;
  evidence: string | null;
  status: string;
}

/**
 * The document reader's proposals as a table with Accept / Reject on each row
 * and one button for all of them. Used on the stage form (for that stage) and
 * on the exceptions queue (per document). Accept writes the value to the form
 * through the same route the form uses; the row then disappears.
 */
export function SuggestionRows({
  items,
  onChanged,
  compact = false,
}: {
  items: SuggestionItem[];
  onChanged: () => void | Promise<void>;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(id: string, accept: boolean) {
    setBusy(id);
    setError(null);
    const res = await fetch('/api/ai/suggestions', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, accept }),
    });
    if (!res.ok) setError((await res.json().catch(() => null))?.error ?? `Failed (${res.status}).`);
    setBusy(null);
    await onChanged();
  }

  async function all(accept: boolean) {
    setBusy('all');
    setError(null);
    for (const it of items) {
      const res = await fetch('/api/ai/suggestions', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: it.id, accept }),
      });
      if (!res.ok) {
        setError((await res.json().catch(() => null))?.error ?? `Failed (${res.status}).`);
        break;
      }
    }
    setBusy(null);
    await onChanged();
  }

  if (items.length === 0) return null;
  return (
    <div className={`suggestions${compact ? ' compact' : ''}`}>
      {error && <p className="notice error">{error}</p>}
      <table className="rules-table suggestions-table">
        <thead>
          <tr>
            <th>Field</th>
            <th>Suggested value</th>
            <th>From</th>
            <th className="num">Confidence</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.id} className={s.confidence < 0.7 ? 'low' : ''}>
              <td>
                <strong>{s.label}</strong>
                {!compact && s.documentTitle && <div className="dim small">{s.documentTitle}</div>}
              </td>
              <td>
                <code className="suggested">{s.display}</code>
              </td>
              <td className="dim small evidence">{s.evidence ? `“${s.evidence}”` : '—'}</td>
              <td className="num">{Math.round(s.confidence * 100)}%</td>
              <td className="suggestion-actions">
                <button
                  className="btn"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => decide(s.id, true)}
                  aria-label={`Accept ${s.label}`}
                >
                  Accept
                </button>
                <button
                  className="btn secondary"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => decide(s.id, false)}
                  aria-label={`Reject ${s.label}`}
                >
                  Reject
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length > 1 && (
        <div className="suggestions-all">
          <button className="btn" type="button" disabled={busy !== null} onClick={() => all(true)}>
            Accept all {items.length}
          </button>
          <button
            className="btn secondary"
            type="button"
            disabled={busy !== null}
            onClick={() => all(false)}
          >
            Reject all
          </button>
        </div>
      )}
    </div>
  );
}
