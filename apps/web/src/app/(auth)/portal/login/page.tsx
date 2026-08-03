import Link from 'next/link';
import { CustomerOtpForm } from '../../_components/CustomerOtpForm';

/** Homeowner door: email OTP, no passwords, no self-signup. */
export default async function PortalLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return (
    <>
      <h1>Homeowner sign in</h1>
      <p className="sub">
        We&apos;ll email you a 6-digit code — no password to remember.
      </p>
      <CustomerOtpForm next={next} />
      <div className="auth-links">
        <span>
          Installer staff? <Link href="/login">Sign in here</Link> · Dealer?{' '}
          <Link href="/dealers/login">Sign in here</Link>
        </span>
      </div>
    </>
  );
}
