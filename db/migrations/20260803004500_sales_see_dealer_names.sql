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
