'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Notice } from '@/app/(auth)/_components/AuthUi';
import { PasswordInput } from '@/app/_components/PasswordInput';

/**
 * Finishes an invite or a password recovery. The one-time token arrives in
 * the link's query string; setting the password consumes it, revokes any
 * other sessions, and signs the user in.
 */
export function UpdatePasswordForm({ token, from }: { token?: string; from?: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);

  // §7: "expired links offer to send a new one rather than dead-ending". A link
  // that has been used, or has passed its hour, is the most common way somebody
  // arrives here — links get clicked twice, and forwarded emails get read late.
  if (!token || expired) {
    return <ExpiredLink from={from} />;
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
      // 410: the token was already spent or has passed its hour. That is not an
      // error the user can fix by retyping, so offer them a new link instead of
      // repeating the message above a form that cannot work.
      if (res.status === 410) {
        setExpired(true);
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
      <PasswordInput
        label="New password"
        autoComplete="new-password"
        required
        minLength={10}
        value={password}
        onChange={setPassword}
      />
      <PasswordInput
        label="Confirm password"
        autoComplete="new-password"
        required
        value={confirm}
        onChange={setConfirm}
      />
      <button className="btn" type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Save and continue'}
      </button>
    </form>
  );
}

/**
 * A used or expired link, answered with the next step rather than a full stop
 * (§7). The reset page is pre-set to the door the link came from, so a homeowner
 * is not sent to a page headed 'Staff access' to fix a homeowner problem.
 */
function ExpiredLink({ from }: { from?: string }) {
  const resetHref = from ? `/login/reset?from=${encodeURIComponent(from)}` : '/login/reset';
  return (
    <>
      <Notice kind="error">
        This link has expired or has already been used. Links work once and last an hour.
      </Notice>
      <p className="sub">
        Ask for a new one — it takes a moment, and the new link arrives at the same address.
      </p>
      <Link className="btn" href={resetHref}>
        Send me a new link
      </Link>
      <div className="auth-links">
        <span>
          Waiting on an invitation instead? Ask your administrator to re-send it — invitation links
          last seven days.
        </span>
      </div>
    </>
  );
}
