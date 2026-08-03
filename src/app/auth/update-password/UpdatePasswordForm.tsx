'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Notice } from '@/app/(auth)/_components/AuthUi';

/**
 * Finishes an invite or a password recovery. The one-time token arrives in
 * the link's query string; setting the password consumes it, revokes any
 * other sessions, and signs the user in.
 */
export function UpdatePasswordForm({ token }: { token?: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!token) {
    return (
      <Notice kind="error">
        This link is invalid or has expired. Request a new one from{' '}
        <Link href="/login/reset">the reset page</Link>, or ask your administrator to re-send the
        invitation.
      </Notice>
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 10) {
      setError('Use at least 10 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.redirect) {
        router.replace(json.redirect);
        router.refresh();
        return;
      }
      setError(json?.error ?? 'Could not set the password. Try the link again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {error && <Notice kind="error">{error}</Notice>}
      <label className="field">
        <span>New password</span>
        <input
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <label className="field">
        <span>Confirm password</span>
        <input
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </label>
      <button className="btn" type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Save and continue'}
      </button>
    </form>
  );
}
