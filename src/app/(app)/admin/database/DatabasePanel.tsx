'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface AppliedFile {
  file: string;
  ok: boolean;
  error?: string;
  ms: number;
}

/**
 * The button that replaces the clipboard.
 *
 * It shows what this database is missing, applies it through the application's
 * own connection when asked, and prints exactly what PostgreSQL said about each
 * file — including the refusal, verbatim, when there is one. That last part is
 * the whole reason this exists: the hosted console this replaces would take a
 * paste, do nothing, and say nothing.
 */
export function DatabasePanel({
  behind,
  applied,
}: {
  behind: string[];
  applied: Record<string, boolean>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ applied: AppliedFile[]; behind: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function apply() {
    if (!window.confirm(
      `Apply ${behind.length} migration${behind.length === 1 ? '' : 's'} to this database now?\n\n` +
      `Each file runs as its own transaction and is safe to run again. ` +
      `The page will tell you exactly what happened to each one.`
    )) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/admin/migrations', { method: 'POST' });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? `The request failed (${res.status}).`);
        return;
      }
      setResult(json);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const pretty = (file: string) => file.replace(/\.sql$/, '').replace(/^(\d{8})(\d{6})_/, '$2 · ');

  return (
    <>
      {behind.length === 0 ? (
        <p className="notice ok">
          Up to date. Every migration this deployment carries is present in the database.
        </p>
      ) : (
        <div className="notice hold">
          <strong>
            {behind.length} migration{behind.length === 1 ? ' is' : 's are'} missing from this database.
          </strong>
          <ul>
            {behind.map((f) => (
              <li key={f}>
                <code>{pretty(f)}</code>
              </li>
            ))}
          </ul>
          <button className="btn" type="button" disabled={busy} onClick={() => void apply()}>
            {busy ? 'Applying…' : `Apply ${behind.length === 1 ? 'it' : 'them'} now`}
          </button>
          <p className="dim">
            Runs the files bundled with this deployment, in order, through the same connection
            every page uses. Nothing is pasted anywhere. If one is refused, the reason appears
            here, word for word.
          </p>
        </div>
      )}

      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      {result && (
        <section className="panel">
          <h3>What happened</h3>
          <ul className="gap-list">
            {result.applied.map((a) => (
              <li key={a.file}>
                {a.ok ? (
                  <>
                    <span className="done-badge">✓</span> <code>{pretty(a.file)}</code>
                    <span className="dim">{` · ${a.ms} ms`}</span>
                  </>
                ) : (
                  <>
                    <span className="missing-badge">✕</span> <code>{pretty(a.file)}</code>
                    <p className="notice error">{a.error}</p>
                  </>
                )}
              </li>
            ))}
          </ul>
          {result.behind.length === 0 ? (
            <p className="notice ok">Done — the database is up to date. Reload any screen that was waiting.</p>
          ) : (
            <p className="dim">
              {`Still missing: ${result.behind.map(pretty).join(', ')}. Fix what the error names, or send it on, then click again — every file is safe to re-run.`}
            </p>
          )}
        </section>
      )}

      <details className="track-card">
        <summary>
          <span className="track-title">Every migration this deployment knows about</span>
        </summary>
        <div className="track-body wide-body">
          <ul className="gap-list">
            {Object.entries(applied).map(([file, present]) => (
              <li key={file}>
                {present ? <span className="done-badge">✓</span> : <span className="missing-badge">✕</span>}{' '}
                <code>{pretty(file)}</code>
              </li>
            ))}
          </ul>
        </div>
      </details>
    </>
  );
}
