'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function MarkAllRead() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn secondary"
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch('/api/notifications', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ all: true }),
        }).catch(() => undefined);
        setBusy(false);
        router.refresh();
      }}
    >
      Mark all read
    </button>
  );
}
