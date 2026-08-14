import { NextResponse } from 'next/server';
import { withAnon } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Deployment diagnostics — excluded from the auth middleware so it always
 * answers. Reports which env vars are present (booleans only, never values)
 * and whether the database is reachable with the schema applied.
 */
export async function GET() {
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

      // Which migrations this database has actually applied — the first
      // thing to compare when the deployed code errors on missing tables
      // or columns. Bookkeeping inserts may lag the real state, so key
      // objects are probed directly.
      const probes = await withAnon((c) =>
        c.query(
          `select
             to_regclass('public.stage1_survey')::text        as m_001400,
             to_regclass('public.stage7_complete')::text      as m_001500,
             to_regclass('public.module_types')::text         as m_001700,
             (select count(*) from information_schema.columns
               where table_schema = 'public' and table_name = 'projects'
                 and column_name in ('inverter_quantity', 'battery_quantity')) as m_001800,
             to_regclass('public.commissions')::text          as m_001900,
             (select count(*) from information_schema.columns
               where table_schema = 'public' and table_name = 'dealers'
                 and column_name = 'default_commission_basis') as m_002000`
        )
      );
      const p = probes.rows[0];
      migrations = {
        '001400_stage_fields': Boolean(p.m_001400),
        '001500_complete_hold_cancel': Boolean(p.m_001500),
        '001700_project_details': Boolean(p.m_001700),
        '001800_equipment_quantities': Number(p.m_001800) === 2,
        '001900_dealer_portal': Boolean(p.m_001900),
        '002000_dealer_companies': Number(p.m_002000) === 1,
      };
    } catch (cause) {
      database = `unreachable: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }

  // SMTP is optional in development (emails go to the server log).
  const ok = env.DATABASE_URL && database === 'ok';

  return NextResponse.json(
    {
      ok,
      env,
      database,
      migrations,
      email: env.SMTP_HOST ? 'smtp configured' : 'no SMTP — dev-logging only',
      node: process.version,
    },
    { status: ok ? 200 : 503 }
  );
}
