import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ROLE_HOME } from '@/lib/auth/roles';
import { getSession } from '@/lib/auth/session';
import { StaffLoginForm } from '../../_components/StaffLoginForm';

/** Dealer door. Same password form; only the 'dealer' role may pass. */
export default async function DealerLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await getSession();
  if (session?.isActive) redirect(ROLE_HOME[session.role]);

  const { next } = await searchParams;
  return (
    <>
      <h1>Dealer sign in</h1>
      <p className="sub">Track every project in your book, from intake to PTO.</p>
      <StaffLoginForm door="dealer" next={next} />
      <div className="auth-links">
        <Link href="/login/reset">Forgot your password?</Link>
        <span>
          Staff? <Link href="/login">Sign in here</Link> · Homeowner?{' '}
          <Link href="/portal/login">Sign in here</Link>
        </span>
      </div>
    </>
  );
}
