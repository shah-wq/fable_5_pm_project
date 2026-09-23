'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { SuggestionRows, type SuggestionItem } from '@/app/(app)/_components/SuggestionRows';

interface Item {
  id: string;
  project_id: string | null;
  project_code: string | null;
  project_name: string | null;
  customer_name: string | null;
  entity_type: string | null;
  entity_id: string | null;
  severity: string;
  status: string;
  summary: string;
  details: Record<string, unknown>;
  raised_by: string;
  assigned_name: string | null;
  pending_suggestions: number;
  created_at: string;
  suggestions: SuggestionItem[];
}

const SEVERITY: Record<string, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export function ExceptionsList() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/exceptions', { cache: 'no-store' });
    const j = await res.json().catch(() => null);
    if (!res.ok) {
      setError(j?.error ?? `Could not load (${res.status}).`);
      return;
    }
    setItems(j.items);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function setStatus(id: string, status: string) {
    setBusy(id);
    setError(null);
    const res = await fetch('/api/exceptions', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, status }),
    });
    if (!res.ok) setError((await res.json().catch(() => null))?.error ?? `Failed (${res.status}).`);
    setBusy(null);
    await load();
  }

  if (!items) return <p className="dim">{error ?? 'Loading…'}</p>;
  if (items.length === 0) {
    return (
      <section className="panel">
        <p className="dim">
          Nothing needs a decision. When the document reader is unsure, or a check fails, it lands
          here.
        </p>
      </section>
    );
  }

  return (
    <div className="exceptions">
      {error && <p className="notice error">{error}</p>}
      {items.map((it) => {
        const d = it.details ?? {};
        const issues = Array.isArray(d.issues) ? (d.issues as string[]) : [];
        const when = new Date(it.created_at).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
        return (
          <section key={it.id} className={`panel exception sev-${it.severity}`}>
            <header className="exception-head">
              <div>
                <span className={`chip sev-${it.severity}`}>
                  {SEVERITY[it.severity] ?? it.severity}
                </span>
                <span className="chip">
                  {it.raised_by === 'ai' ? 'Document reader' : it.raised_by}
                </span>
                {it.project_id && (
                  <Link className="exception-project" href={`/projects/${it.project_id}`}>
                    {it.project_code}
                    {it.customer_name ? ` · ${it.customer_name}` : ''}
                  </Link>
                )}
                <span className="dim small"> · {when}</span>
                {it.assigned_name && <span className="dim small"> · {it.assigned_name}</span>}
              </div>
              <div className="exception-actions">
                {it.status === 'open' && (
                  <button
                    className="btn secondary"
                    type="button"
                    disabled={busy === it.id}
                    onClick={() => setStatus(it.id, 'acknowledged')}
                  >
                    Acknowledge
                  </button>
                )}
                <button
                  className="btn secondary"
                  type="button"
                  disabled={busy === it.id}
                  onClick={() => setStatus(it.id, 'dismissed')}
                >
                  Dismiss
                </button>
                <button
                  className="btn"
                  type="button"
                  disabled={busy === it.id}
                  onClick={() => setStatus(it.id, 'resolved')}
                >
                  Resolve
                </button>
              </div>
            </header>
            <h2 className="exception-summary">{it.summary}</h2>
            {typeof d.summary === 'string' && d.summary && (
              <p className="exception-note">{d.summary}</p>
            )}
            {typeof d.document_id === 'string' && (
              <p className="dim small">
                <a href={`/api/files/${d.document_id}`} target="_blank" rel="noreferrer">
                  Open the document{typeof d.title === 'string' && d.title ? ` — ${d.title}` : ''}
                </a>
                {typeof d.document_type === 'string' && d.document_type
                  ? ` · read as: ${d.document_type}`
                  : ''}
              </p>
            )}
            {issues.length > 0 && (
              <ul className="exception-issues">
                {issues.map((i, n) => (
                  <li key={n}>{i}</li>
                ))}
              </ul>
            )}
            {it.suggestions.length > 0 && (
              <SuggestionRows items={it.suggestions} onChanged={load} />
            )}
          </section>
        );
      })}
    </div>
  );
}
