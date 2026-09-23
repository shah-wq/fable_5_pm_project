-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · newest module · step 10 of 15 · 20260803004200_sales_see_deal_projects.sql
--
-- For a database that is already up to date apart from this module. Paste the
-- whole file into a SQL console (e.g. the Neon SQL Editor) and run it once.
-- Safe to run again: every statement skips work already done, so 'already
-- exists' errors cannot happen. NOTICE lines saying 'does not exist, skipping'
-- are normal.
--
-- Run these in order, each as its own execution:
--   1. 20260803003300-add-sales-role.sql
--   2. 20260803003400-crm-foundation.sql
--   3. 20260803003500-deals.sql
--   4. 20260803003600-contact-intake.sql
--   5. 20260803003700-contact-create.sql
--   6. 20260803003800-contact-stages.sql
--   7. 20260803003900-contract-signed-system.sql
--   8. 20260803004000-project-holds-contact.sql
--   9. 20260803004100-signing-creates-project.sql
--   10. 20260803004200-sales-see-deal-projects.sql
--   11. 20260803004300-stage-upload-fix.sql
--   12. 20260803004400-esignature.sql
--   13. 20260803004500-sales-see-dealer-names.sql
--   14. 20260803004600-stage-fields-solar.sql
--   15. 20260803004700-notifications.sql
-- Each break is where one script adds something the next one uses, which
-- PostgreSQL will not allow inside a single pasted transaction.
--
-- Behind by more than this module? Run every db/dist/catch-up-*.sql in order
-- instead — they cover everything from 001400 onwards.
-- ============================================================================

-- >>> 20260803004200_sales_see_deal_projects.sql
-- =============================================================================
-- A sales rep sees a deal's project exactly when they can see the deal
-- =============================================================================
-- The Deals board now follows a sale through delivery, on the projects deals
-- became. A rep's view of it has to match their view of the deals: 003400 lets
-- a rep see the deals they own, the unassigned pool, and — with the
-- capability or the profile setting — all of them. The project policy it wrote
-- alongside covered only the first and the capability, so a rep saw the deal
-- for an unassigned sale on the board's table and nothing on the board.
--
-- Rather than list the same rules a second time and let the two drift, this
-- asks the deals table: the policy's subquery reads deals as the rep, under
-- deals_select, so "can see a deal whose project this is" is precisely
-- "can see the deal". deals_select does not read projects, so the two
-- policies cannot recurse.
--
-- Read only. Moving projects stays with the project team.
-- =============================================================================

do $$
begin
  if to_regclass('public.deals') is null then
    raise exception 'Run 20260803003400_crm_foundation.sql first — it creates deals.'
      using hint = 'Admin → Database → Apply runs every missing file in order.';
  end if;
end
$$;

drop policy if exists projects_select_sales on public.projects;
drop policy if exists projects_select_via_deal on public.projects;

create policy projects_select_via_deal on public.projects
  for select to authenticated
  using (
    (select app.current_user_role()) = 'sales'
    and exists (select 1 from public.deals d where d.project_id = projects.id)
  );

