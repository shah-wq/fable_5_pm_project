import type { PoolClient } from 'pg';

/**
 * Which migrations a database has actually applied.
 *
 * The deployment and the database move separately here — code reaches Vercel on
 * push, the SQL is pasted into a console by a person — so "which files is this
 * database missing" is the first question whenever a screen degrades. Asking the
 * catalogue rather than the bookkeeping table is deliberate: a bookkeeping row
 * can be inserted by a half-finished paste, while a table either exists or does
 * not.
 *
 * Lives here rather than in the health endpoint because the screens that degrade
 * need the same answer, and a screen that can say "you are missing these three"
 * saves somebody the round trip of opening a JSON endpoint and reading it.
 */

const PROBE_SQL = `select
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
           to_regprocedure('public.create_contact(jsonb,jsonb)')::text as m_003700,
           (select count(*) from information_schema.columns
             where table_schema = 'public' and table_name = 'clients'
               and column_name = 'contact_stage')            as m_003800`;

export interface MigrationState {
  applied: Record<string, boolean>;
  behind: string[];
  /** One sentence naming what to paste, or 'up to date'. */
  advice: string;
}

/** What to paste, given what is missing. */
export function catchUpAdvice(behind: string[]): string {
  if (behind.length === 0) return 'up to date';

  return (
    `Open Admin → Database and click Apply: the application runs the missing ` +
    `files itself, through its own connection, and shows what happened to each one.`
  );
}

export async function migrationState(client: PoolClient): Promise<MigrationState> {
  const { rows } = await client.query(PROBE_SQL);
  const p = rows[0] as Record<string, unknown>;
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
    '20260803003800_contact_stages.sql': Number(p.m_003800) === 1,
  };
  const behind = Object.entries(applied)
    .filter(([, present]) => !present)
    .map(([name]) => name);
  return { applied, behind, advice: catchUpAdvice(behind) };
}

/**
 * The sentence a degraded screen shows: what this database is actually missing,
 * and what to paste. Named files rather than a generic list, because a generic
 * list is the thing somebody has already tried by the time they read it.
 */
export function behindSentence(behind: string[]): string {
  if (behind.length === 0) return '';
  const names = behind.map((f) => f.replace(/\.sql$/, ''));
  const shown = names.length > 4 ? `${names.slice(0, 4).join(', ')} and ${names.length - 4} more` : names.join(', ');
  return `This database is missing ${names.length} migration${names.length === 1 ? '' : 's'}: ${shown}. ${catchUpAdvice(behind)}`;
}
