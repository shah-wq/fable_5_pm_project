-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with:
--   node scripts/split-migration.mjs 20260803003400_crm_foundation.sql 12
--
--   20260803003400_crm_foundation.sql · part 9 of 12
--
-- The same migration, cut into pieces small enough for a browser SQL console.
-- Run the parts in order, each as its own execution, and stop at the first one
-- that reports an error — that error is the thing worth sending on.
--
-- Safe to run again: every statement skips work already done.
-- ============================================================================


create table if not exists public.sf_migration_parts (
  part       text primary key,
  applied_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from public.sf_migration_parts where part = '20260803003400-crm-foundation-part8') then
    raise exception 'Part 8 has not been applied to this database — run 20260803003400-crm-foundation-part8-of-12.sql first.'
      using hint = 'If you believe you did run it, it did not finish: nothing it created is here. Run it again and read what the console says about it, because that message is the thing that has been missing all along.';
  end if;
end
$$;

grant insert, update, delete on
  public.client_sources, public.deal_loss_reasons, public.dealer_tiers,
  public.competitors, public.roof_types
to authenticated;

/** A channel or address is readable exactly when its person is. */
do $$
declare
  t text;
begin
  foreach t in array array['client_channels', 'client_addresses'] loop
    execute format('drop policy if exists %1$s_select on public.%1$s', t);
    execute format($p$
      create policy %1$s_select on public.%1$s
        for select to authenticated
        using (exists (select 1 from public.clients c where c.id = %1$s.client_id))
    $p$, t);
    execute format('drop policy if exists %1$s_write on public.%1$s', t);
    execute format($p$
      create policy %1$s_write on public.%1$s
        for all to authenticated
        using (app.is_sales_staff() or app.current_user_role() = 'ops')
        with check (app.is_sales_staff() or app.current_user_role() = 'ops')
    $p$, t);
  end loop;
end
$$;

-- Deals: staff see them per the visibility flag, a dealer sees only their own
-- submissions. "A dealer's scoping to their own company_id extends to deals with
-- no new mechanism."
drop policy if exists deals_select on public.deals;
create policy deals_select on public.deals
  for select to authenticated
  using (
    (select app.current_user_role()) in ('admin', 'ops')
    or (
      (select app.current_user_role()) = 'sales'
      and (
        app.has_capability('manage_all_deals')
        or coalesce((select p.deal_visibility from public.profiles p
                      where p.id = (select auth.uid())), 'own') = 'all'
        or owner_id = (select auth.uid())
        or owner_id is null                       -- the unassigned pool (Part 8)
      )
    )
    or dealer_id in (select app.current_dealer_ids())
  );

drop policy if exists deals_insert on public.deals;
create policy deals_insert on public.deals
  for insert to authenticated
  with check (
    app.is_sales_staff()
    or (dealer_id in (select app.current_dealer_ids()) and stage = 'new')
  );

drop policy if exists deals_update on public.deals;
create policy deals_update on public.deals
  for update to authenticated
  using (app.is_sales_staff())
  with check (app.is_sales_staff());

drop policy if exists deals_delete on public.deals;
create policy deals_delete on public.deals
  for delete to authenticated
  using ((select app.is_admin()));

-- Recorded so the next part can tell that this one finished.
insert into public.sf_migration_parts (part) values ('20260803003400-crm-foundation-part9')
  on conflict (part) do nothing;
