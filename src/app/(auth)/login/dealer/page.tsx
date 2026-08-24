import { redirect } from 'next/navigation';
import { roleToLandingRoute } from '@/lib/auth/roles';
import { getSession } from '@/lib/auth/session';
import { SignInScreen } from '../../_components/SignInScreen';

/**
 * The dealer's own door (§4). Its own URL so it can go straight into a dealer
 * onboarding pack or an email footer — a dealer who has that link never sees the
 * staff page at all, which is the real fix for §1's complaint.
 */
export default async function DealerLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await getSession();
  if (session?.isActive) redirect(roleToLandingRoute(session.role));

  const { next } = await searchParams;
  return (
    <SignInScreen
      door="dealer"
      heading="Dealer sign-in"
      sub="Track the projects you sold, submit leads and view commissions."
      next={next}
      // §4: no self-registration, and no Sign-up link that would imply one.
      // Dealer accounts are created by an admin, so the only useful thing to say
      // is who to ask.
      aside={<span>Need access? Contact your account manager.</span>}
      altDoors={['staff', 'homeowner']}
    />
  );
}
