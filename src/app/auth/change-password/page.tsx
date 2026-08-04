import { redirect } from 'next/navigation';
import { BrandPanel, InlineLogo } from '@/app/(auth)/_components/AuthUi';
import { getSession } from '@/lib/auth/session';
import { ChangePasswordForm } from './ChangePasswordForm';

export const dynamic = 'force-dynamic';

/**
 * Change your own password (any role): current + new + confirm. Also where
 * admin-created accounts land on first login when "force password change"
 * is on — they can't proceed anywhere else until they set their own.
 */
export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ forced?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const { forced } = await searchParams;

  return (
    <div className="auth-shell">
      <BrandPanel />
      <main className="auth-main">
        <div className="auth-card">
          <InlineLogo />
          <h1>{forced ? 'Set your own password' : 'Change password'}</h1>
          <p className="sub">
            {forced
              ? 'Your account was created with a temporary password. Choose your own to continue.'
              : 'Enter your current password and pick a new one.'}
          </p>
          <ChangePasswordForm />
        </div>
      </main>
    </div>
  );
}
