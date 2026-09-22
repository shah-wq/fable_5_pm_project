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
    PANDADOC_API_KEY: Boolean(process.env.PANDADOC_API_KEY),
    PANDADOC_WEBHOOK_KEY: Boolean(process.env.PANDADOC_WEBHOOK_KEY),
    NEXT_PUBLIC_SITE_URL: Boolean(process.env.NEXT_PUBLIC_SITE_URL),
  };

  /**
   * Which server this deployment is talking to, in a form that identifies it
   * without handing anybody a way in.
   *
   * A hosted Postgres with branches gives every branch the same database name
   * and the same role, so `current_database()` and `current_user` are identical
   * across all of them. The only thing that differs is the host — which means a
   * paste that lands in the wrong branch is invisible from both ends: the SQL
   * console says the table is there, the application says it is not, and both
   * are telling the truth about different servers.
   *
   * This endpoint is public, so the host is not printed. The first label of it —
   * the endpoint id — has its middle masked, leaving enough to match against the
   * branch list in the provider's dashboard and not enough to be a connection
   * string.
   */
  let endpoint: string | null = null;
  if (process.env.DATABASE_URL) {
    try {
      const host = new URL(process.env.DATABASE_URL).hostname;
      // The pooled endpoint is the same branch reached through a connection
      // pooler, and the '-pooler' suffix is the same on every one of them — so
      // it is dropped before masking, or the eight characters kept would be the
      // eight every branch shares.
      const id = host.split('.')[0].replace(/-pooler$/, '');
      endpoint = id.length > 12 ? `${id.slice(0, 3)}****${id.slice(-8)}` : id;
    } catch {
      endpoint = 'unparseable';
    }
  }

  let database = 'skipped: DATABASE_URL missing';
  let migrations: unknown = null;
  /**
   * A table anybody can create by hand, reported here.
   *
   * Matching endpoint ids against a dashboard is comparing two descriptions of a
   * thing. This compares the thing: create public.sf_branch_marker in the SQL
   * console, reload this page, and if it does not appear then the console and
   * this deployment are not looking at the same database — no names, no ids, no
   * room for either of us to be reading the wrong screen.
   */
  let marker: string | null = null;
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
      marker = (
        await withAnon((c) =>
          c.query<{ m: string | null }>(
            `select to_regclass('public.sf_branch_marker')::text as m`
          )
        )
      ).rows[0]?.m ?? null;

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
      endpoint,
      marker: marker ?? 'not present — see the two-ended test in the route comment',
      migrations,
      email: env.SMTP_HOST ? 'smtp configured' : 'no SMTP — dev-logging only',
      node: process.version,
    },
    { status: ok ? 200 : 503 }
  );
}
