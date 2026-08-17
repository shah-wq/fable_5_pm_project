import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Runs the queries the main pages run, one at a time, and reports which fail.
 *
 * Next.js hides a server error's message from the browser in production and
 * offers only an opaque digest, so "Application error" on a page gives an admin
 * nothing to act on. This closes that gap: open one URL, see exactly which query
 * broke and its SQLSTATE, in the reader's own browser, with no server log and no
 * SQL to paste.
 *
 * Admin-only, and it returns error text and row counts — never row contents.
 * Each probe runs inside its own savepoint, so one failure cannot abort the
 * transaction and cascade into false failures for everything after it.
 */
interface Probe {
  name: string;
  /** The page that breaks if this fails. */
  usedBy: string;
  sql: string;
}

const PROBES: Probe[] = [
  { name: 'projects', usedBy: 'Pipeline, Projects', sql: 'select count(*) from public.projects' },
  { name: 'project_stage_events', usedBy: 'Projects (days in stage)', sql: 'select count(*) from public.project_stage_events' },
  { name: 'stage1_survey', usedBy: 'Projects, Pipeline', sql: 'select count(*) from public.stage1_survey' },
  { name: 'stage2_design', usedBy: 'Projects, Pipeline', sql: 'select count(*) from public.stage2_design' },
  { name: 'stage3_permit', usedBy: 'Projects, Pipeline', sql: 'select count(*) from public.stage3_permit' },
  { name: 'stage4_procurement', usedBy: 'Projects, Pipeline', sql: 'select count(*) from public.stage4_procurement' },
  { name: 'stage5_install', usedBy: 'Projects, Pipeline', sql: 'select count(*) from public.stage5_install' },
  { name: 'stage6_inspection', usedBy: 'Projects, Pipeline', sql: 'select count(*) from public.stage6_inspection' },
  { name: 'stage7_complete', usedBy: 'Complete stage', sql: 'select count(*) from public.stage7_complete' },
  { name: 'finance_milestones', usedBy: 'Projects, Pipeline', sql: 'select count(*) from public.finance_milestones' },
  { name: 'jurisdictions', usedBy: 'Projects filters', sql: 'select count(*) from public.jurisdictions' },
  { name: 'sales_reps', usedBy: 'Projects filters, New project', sql: 'select count(*) from public.sales_reps' },
  { name: 'system_types', usedBy: 'Project details', sql: 'select count(*) from public.system_types' },
  { name: 'module_types', usedBy: 'Project details', sql: 'select count(*) from public.module_types' },
  { name: 'inverter_types', usedBy: 'Project details', sql: 'select count(*) from public.inverter_types' },
  { name: 'battery_types', usedBy: 'Project details', sql: 'select count(*) from public.battery_types' },
  { name: 'cash_financing_options', usedBy: 'Project details', sql: 'select count(*) from public.cash_financing_options' },
  { name: 'financing_companies', usedBy: 'Project details', sql: 'select count(*) from public.financing_companies' },
  { name: 'projects.battery_quantity', usedBy: 'Project details', sql: 'select battery_quantity from public.projects limit 1' },
  { name: 'projects.customer_estimate', usedBy: 'Customer portal', sql: 'select customer_estimate from public.projects limit 1' },
  { name: 'commissions', usedBy: 'Project page, dealer portal', sql: 'select count(*) from public.commissions' },
  { name: 'leads', usedBy: 'Leads', sql: 'select count(*) from public.leads' },
  { name: 'dealer_visible_fields', usedBy: 'Dealer portal', sql: 'select count(*) from public.dealer_visible_fields' },
  { name: 'dealers.default_commission_basis', usedBy: 'Dealer companies', sql: 'select default_commission_basis from public.dealers limit 1' },
  { name: 'report_definitions', usedBy: 'Reports', sql: 'select count(*) from public.report_definitions' },
  { name: 'customer_phrases', usedBy: 'Customer portal', sql: 'select count(*) from public.customer_phrases' },
  { name: 'customer_requests', usedBy: 'Project page, customer portal', sql: 'select count(*) from public.customer_requests' },
  { name: 'clients.is_archived', usedBy: 'Admin → Customers', sql: 'select is_archived from public.clients limit 1' },
  { name: 'customer_duplicate_candidates', usedBy: 'Admin → Customers', sql: 'select count(*) from public.customer_duplicate_candidates' },
  { name: 'customer_login_state()', usedBy: 'Admin → Customers', sql: 'select count(*) from public.customer_login_state()' },
  { name: 'customer_asks', usedBy: 'Project page, app Photos tab', sql: 'select count(*) from public.customer_asks' },
  { name: 'push_subscriptions', usedBy: 'Notifications', sql: 'select count(*) from public.push_subscriptions' },
  { name: 'project_contact()', usedBy: 'App: call my project manager', sql: `select count(*) from public.project_contact('00000000-0000-0000-0000-000000000000')` },
  { name: 'app_public_settings()', usedBy: 'App: legal links, version floor', sql: 'select count(*) from public.app_public_settings()' },
  { name: 'customer_portal_set_initial_password()', usedBy: 'Admin → Customers: set password', sql: `select pg_get_functiondef('public.customer_portal_set_initial_password(uuid,text,boolean)'::regprocedure) is not null` },
];

export async function GET() {
  const session = await getSession();
  if (!session || session.role !== 'admin' || !session.isActive) {
    return NextResponse.json(
      { error: 'This diagnostic is admin-only. Sign in as an admin and reload.' },
      { status: 403 }
    );
  }

  const results = await withUser(session, async (client) => {
    const out: Array<{ name: string; usedBy: string; ok: boolean; code?: string; error?: string }> = [];
    for (const probe of PROBES) {
      // Each probe is isolated: a failure must not abort the transaction and
      // make every later probe report a false 25P02.
      await client.query('savepoint probe');
      try {
        await client.query(probe.sql);
        await client.query('release savepoint probe');
        out.push({ name: probe.name, usedBy: probe.usedBy, ok: true });
      } catch (error) {
        await client.query('rollback to savepoint probe').catch(() => undefined);
        out.push({
          name: probe.name,
          usedBy: probe.usedBy,
          ok: false,
          code: (error as { code?: string }).code,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return out;
  }).catch((error: unknown) => [
    {
      name: 'database connection',
      usedBy: 'everything',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    },
  ]);

  const failed = results.filter((r) => !r.ok);

  return NextResponse.json(
    {
      build: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local',
      checked: results.length,
      failing: failed.length,
      // What to do about it, rather than a list to interpret.
      verdict: failed.length === 0
        ? 'Every query the pages need works. If a page still errors, it is not a missing table — send the digest and this output.'
        : `${failed.length} of ${results.length} failed. Run the newest file in db/dist/ (or catch-up-1.sql then catch-up-2.sql) in the SQL editor, then reload this page.`,
      failures: failed,
      ok: results.filter((r) => r.ok).map((r) => r.name),
    },
    { status: failed.length === 0 ? 200 : 503 }
  );
}
