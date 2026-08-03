import { BrandPanel, InlineLogo } from '@/app/(auth)/_components/AuthUi';
import { UpdatePasswordForm } from './UpdatePasswordForm';

/**
 * Where invite and password-recovery links land. The one-time token in the
 * query string authorizes setting a password; first-time invitees set their
 * initial one here, recoveries set a new one.
 */
export default async function UpdatePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return (
    <div className="auth-shell">
      <BrandPanel />
      <main className="auth-main">
        <div className="auth-card">
          <InlineLogo />
          <h1>Set your password</h1>
          <p className="sub">Choose a password to finish signing in.</p>
          <UpdatePasswordForm token={token} />
        </div>
      </main>
    </div>
  );
}
