'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * 'Mark as needs reply' (spec §5). A PM flags a thread to come back to and it
 * stays in the inbox's attention list until answered — answering clears it
 * automatically, which is why there is no 'done' button here.
 */
export function FlagButton({ projectId, flagged }: { projectId: string; flagged: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(flagged);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    const next = !on;
    try {
      const res = await fetch(`/api/chat/${projectId}/flag`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ flagged: next }),
      });
      if (res.ok) {
        setOn(next);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      className={`toggle-chip${on ? ' on' : ''}`}
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={on}
    >
      {on ? 'Needs reply ✓' : 'Mark as needs reply'}
    </button>
  );
}
