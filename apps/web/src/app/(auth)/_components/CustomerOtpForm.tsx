'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ROLE_HOME, doorForRole, sanitizeNextPath } from '@/lib/auth/roles';
import { createClient } from '@/lib/supabase/client';
import { Notice } from './AuthUi';

/**
 * Homeowner sign-in: 6-digit email code, no passwords. `shouldCreateUser:
 * false` means this form can never mint an account — customers exist only
 * because a project (or converted lead) invited them.
 */
export function CustomerOtpForm({ next }: { next?: string }) {
  const router = useRouter();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<React.ReactNode>(null);
  const [busy, setBusy] = useState(false);

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const supabase = createClient();
    try {
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false },
      });
      if (otpError) {
        setError(
          'We could not find an account for that email. Your installer sends the invitation — check with them if you expected access.'
        );
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
    const supabase = createClient();
    try {
      const { data: auth, error: verifyError } = await supabase.auth.verifyOtp({
        email,
        token: code,
        type: 'email',
      });
      if (verifyError || !auth.user) {
        setError('That code is incorrect or expired. Request a new one.');
        return;
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('role, is_active')
        .eq('id', auth.user.id)
        .single();

      if (!profile || !profile.is_active) {
        await supabase.auth.signOut();
        setError('This account has been deactivated. Contact your installer.');
        return;
      }

      if (profile.role !== 'customer') {
        const rightDoor = doorForRole(profile.role);
        await supabase.auth.signOut();
        setError(
          <>
            This is the homeowner door. Your account signs in at{' '}
            <a href={rightDoor.path}>{rightDoor.path}</a>.
          </>
        );
        return;
      }

      router.replace(sanitizeNextPath(next) ?? ROLE_HOME.customer);
      router.refresh();
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
        We sent a 6-digit code to <strong>{email}</strong>.
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
