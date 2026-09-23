-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · newest module · step 13 of 15 · 20260803004500_sales_see_dealer_names.sql
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

-- >>> 20260803004500_sales_see_dealer_names.sql
-- =============================================================================
-- Sales reps can choose a dealer
-- =============================================================================
-- Signing a contact needs a dealer (the project cannot be made without one),
-- and the signing form offers a dealer dropdown. For a sales rep that
-- dropdown was empty: public.dealers is readable by admin, ops and finance
-- only (dealers_select, 000900), so the rep could never pick the dealer the
-- form insisted on.
--
-- Opening the table to sales would show them every dealer column, commission
-- defaults included, which is not theirs to see. So this is a directory:
-- id and name of each dealer, for the roles that sell, and nothing else.
-- =============================================================================

create or replace function public.dealer_directory()
returns table (id uuid, name text, is_active boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.name, d.is_active
    from public.dealers d
   where app.current_user_role() in ('admin', 'ops', 'sales', 'finance')
   order by d.name;
$$;

revoke execute on function public.dealer_directory() from public, anon;
grant execute on function public.dealer_directory() to authenticated;

