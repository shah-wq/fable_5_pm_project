'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { DoorId } from '@/lib/auth/roles';
import { Notice } from './AuthUi';

/**
 * Email + password form, used by all three doors — staff, dealer and homeowner.
 * POSTs to /api/auth/login; the server decides the destination from
 * profiles.role, never from which door was used. Right credentials at the wrong
 * door come back as a pointer to the correct one.
 */
export function PasswordLoginForm({ door, next }: { door: DoorId; next?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<React.ReactNode>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, door, next }),
      });
      const json = await res.json().catch(() => null);

      if (res.ok && json?.redirect) {
        router.replace(json.redirect);
        router.refresh();
        return;
      }

      if (json?.error === 'wrong_door' && json.doorPath) {
        setError(
          <>
            This account signs in at <a href={json.doorPath}>{json.doorPath}</a> (
            {String(json.doorLabel ?? '').toLowerCase()}).
          </>
        );
        return;
      }

      setError(
        json?.error ??
          `Server error (${res.status}) — the site may not be connected to its database yet. Open /api/health for diagnostics.`
      );
    } finally {
      setBusy(false);
    }
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
      <label className="field">
        <span>Password</span>
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <button className="btn" type="submit" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
