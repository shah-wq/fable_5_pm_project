import { guardPath } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { optionalRows } from '@/lib/db-optional';
import { NewDealForm } from './NewDealForm';

export const dynamic = 'force-dynamic';

/** A deal typed in by hand. Dealer submissions arrive in New on their own. */
export default async function NewDealPage() {
  const session = await guardPath('/deals');

  const data = await withUser(session, async (c) => ({
    sources: await optionalRows<{ id: string; name: string }>(
      c,
      'the sources list (public.client_sources)',
      `select id, name from public.client_sources where is_active order by sort_order, name`
    ),
    dealers: await optionalRows<{ id: string; name: string }>(
      c,
      'the dealer list',
      `select id, name from public.dealers where is_active order by name`
    ),
    owners: await optionalRows<{ id: string; name: string }>(
      c,
      'who can own a deal',
      `select id, coalesce(full_name, email) as name from public.profiles
        where role in ('admin','ops','sales') and is_active and deleted_at is null order by 2`
    ),
  }));

  return (
    <main className="surface">
      <h1>New deal</h1>
      <p className="dim">
        An opportunity, not a job. Winning it creates the project — and the person here is the
        same record the project will use, so nobody retypes a name.
      </p>
      <NewDealForm sources={data.sources} dealers={data.dealers} owners={data.owners} />
    </main>
  );
}
