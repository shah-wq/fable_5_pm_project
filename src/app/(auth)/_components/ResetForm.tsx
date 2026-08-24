'use client';

import { useId, useState } from 'react';
import type { DoorId } from '@/lib/auth/roles';
import { Notice } from './AuthUi';

/**
 * Step one of the shared recovery flow (§7). The door is passed to the server so
 * the emailed link can bring the user back to the page they started from.
 */
export function ResetForm({ door = 'staff' }: { door?: DoorId }) {
  const errorId = useId();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // Always reports success for valid requests — no account oracle.
      const res = await fetch('/api/auth/recovery', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, door }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        setError(json?.error ?? 'Something went wrong. Try again.');
        return;
      }
      setSent(true);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <Notice kind="ok">
        If an account exists for <strong>{email}</strong>, a reset link is on its way. The link
        works once and expires in an hour.
      </Notice>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <div className="live-region" role="alert" aria-live="assertive">
        {error && (
          <p className="notice error" id={errorId}>
            {error}
          </p>
        )}
      </div>
      <label className="field">
        <span>Email</span>
        <input
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <button className="btn" type="submit" disabled={busy}>
        {busy ? 'Sending…' : 'Send reset link'}
      </button>
    </form>
  );
}
