'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * The green button at the bottom of every stage form. Disabled until the
 * requirements list is empty; the missing items are listed in red under it.
 * Posts to the same /move endpoint as the Kanban drag — one validation path.
 */
export function AdvanceButton({
  projectId,
  label,
  missing,
  canMove,
}: {
  projectId: string;
  label: string;
  missing: string[];
  canMove: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [serverMissing, setServerMissing] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const blockers = serverMissing ?? missing;

  async function advance() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/move`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ direction: 'forward', via: 'button' }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok) {
        router.push(`/projects/${projectId}`);
        router.refresh();
        return;
      }
      if (json?.missing?.length) setServerMissing(json.missing);
      setError(json?.error ?? 'Move failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        className="btn advance"
        type="button"
        disabled={!canMove || busy || blockers.length > 0}
        onClick={advance}
      >
        {busy ? 'Moving…' : `■ ${label}`}
      </button>
      {!canMove && <p className="dim">Only the PM or an admin can move projects.</p>}
      {error && blockers.length === 0 && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {blockers.length > 0 && (
        <ul className="gap-list under-button">
          {blockers.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
