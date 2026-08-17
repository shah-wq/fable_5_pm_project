import Link from 'next/link';
import { ResetForm } from '../../_components/ResetForm';

/** Request a password-recovery email. Every door uses this one page. */
export default function ResetPage() {
  return (
    <>
      <h1>Reset your password</h1>
      <p className="sub">
        Enter your account email and we&apos;ll send a link to set a new password.
      </p>
      <ResetForm />
      <div className="auth-links">
        <Link href="/login">Staff sign-in</Link> · <Link href="/dealers/login">Dealer</Link> ·{' '}
        <Link href="/portal/login">Homeowner</Link>
      </div>
    </>
  );
}
