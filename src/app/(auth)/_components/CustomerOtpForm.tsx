'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Notice } from './AuthUi';

/**
 * Homeowner sign-in: 6-digit emailed code, no passwords. Codes are only
 * issued for existing, active customer accounts — this form can never mint
 * an account, and it never learns whether one exists.
 */
export function CustomerOtpForm({ next }: { next?: string }) {
  const router = useRouter();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/auth/otp/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        setError(json?.error ?? 'Something went wrong. Try again.');
        return;
      }
      setStep('code');
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/auth/otp/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, code, next }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.redirect) {
        router.replace(json.redirect);
        router.refresh();
        return;
      }
      setError(json?.error ?? 'That code is incorrect or expired. Request a new one.');
    } finally {
      setBusy(false);
    }
  }

  if (step === 'email') {
    return (
      <form onSubmit={requestCode} noValidate>
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
          {busy ? 'Sending…' : 'Email me a sign-in code'}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={verifyCode} noValidate>
      <Notice kind="ok">
        If an account exists for <strong>{email}</strong>, a 6-digit code is on its way.
      </Notice>
      {error && <Notice kind="error">{error}</Notice>}
      <label className="field">
        <span>Sign-in code</span>
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </label>
      <button className="btn" type="submit" disabled={busy}>
        {busy ? 'Checking…' : 'Sign in'}
      </button>
      <div className="auth-links">
        <button className="btn secondary" type="button" onClick={() => setStep('email')}>
          Use a different email
        </button>
      </div>
    </form>
  );
}
