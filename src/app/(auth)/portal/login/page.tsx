import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ROLE_HOME } from '@/lib/auth/roles';
import { getSession } from '@/lib/auth/session';
import { PasswordLoginForm } from '../../_components/PasswordLoginForm';

/**
 * Homeowner door: email and password, the same as every other door.
 *
 * This used to be a one-time emailed code. It was the wrong call for the actual
 * user: someone opening this once a week wants the password their phone's
 * keychain already filled in, not a trip to their inbox every time — and in an
 * installed app, leaving to fetch a code and coming back is worse still.
 *
 * There is no self-signup. A homeowner's login is created by their project
 * manager, either as an invitation they complete themselves or with a password
 * an admin sets for them.
 */
export default async function PortalLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await getSession();
  if (session?.isActive) redirect(ROLE_HOME[session.role]);

  const { next } = await searchParams;
  return (
    <>
      <h1>Homeowner sign in</h1>
      <p className="sub">Follow your solar installation — where it stands and what happens next.</p>
      <PasswordLoginForm door="customer" next={next} />
      <div className="auth-links">
        <Link href="/login/reset">Forgot your password?</Link>
        <span>
          No account yet? Your project manager sets it up — ask them to send you an invitation.
        </span>
        <span>
          Installer staff? <Link href="/login">Sign in here</Link> · Dealer?{' '}
          <Link href="/dealers/login">Sign in here</Link>
        </span>
      </div>
    </>
  );
}
