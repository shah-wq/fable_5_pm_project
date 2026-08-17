import { NextResponse } from 'next/server';
import { withAnon } from '@/lib/db';

/**
 * What the native shell checks at launch (spec §8): the minimum supported
 * version, so a breaking API change can force an update, plus the store URLs to
 * send the customer to and the legal URLs both stores require.
 *
 * Deliberately unauthenticated — the shell has to be able to ask before anyone
 * has logged in, and none of it is private. A forced-update mechanism is
 * painful to add retroactively, which is why it exists from the first release
 * even though nothing needs it yet.
 */
export async function GET() {
  const settings = await withAnon(async (client) => {
    const { rows } = await client.query(`select * from public.app_public_settings()`);
    return rows[0] ?? null;
  }).catch(() => null);

  return NextResponse.json(
    {
      currentVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? '1.0.0',
      minVersion: settings?.min_app_version ?? null,
      latestVersion: settings?.latest_app_version ?? null,
      stores: {
        ios: settings?.app_store_url ?? null,
        android: settings?.play_store_url ?? null,
      },
      legal: {
        privacy: settings?.privacy_policy_url ?? null,
        terms: settings?.terms_url ?? null,
      },
      support: {
        email: settings?.support_email ?? null,
        phone: settings?.support_phone ?? null,
      },
    },
    { headers: { 'cache-control': 'public, max-age=300' } }
  );
}
