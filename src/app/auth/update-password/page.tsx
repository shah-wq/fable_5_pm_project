import { BrandPanel, InlineLogo } from '@/app/(auth)/_components/AuthUi';
import { UpdatePasswordForm } from './UpdatePasswordForm';

/**
 * Where invite-accept and password-recovery links land after the callback
 * exchanged their code for a session. First-time invitees set their initial
 * password here; recoveries set a new one.
 */
export default function UpdatePasswordPage() {
  return (
    <div className="auth-shell">
      <BrandPanel />
      <main className="auth-main">
        <div className="auth-card">
          <InlineLogo />
          <h1>Set your password</h1>
          <p className="sub">Choose a password to finish signing in.</p>
          <UpdatePasswordForm />
        </div>
      </main>
    </div>
  );
}
