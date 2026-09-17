import { NextResponse } from 'next/server';
import { withAnon } from '@/lib/db';
import { migrationState } from '@/lib/db-migrations';

export const dynamic = 'force-dynamic';

/**
 * Deployment diagnostics — excluded from the auth middleware so it always
 * answers. Reports which env vars are present (booleans only, never values)
 * and whether the database is reachable with the schema applied.
 */
export async function GET() {
  // Which build is answering. Without this, a stale deployment and a broken one
  // look identical from the outside — and a Vercel deployment URL is frozen to
  // one build forever, so "I pushed a fix" and "the page is fixed" are not the
  // same statement until you can compare commits.
  const build = {
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local',
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    message: process.env.VERCEL_GIT_COMMIT_MESSAGE?.split('\n')[0] ?? null,
    /** 'production' for the live domain; 'preview' for a per-deployment URL. */
    target: process.env.VERCEL_ENV ?? 'self-hosted',
    deploymentUrl: process.env.VERCEL_URL ?? null,
    appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? null,
  };

  const env = {
    DATABASE_URL: Boolean(process.env.DATABASE_URL),
    SMTP_HOST: Boolean(process.env.SMTP_HOST),
    NEXT_PUBLIC_SITE_URL: Boolean(process.env.NEXT_PUBLIC_SITE_URL),
  };

  let database = 'skipped: DATABASE_URL missing';
  let migrations: unknown = null;
  if (env.DATABASE_URL) {
    try {
      const { rows } = await withAnon((c) =>
        c.query<{ sessions: string | null; projects: string | null }>(
          `select to_regclass('auth.sessions')::text as sessions,
                  to_regclass('public.projects')::text as projects`
        )
      );
      database =
        rows[0]?.sessions && rows[0]?.projects
          ? 'ok'
          : 'error: schema missing (run: npm run db:migrate)';

      // Which migrations this database has actually applied — the first thing
      // to compare when the deployed code errors on a missing table or column.
      // The probes themselves live in lib/db-migrations.ts, because the screens
      // that degrade name the same files and two copies of that list would
      // eventually disagree about what is missing.
      const state = await withAnon((c) => migrationState(c));
      migrations = { applied: state.applied, behind: state.behind, fix: state.advice };
    } catch (cause) {
      database = `unreachable: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }

  // SMTP is optional in development (emails go to the server log).
  const ok = env.DATABASE_URL && database === 'ok';

  return NextResponse.json(
    {
      ok,
      build,
      env,
      database,
      migrations,
      email: env.SMTP_HOST ? 'smtp configured' : 'no SMTP — dev-logging only',
      node: process.version,
    },
    { status: ok ? 200 : 503 }
  );
}
