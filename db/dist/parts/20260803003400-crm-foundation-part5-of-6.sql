-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with:
--   node scripts/split-migration.mjs 20260803003400_crm_foundation.sql 6
--
--   20260803003400_crm_foundation.sql · part 5 of 6
--
-- The same migration, cut into pieces small enough for a browser SQL console.
-- Run the parts in order, each as its own execution, and stop at the first one
-- that reports an error — that error is the thing worth sending on.
--
-- Safe to run again: every statement skips work already done.
-- ============================================================================


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

drop policy if exists deal_contacts_select on public.deal_contacts;
create policy deal_contacts_select on public.deal_contacts
  for select to authenticated
  using (exists (select 1 from public.deals d where d.id = deal_contacts.deal_id));
drop policy if exists deal_contacts_write on public.deal_contacts;
create policy deal_contacts_write on public.deal_contacts
  for all to authenticated
  using (app.is_sales_staff()) with check (app.is_sales_staff());

drop policy if exists proposals_select on public.proposals;
create policy proposals_select on public.proposals
  for select to authenticated
  using (exists (select 1 from public.deals d where d.id = proposals.deal_id));
drop policy if exists proposals_write on public.proposals;
create policy proposals_write on public.proposals
  for all to authenticated
  using (app.is_sales_staff()) with check (app.is_sales_staff());

-- Subscriptions carry consent records: marketing may read and write, consent
-- edits need their own flag (Part 8), and the person themselves never reaches
-- this table through the portal — they use the token-based preference page.
drop policy if exists subscriptions_select on public.subscriptions;
create policy subscriptions_select on public.subscriptions
  for select to authenticated
  using (app.is_sales_staff() or app.has_capability('manage_marketing'));
