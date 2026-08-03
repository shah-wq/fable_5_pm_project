import { NextResponse } from 'next/server';
import { createAnonClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Deployment diagnostics — excluded from the auth middleware so it works even
 * when everything else 500s. Reports which env vars are present (booleans
 * only, never values) and whether the database schema is reachable, by
 * calling the anon-safe upload-grant validator with a dummy token.
 *
 *   env.*      false → set that variable on the deploy platform and REBUILD
 *              (NEXT_PUBLIC_* values are inlined at build time).
 *   database   'ok' → migrations applied and the project is reachable;
 *              anything else is the underlying error message.
 */
export async function GET() {
  const env = {
    NEXT_PUBLIC_SUPABASE_URL: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    publishable_key: Boolean(
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ),
    secret_key: Boolean(
      process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
    ),
    NEXT_PUBLIC_SITE_URL: Boolean(process.env.NEXT_PUBLIC_SITE_URL),
  };

  let database = 'skipped: env incomplete';
  if (env.NEXT_PUBLIC_SUPABASE_URL && env.publishable_key) {
    try {
      const anon = createAnonClient();
      const { error } = await anon.rpc('validate_upload_grant', {
        p_token: 'health-check-not-a-real-token',
      });
      database = error
        ? `error: ${error.message} (are the migrations applied? npx supabase db push)`
        : 'ok';
    } catch (cause) {
      database = `unreachable: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }

  const ok =
    Object.values(env).every(Boolean) && database === 'ok';

  return NextResponse.json(
    { ok, env, database, node: process.version },
    { status: ok ? 200 : 503 }
  );
}
