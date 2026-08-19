import type { UserRole } from '../auth/roles';

/**
 * What each role sees (spec §8), decided once and honoured server-side.
 *
 * §10 is explicit that role scoping belongs in the query, never in hiding charts
 * in the UI — so this object does not describe which components to render, it
 * describes which queries to run. Nothing is fetched and then hidden.
 *
 * Three of the five rules are enforced below the application entirely, which is
 * stronger than anything this file could do:
 *
 *  - Dealer: their reduced view lives in the dealer portal, and it is scoped by
 *    public.projects' own row-level security — the dealer dashboard and the admin
 *    dashboard run the same query and there is no filter to forget.
 *  - Customer: no dashboard route is open to them at all (ROUTE_ACCESS).
 *  - Finance: cannot read public.projects, so it reads the whitelisted
 *    public.project_financial_metrics, which carries no assigned_pm and no
 *    per-stage day counters. "No workload or stage-detail charts" therefore holds
 *    because the data is not reachable, not because a component was left out.
 */

export interface DashboardView {
  /** 'financial' is the finance role's own, much smaller, dashboard. */
  kind: 'operational' | 'financial';
  /** Pipeline value and the dealers' money columns. */
  financial: boolean;
  /** The 'my projects' toggle — meaningless for a role with no own projects. */
  mineToggle: boolean;
}

export function viewFor(role: UserRole, opsSeeFinancials: boolean): DashboardView {
  if (role === 'finance') {
    return { kind: 'financial', financial: true, mineToggle: false };
  }
  if (role === 'admin') {
    return { kind: 'operational', financial: true, mineToggle: true };
  }
  // ops — the PM. Everything operational; the money cards only when an admin has
  // granted it in Admin → Settings (§8: "hidden unless granted").
  return { kind: 'operational', financial: opsSeeFinancials, mineToggle: true };
}
