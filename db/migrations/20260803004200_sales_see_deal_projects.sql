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
