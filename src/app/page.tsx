import { redirect } from 'next/navigation';
import { ROLE_HOME } from '@/lib/auth/roles';
import { getSession } from '@/lib/auth/session';

/** '/' is just a router: signed-in users go home, everyone else to /login. */
export default async function Index() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.isActive) redirect('/auth/signout?reason=deactivated');
  redirect(ROLE_HOME[session.role]);
}
