import { redirect } from 'next/navigation';
import { roleToLandingRoute } from '@/lib/auth/roles';
import { getSession } from '@/lib/auth/session';
import { isAppShell } from '@/lib/native/shell';
import { SignInScreen } from '../../_components/SignInScreen';

/**
 * The homeowner's door (§4) — and the only door the store app shows (§6).
 *
 * The first-time line earns its place: the single most common homeowner
 * confusion is arriving here before setting a password, because their project
 * manager created the account and the welcome email is the thing they have not
 * opened yet. Answering it on the page is cheaper than answering it on the
 * phone.
 */
export default async function HomeownerLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await getSession();
  if (session?.isActive) redirect(roleToLandingRoute(session.role));

  const { next } = await searchParams;
  // §6: inside the app there is no role choice at all — no staff form, no dealer
  // button, no divider, and not even a link to the other doors. It is a
  // homeowner product and its login screen should not suggest otherwise.
  const inApp = await isAppShell();

  return (
    <SignInScreen
      door="customer"
      heading="Homeowner sign-in"
      sub="Check your solar project’s progress, documents and messages."
      next={next}
      aside={
        <span>
          First time here? Use the link in your welcome email to set your password.
        </span>
      }
      altDoors={inApp ? [] : ['staff', 'dealer']}
    />
  );
}
