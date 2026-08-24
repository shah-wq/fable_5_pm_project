import { redirect } from 'next/navigation';
import { roleToLandingRoute } from '@/lib/auth/roles';
import { getSession } from '@/lib/auth/session';
import { isAppShell } from '@/lib/native/shell';
import { SignInScreen } from '../_components/SignInScreen';

const ERRORS: Record<string, string> = {
  account_disabled: 'This account has been disabled. Contact your administrator.',
};

/**
 * The entry point (§2): one URL, three doors.
 *
 * The staff form stays primary because staff sign in most often and know this
 * page — but the dealer and homeowner routes are now buttons of the same width
 * below it rather than small grey links, because those two audiences outnumber
 * staff many times over in daily sign-ins. SignInScreen shows every door except
 * the one being looked at, so this page needs no list of them.
 *
 * Which surface anyone lands on is still decided by their role after
 * authentication, never by the page they used. See roleToLandingRoute().
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const session = await getSession();
  // §5: "visiting any sign-in page with a valid session redirects straight to
  // that role's surface". Signing in twice is nobody's intention.
  if (session?.isActive) redirect(roleToLandingRoute(session.role));

  // §6: the store app is a homeowner product. It shows one door, and its login
  // screen does not hint that the other two exist.
  if (await isAppShell()) redirect('/login/homeowner');

  const { next, error } = await searchParams;
  return (
    <SignInScreen
      door="staff"
      heading="Sign in"
      sub="Staff access — admins, project managers, designers, finance."
      next={next}
      error={error ? ERRORS[error] : undefined}
    />
  );
}
