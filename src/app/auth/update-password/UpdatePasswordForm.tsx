'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ROLE_HOME } from '@/lib/auth/roles';
import { createClient } from '@/lib/supabase/client';
import { Notice } from '@/app/(auth)/_components/AuthUi';

export function UpdatePasswordForm() {
  const router = useRouter();
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => setHasSession(Boolean(data.user)));
  }, []);

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
    const supabase = createClient();
    try {
      const { data, error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError || !data.user) {
        setError(updateError?.message ?? 'Could not set the password. Try the link again.');
        return;
      }
      const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', data.user.id)
        .single();
      router.replace(profile ? ROLE_HOME[profile.role] : '/');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (hasSession === null) return null;

  if (!hasSession) {
    return (
      <Notice kind="error">
        This link is invalid or has expired. Request a new one from{' '}
        <Link href="/login/reset">the reset page</Link>, or ask your administrator to re-send the
        invitation.
      </Notice>
    );
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
