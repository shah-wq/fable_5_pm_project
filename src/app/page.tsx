import { redirect } from 'next/navigation';
import { LOGIN_DOORS, roleToLandingRoute } from '@/lib/auth/roles';
import { getSession } from '@/lib/auth/session';
import { isAppShell } from '@/lib/native/shell';

/** '/' is just a router: signed-in users go home, everyone else to /login. */
export default async function Index() {
  const session = await getSession();
  // In the store app, an unauthenticated visitor is a homeowner by definition,
  // so they get the customer door rather than the staff one.
  if (!session && (await isAppShell())) redirect(LOGIN_DOORS.customer.path);
  if (!session) redirect('/login');
  if (!session.isActive) redirect('/auth/signout?reason=deactivated');
  redirect(roleToLandingRoute(session.role));
}
