import { getSession } from '@/lib/auth/session';
import { loadPortalPage } from '@/lib/portal/page';
import { withAnon } from '@/lib/db';
import { MoreSections } from './MoreSections';

export const dynamic = 'force-dynamic';

/**
 * More (spec §3.5). Everything that is not the project itself: contact details,
 * the message thread, notification settings, security, the FAQ that genuinely
 * reduces calls, the legal links both stores require — including the in-app
 * route to request account deletion — and the version number, which is the
 * first thing support will ask for.
 */
export default async function PortalMore({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const session = await getSession();
  const { project: p } = await loadPortalPage(searchParams);

  const legal = await withAnon(async (client) => {
    const { rows } = await client.query<{
      privacy_policy_url: string | null;
      terms_url: string | null;
      support_email: string | null;
      support_phone: string | null;
    }>(`select * from public.app_public_settings()`);
    return rows[0] ?? null;
  }).catch(() => null);

  return (
    <div className="app-page">
      <h1>More</h1>
      <MoreSections
        userId={session?.userId ?? ''}
        name={session?.fullName ?? session?.email ?? 'you'}
        projectId={p?.id ?? null}
        contact={{
          phone: null,
          email: session?.email ?? null,
        }}
        pm={{ name: p?.team.pmName ?? null, phone: p?.team.pmPhone ?? null, email: p?.team.pmEmail ?? null }}
        requests={p?.openRequests ?? []}
        legal={{
          privacy: legal?.privacy_policy_url ?? null,
          terms: legal?.terms_url ?? null,
          supportEmail: legal?.support_email ?? null,
          supportPhone: legal?.support_phone ?? null,
        }}
      />
    </div>
  );
}
