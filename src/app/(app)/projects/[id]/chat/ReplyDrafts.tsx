'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface DraftItem {
  id: string;
  messageBody: string;
  messageAt: string;
  body: string;
  confidence: number;
  needsHuman: boolean;
  reason: string | null;
}

/**
 * The assistant's draft answer to the homeowner's last message, above the
 * thread. Send it as written, edit first, or dismiss. Sending posts as the
 * person pressing the button — the same as typing it.
 */
export function ReplyDrafts({
  items,
  recipientName,
}: {
  items: DraftItem[];
  recipientName: string | null;
}) {
  const router = useRouter();
  const [text, setText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(id: string, action: 'send' | 'dismiss') {
    setBusy(id);
    setError(null);
    const res = await fetch('/api/ai/drafts', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, action, body: text[id] }),
    });
    if (!res.ok) setError((await res.json().catch(() => null))?.error ?? `Failed (${res.status}).`);
    setBusy(null);
    router.refresh();
  }

  if (items.length === 0) return null;
  return (
    <section className="panel ai-panel drafts">
      {error && <p className="notice error">{error}</p>}
      {items.map((d) => (
        <div key={d.id} className="draft">
          <p className="dim small">
            Suggested reply to “{d.messageBody.slice(0, 140)}
            {d.messageBody.length > 140 ? '…' : ''}” · {Math.round(d.confidence * 100)}% confident
            {d.needsHuman && (
              <span className="ctx-warn"> needs you{d.reason ? `: ${d.reason}` : ''}</span>
            )}
          </p>
          <textarea
            className="draft-text"
            rows={4}
            value={text[d.id] ?? d.body}
            onChange={(e) => setText((t) => ({ ...t, [d.id]: e.target.value }))}
          />
          <div className="draft-actions">
            <button
              className="btn"
              type="button"
              disabled={busy !== null}
              onClick={() => act(d.id, 'send')}
            >
              Send to {recipientName ?? 'the customer'}
            </button>
            <button
              className="btn secondary"
              type="button"
              disabled={busy !== null}
              onClick={() => act(d.id, 'dismiss')}
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
