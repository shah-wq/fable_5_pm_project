import { permanentRedirect } from 'next/navigation';
import { LEGACY_LOGIN_PATHS } from '@/lib/auth/roles';

/**
 * The homeowner door moved to /login/homeowner. This path stays: every
 * invitation email sent before the move points here, and the installed app's
 * cached start URL may too.
 */
export default function PortalLoginMoved() {
  permanentRedirect(LEGACY_LOGIN_PATHS['/portal/login']);
}
