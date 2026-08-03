'use client';

import { useState } from 'react';
import { Notice } from './AuthUi';

export function ResetForm() {
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
        body: JSON.stringify({ email }),
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
      {error && <Notice kind="error">{error}</Notice>}
      <label className="field">
        <span>Email</span>
        <input
          type="email"
          name="email"
          autoComplete="email"
          required
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
