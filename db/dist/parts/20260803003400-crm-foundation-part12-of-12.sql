-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with:
--   node scripts/split-migration.mjs 20260803003400_crm_foundation.sql 12
--
--   20260803003400_crm_foundation.sql · part 12 of 12
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
  if not exists (select 1 from public.sf_migration_parts where part = '20260803003400-crm-foundation-part11') then
    raise exception 'Part 11 has not been applied to this database — run 20260803003400-crm-foundation-part11-of-12.sql first.'
      using hint = 'If you believe you did run it, it did not finish: nothing it created is here. Run it again and read what the console says about it, because that message is the thing that has been missing all along.';
  end if;
end
$$;

create policy clients_select_sales on public.clients
  for select to authenticated
  using ((select app.current_user_role()) in ('ops', 'sales'));

drop policy if exists clients_write_sales on public.clients;
create policy clients_write_sales on public.clients
  for all to authenticated
  using ((select app.current_user_role()) in ('ops', 'sales'))
  with check ((select app.current_user_role()) in ('ops', 'sales'));

-- -----------------------------------------------------------------------------
-- 10. Housekeeping triggers
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['client_channels', 'client_addresses', 'deals', 'lists',
                           'lead_magnets', 'subscriptions', 'client_sources',
                           'deal_loss_reasons', 'dealer_tiers', 'competitors',
                           'roof_types'] loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function app.tg_set_updated_at()', t);
  end loop;

  -- Audited like every other table that holds a decision.
  foreach t in array array['deals', 'proposals', 'subscriptions', 'suppression',
                           'client_channels', 'client_addresses'] loop
    execute format('drop trigger if exists audit_row on public.%I', t);
    execute format(
      'create trigger audit_row after insert or update or delete on public.%I
         for each row execute function app.tg_audit_row()', t);
  end loop;
end
$$;

/**
 * stage_entered_at follows the stage, so "days in stage" on the board is a
 * property of the row rather than something the application remembers to set.
 */
create or replace function app.tg_deal_stage_stamp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.stage is distinct from old.stage then
    new.stage_entered_at := now();
    if new.stage = 'won' and new.won_at is null then new.won_at := now(); end if;
    if new.stage = 'lost' and new.lost_at is null then new.lost_at := now(); end if;
  end if;
  return new;
end;
$$;

drop trigger if exists deal_stage_stamp on public.deals;
create trigger deal_stage_stamp before update on public.deals
  for each row execute function app.tg_deal_stage_stamp();

/**
 * last_activity_at on the person, maintained where the activity is recorded.
 * Part 4 lists it as a column on clients; a column nobody updates is worse than
 * no column, so the audit log keeps it true.
 */
create or replace function app.tg_audit_touch_client()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.client_id is not null then
    update public.clients set last_activity_at = new.occurred_at where id = new.client_id;
    if new.kind in ('call', 'email', 'sms', 'meeting') then
      update public.clients set last_contacted_at = new.occurred_at where id = new.client_id;
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists audit_touch_client on public.audit_log;
create trigger audit_touch_client after insert on public.audit_log
  for each row execute function app.tg_audit_touch_client();

-- Recorded so the next part can tell that this one finished.
insert into public.sf_migration_parts (part) values ('20260803003400-crm-foundation-part12')
  on conflict (part) do nothing;
