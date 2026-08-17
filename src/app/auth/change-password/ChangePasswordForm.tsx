'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Notice } from '@/app/(auth)/_components/AuthUi';
import { PasswordInput } from '@/app/_components/PasswordInput';

function strength(pw: string): { label: string; score: number } {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  const label = score <= 1 ? 'weak' : score <= 3 ? 'okay' : 'strong';
  return { label, score };
}

export function ChangePasswordForm() {
  const router = useRouter();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const meter = strength(password);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Use at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ current, password }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.redirect) {
        router.replace(json.redirect);
        router.refresh();
        return;
      }
      setError(json?.error ?? 'Could not change the password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {error && <Notice kind="error">{error}</Notice>}
      <PasswordInput
        label="Current password"
        autoComplete="current-password"
        required
        value={current}
        onChange={setCurrent}
      />
      <PasswordInput
        label="New password"
        autoComplete="new-password"
        required
        minLength={8}
        value={password}
        onChange={setPassword}
      />
      {password && (
        <div className={`pw-meter s${meter.score}`}>
          <span style={{ width: `${(meter.score / 5) * 100}%` }} />
          <em>{meter.label}</em>
        </div>
      )}
      <PasswordInput
        label="Confirm new password"
        autoComplete="new-password"
        required
        value={confirm}
        onChange={setConfirm}
      />
      <button className="btn" type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Save new password'}
      </button>
    </form>
  );
}
