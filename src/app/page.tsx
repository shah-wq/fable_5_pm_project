import { redirect } from 'next/navigation';
import { ROLE_HOME } from '@/lib/auth/roles';
import { createSupabaseServer } from '@/lib/supabase/server';

/** '/' is just a router: signed-in users go home, everyone else to /login. */
export default async function Index() {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  redirect(profile ? ROLE_HOME[profile.role] : '/login');
}
