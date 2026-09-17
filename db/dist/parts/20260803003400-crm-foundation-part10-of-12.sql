-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with:
--   node scripts/split-migration.mjs 20260803003400_crm_foundation.sql 12
--
--   20260803003400_crm_foundation.sql · part 10 of 12
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
  if not exists (select 1 from public.sf_migration_parts where part = '20260803003400-crm-foundation-part9') then
    raise exception 'Part 9 has not been applied to this database — run 20260803003400-crm-foundation-part9-of-12.sql first.'
      using hint = 'If you believe you did run it, it did not finish: nothing it created is here. Run it again and read what the console says about it, because that message is the thing that has been missing all along.';
  end if;
end
$$;


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

-- Recorded so the next part can tell that this one finished.
insert into public.sf_migration_parts (part) values ('20260803003400-crm-foundation-part10')
  on conflict (part) do nothing;
