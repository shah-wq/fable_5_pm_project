/**
 * Env resolution for Supabase credentials. Supabase's newer dashboard
 * quickstarts and platform integrations name the browser key
 * NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (sb_publishable_…) and the server key
 * SUPABASE_SECRET_KEY (sb_secret_…); older setups use ANON_KEY /
 * SERVICE_ROLE_KEY. Accept either spelling so any injector works.
 *
 * NEXT_PUBLIC_* references stay literal here so Next.js can inline them into
 * client bundles at build time.
 */

export function supabaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is required.');
  return url;
}

export function supabasePublishableKey(): string {
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!key) {
    throw new Error(
      'Set NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY).'
    );
  }
  return key;
}

export function supabaseSecretKey(): string {
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error(
      'Set SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) — server-only, required for this code path.'
    );
  }
  return key;
}
