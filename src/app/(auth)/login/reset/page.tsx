import Link from 'next/link';
import { ResetForm } from '../../_components/ResetForm';

/** Request a password-recovery email (staff and dealer accounts). */
export default function ResetPage() {
  return (
    <>
      <h1>Reset your password</h1>
      <p className="sub">
        Enter your account email and we&apos;ll send a link to set a new password.
      </p>
      <ResetForm />
      <div className="auth-links">
        <Link href="/login">Back to sign in</Link>
      </div>
    </>
  );
}
