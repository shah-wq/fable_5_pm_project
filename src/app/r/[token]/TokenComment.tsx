'use client';

import { useState } from 'react';

/**
 * The optional detail on the emailed landing page (§2, §3).
 *
 * The same two questions as the in-app sheet's second step, on a page reached
 * with no session — so it posts the token rather than relying on a cookie. The
 * score is already saved by the time this renders; nothing here is required, and
 * saying so is what makes it likely to be answered.
 */
export function TokenComment({
  token,
  chips,
}: {
  token: string;
  chips: Array<{ key: string; label: string }>;
}) {
  const [tags, setTags] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <p className="notice ok" role="status">
        Thank you — that has gone to your project manager.
      </p>
    );
  }

  return (
    <section className="rate-detail">
      <h2>What let you down?</h2>
      <p className="dim">Tap anything that applies. Nothing here is required.</p>
      <div className="rate-chips">
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`toggle-chip${tags.includes(c.key) ? ' on' : ''}`}
            aria-pressed={tags.includes(c.key)}
            onClick={() =>
              setTags((t) => (t.includes(c.key) ? t.filter((x) => x !== c.key) : [...t, c.key]))
            }
          >
            {c.label}
          </button>
        ))}
      </div>
      <label className="field">
        <span>Anything else?</span>
        <textarea rows={4} value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>
      <button
        className="btn"
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await fetch('/api/r/detail', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ token, tags, comment: comment.trim() || null }),
            });
            setDone(true);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Sending…' : 'Send'}
      </button>
    </section>
  );
}
