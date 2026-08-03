import Link from 'next/link';
import { Notice } from '../_components/AuthUi';
import { StaffLoginForm } from '../_components/StaffLoginForm';

const ERRORS: Record<string, string> = {
  account_disabled: 'This account has been deactivated. Contact your administrator.',
  auth_callback: 'That sign-in link is invalid or has expired.',
};

/** Staff door: admin, PM (ops), designer, finance — one page, destination
 *  decided by profiles.role after authentication. */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  return (
    <>
      <h1>Sign in</h1>
      <p className="sub">Staff access — admins, project managers, designers, finance.</p>
      {error && ERRORS[error] && <Notice kind="error">{ERRORS[error]}</Notice>}
      <StaffLoginForm door="staff" next={next} />
      <div className="auth-links">
        <Link href="/login/reset">Forgot your password?</Link>
        <span>
          Dealer? <Link href="/dealers/login">Sign in here</Link> · Homeowner?{' '}
          <Link href="/portal/login">Sign in here</Link>
        </span>
      </div>
    </>
  );
}
