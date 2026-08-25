'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Closing a follow-up (§5): "The task must be closed with a resolution note."
 *
 * The note is the whole point — it is what turns a rating system into an
 * improvement system, and it is what somebody reads in three months when the
 * same complaint arrives about the same stage. So the button opens a box rather
 * than closing the task, and the database refuses an empty note even if this
 * form is bypassed.
 */
export function ResolveTask({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button className="btn small" type="button" onClick={() => setOpen(true)}>
        Close this
      </button>
    );
  }

  return (
    <div className="task-resolve">
      {error && <p className="notice error">{error}</p>}
      <label className="field">
        <span>What did you do?</span>
        <textarea
          rows={2}
          value={note}
          autoFocus
          placeholder="Called, re-booked for Tuesday, apologised for the silence."
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <div className="task-actions">
        <button
          className="btn small"
          type="button"
          disabled={busy || note.trim().length < 3}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const res = await fetch(`/api/tasks/${taskId}/resolve`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ note: note.trim() }),
              });
              if (!res.ok) {
                const json = await res.json().catch(() => null);
                setError(json?.error ?? `Could not close it (${res.status}).`);
                return;
              }
              router.refresh();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Closing…' : 'Close'}
        </button>
        <button className="btn secondary small" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
