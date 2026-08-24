import { permanentRedirect } from 'next/navigation';
import { LEGACY_LOGIN_PATHS } from '@/lib/auth/roles';

/**
 * The dealer door moved to /login/dealer (§9: the three doors hang off one entry
 * point). This path stays for ever, because it is in sent emails, in browser
 * histories and quite possibly written on a dealer's printed onboarding sheet —
 * and a dead sign-in link is the one broken link a user cannot work around.
 *
 * A permanent redirect, so anything that caches it learns the new address.
 */
export default function DealerLoginMoved() {
  permanentRedirect(LEGACY_LOGIN_PATHS['/dealers/login']);
}
