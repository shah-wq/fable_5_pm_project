import { NextResponse } from 'next/server';
import { withAnon } from '@/lib/db';

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
      // Bookkeeping inserts can lag the real state, so each module is probed by
      // an object it creates, and anything missing is named with the file to
      // run. This is the readout that turns "Application error" into a
      // one-paste fix.
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
                 and column_name = 'default_commission_basis') as m_002000,
             to_regclass('public.report_definitions')::text    as m_002200,
             to_regclass('public.customer_phrases')::text      as m_002300,
             (select count(*) from information_schema.columns
               where table_schema = 'public' and table_name = 'clients'
                 and column_name = 'is_archived')             as m_002400,
             to_regclass('public.customer_asks')::text        as m_002500,
             to_regprocedure('public.customer_portal_set_initial_password(uuid,text,boolean)')::text
                                                              as m_002600,
             -- 002700 revoked the emailed-code login. Nothing is created, so the
             -- probe is the revocation itself: false once it has been applied.
             -- has_function_privilege raises if the function is absent, hence the
             -- guard — an absent function is also a closed door.
             (to_regprocedure('auth.request_otp(text)') is not null
              and has_function_privilege('authenticated', 'auth.request_otp(text)', 'execute'))
                                                              as m_002700_otp_open,
             to_regclass('public.project_metrics')::text      as m_002800,
             to_regclass('public.project_messages')::text     as m_002900,
             -- 003000's visible object is a function in the auth schema, which
             -- the app role cannot read the catalogue of — to_regprocedure needs
             -- no privilege on it, only the name.
             to_regprocedure('auth.sign_in(text,text,text)')::text as m_003000,
             -- 003100 creates nothing: it adds two columns to the dashboard's
             -- stage_thresholds table, so the columns are the probe.
             (select count(*) from information_schema.columns
               where table_schema = 'public' and table_name = 'stage_thresholds'
                 and column_name in ('typical_min_days', 'typical_max_days')) as m_003100,
             to_regclass('public.stage_feedback')::text       as m_003200,
             -- The CRM files. 003300 adds one enum value and creates nothing,
             -- so it is probed by the value itself.
             (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid
               where t.typname = 'user_role' and e.enumlabel = 'sales') as m_003300,
             to_regclass('public.deals')::text                as m_003400,
             to_regprocedure('public.convert_deal_to_project(uuid,public.project_stage)')::text as m_003500,
             (select count(*) from information_schema.columns
               where table_schema = 'public' and table_name = 'clients'
                 and column_name = 'mailing_street')          as m_003600,
             to_regprocedure('public.create_contact(jsonb,jsonb)')::text as m_003700`
        )
      );
      const p = probes.rows[0];
      const applied: Record<string, boolean> = {
        '20260803001400_stage_fields.sql': Boolean(p.m_001400),
        '20260803001500_complete_hold_cancel.sql': Boolean(p.m_001500),
        '20260803001700_project_details.sql': Boolean(p.m_001700),
        '20260803001800_equipment_quantities.sql': Number(p.m_001800) === 2,
        '20260803001900_dealer_portal.sql': Boolean(p.m_001900),
        '20260803002000_dealer_companies.sql': Number(p.m_002000) === 1,
        '20260803002200_report_builder.sql': Boolean(p.m_002200),
        '20260803002300_customer_portal.sql': Boolean(p.m_002300),
        '20260803002400_customer_management.sql': Number(p.m_002400) === 1,
        '20260803002500_mobile_app.sql': Boolean(p.m_002500),
        '20260803002600_customer_passwords.sql': Boolean(p.m_002600),
        '20260803002700_invite_customers_with_tokens.sql': p.m_002700_otp_open === false,
        '20260803002800_dashboard.sql': Boolean(p.m_002800),
        '20260803002900_project_chat.sql': Boolean(p.m_002900),
        '20260803003000_sign_in.sql': Boolean(p.m_003000),
        '20260803003100_typical_durations.sql': Number(p.m_003100) === 2,
        '20260803003200_stage_feedback.sql': Boolean(p.m_003200),
        '20260803003300_add_sales_role.sql': Number(p.m_003300) === 1,
        '20260803003400_crm_foundation.sql': Boolean(p.m_003400),
        '20260803003500_deals.sql': Boolean(p.m_003500),
        '20260803003600_contact_intake.sql': Number(p.m_003600) === 1,
        '20260803003700_contact_create.sql': Boolean(p.m_003700),
      };
      const behind = Object.entries(applied)
        .filter(([, present]) => !present)
        .map(([name]) => name);

      migrations = {
        applied,
        behind,
        fix: behind.length === 0
          ? 'up to date'
          : behind.length === 1
            ? `run db/dist/${behind[0].slice(0, 14)}-${behind[0].slice(15).replace(/_/g, '-').replace(/\.sql$/, '')}.sql in the SQL editor`
            : 'run every db/dist/catch-up-*.sql in order in the SQL editor',
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
