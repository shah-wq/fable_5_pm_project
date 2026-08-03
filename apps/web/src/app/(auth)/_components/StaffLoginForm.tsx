'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  LOGIN_DOORS,
  ROLE_HOME,
  doorForRole,
  sanitizeNextPath,
  type DoorId,
} from '@/lib/auth/roles';
import { createClient } from '@/lib/supabase/client';
import { Notice } from './AuthUi';

/**
 * Email + password form used by both password doors (staff and dealer).
 * The destination is decided by profiles.role AFTER authentication — never by
 * which door was used. A right-credentials/wrong-door sign-in is immediately
 * signed out again and pointed at the correct door.
 */
export function StaffLoginForm({ door, next }: { door: DoorId; next?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<React.ReactNode>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const supabase = createClient();

    try {
      const { data: auth, error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (signInError || !auth.user) {
        setError('Invalid email or password.');
        return;
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('role, is_active')
        .eq('id', auth.user.id)
        .single();

      if (!profile || !profile.is_active) {
        await supabase.auth.signOut();
        setError('This account has been deactivated. Contact your administrator.');
        return;
      }

      if (!LOGIN_DOORS[door].roles.includes(profile.role)) {
        const rightDoor = doorForRole(profile.role);
        await supabase.auth.signOut();
        setError(
          <>
            This account signs in at <a href={rightDoor.path}>{rightDoor.path}</a> (
            {rightDoor.label.toLowerCase()}).
          </>
        );
        return;
      }

      router.replace(sanitizeNextPath(next) ?? ROLE_HOME[profile.role]);
      router.refresh();
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
