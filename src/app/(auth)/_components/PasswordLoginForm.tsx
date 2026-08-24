'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { PasswordInput } from '@/app/_components/PasswordInput';
import type { DoorId } from '@/lib/auth/roles';

/**
 * Email + password, identical on all three doors (§5, §9).
 *
 * The server decides the destination from the account's role, never from which
 * page this form was posted from. Right credentials on the wrong page therefore
 * do not fail: they come back with a redirect and a one-line note saying where
 * the user is being taken (§5).
 *
 * §8: the error is in an aria-live region and named by the fields through
 * aria-describedby, so a screen reader hears it and knows what it belongs to
 * rather than a colour changing silently.
 */
export function PasswordLoginForm({ door, next }: { door: DoorId; next?: string }) {
  const router = useRouter();
  const errorId = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
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
        if (json.note) {
          // Long enough to read one short line, then gone. The alternative — a
          // banner on the far side — would need every landing surface to know
          // about sign-in, for a message that matters for two seconds.
          setNote(json.note);
          setTimeout(() => {
            router.replace(json.redirect);
            router.refresh();
          }, 1100);
          return;
        }
        router.replace(json.redirect);
        router.refresh();
        return;
      }

      setError(
        json?.error ??
          `Server error (${res.status}) — the site may not be connected to its database yet. Open /api/health for diagnostics.`
      );
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  if (note) {
    return (
      <p className="notice ok" role="status">
        {note}
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {/* Always present, so a screen reader announces the message when it
          arrives rather than only on the next focus change. */}
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
      <PasswordInput
        label="Password"
        name="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={setPassword}
        describedBy={error ? errorId : undefined}
        invalid={Boolean(error)}
      />
      <button className="btn" type="submit" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
