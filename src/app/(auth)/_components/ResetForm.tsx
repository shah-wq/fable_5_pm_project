'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Notice } from './AuthUi';

export function ResetForm() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const supabase = createClient();
    try {
      // Always report success — a reset form must not be an account oracle.
      await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(
          '/auth/update-password'
        )}`,
      });
      setSent(true);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <Notice kind="ok">
        If an account exists for <strong>{email}</strong>, a reset link is on its way. The link
        expires after one use.
      </Notice>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate>
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
