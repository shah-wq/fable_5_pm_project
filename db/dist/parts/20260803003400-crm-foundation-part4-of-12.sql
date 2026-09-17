-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with:
--   node scripts/split-migration.mjs 20260803003400_crm_foundation.sql 12
--
--   20260803003400_crm_foundation.sql · part 4 of 12
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
  if not exists (select 1 from public.sf_migration_parts where part = '20260803003400-crm-foundation-part3') then
    raise exception 'Part 3 has not been applied to this database — run 20260803003400-crm-foundation-part3-of-12.sql first.'
      using hint = 'If you believe you did run it, it did not finish: nothing it created is here. Run it again and read what the console says about it, because that message is the thing that has been missing all along.';
  end if;
end
$$;


/**
 * Part 10 step 6, the half that belongs in the database: "The legacy columns
 * become denormalised primaries maintained by a trigger."
 *
 * Every existing query that reads clients.email keeps reading clients.email,
 * for ever, and gets the right answer — which is the only reason this migration
 * can be additive. The trigger runs on the child table, so the primary follows
 * whatever the new UI does.
 */
create or replace function app.tg_channel_sync_primary()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client uuid := coalesce(new.client_id, old.client_id);
begin
  update public.clients c
     set email = coalesce(
           (select ch.value from public.client_channels ch
             where ch.client_id = v_client and ch.kind = 'email' and ch.is_primary
             limit 1), c.email),
         phone = coalesce(
           (select ch.value from public.client_channels ch
             where ch.client_id = v_client and ch.kind = 'phone' and ch.is_primary
             limit 1), c.phone)
   where c.id = v_client;
  return null;
end;
$$;

drop trigger if exists channel_sync_primary on public.client_channels;
create trigger channel_sync_primary
  after insert or update or delete on public.client_channels
  for each row execute function app.tg_channel_sync_primary();

-- Backfill: copy, do not move (Part 10 step 2).
insert into public.client_channels (client_id, kind, value, value_normalised, is_primary)
select c.id, 'email', c.email, app.normalise_channel('email', c.email), true
  from public.clients c
 where c.email is not null and btrim(c.email) <> ''
   and not exists (select 1 from public.client_channels ch
                    where ch.client_id = c.id and ch.kind = 'email');

insert into public.client_channels (client_id, kind, value, value_normalised, is_primary)
select c.id, 'phone', c.phone, app.normalise_channel('phone', c.phone), true
  from public.clients c
 where c.phone is not null and btrim(c.phone) <> ''
   and not exists (select 1 from public.client_channels ch
                    where ch.client_id = c.id and ch.kind = 'phone');

-- Step 3: a property address from each project's site address.
insert into public.client_addresses (client_id, kind, lines, jurisdiction_id, is_primary)
select distinct on (p.client_id)
       p.client_id, 'property', p.address, p.jurisdiction_id, true
  from public.projects p
 where p.address is not null and btrim(p.address) <> ''
   and not exists (select 1 from public.client_addresses a
                    where a.client_id = p.client_id and a.kind = 'property')
 order by p.client_id, p.created_at;

-- Any remaining project addresses become non-primary property rows: a person
-- with two houses gets two addresses, which is the whole point of the table.
insert into public.client_addresses (client_id, kind, lines, jurisdiction_id, is_primary)
select p.client_id, 'property', p.address, p.jurisdiction_id, false
  from public.projects p
 where p.address is not null and btrim(p.address) <> ''
   and not exists (select 1 from public.client_addresses a
                    where a.client_id = p.client_id and a.lines = p.address);

-- -----------------------------------------------------------------------------
-- 5. Part 10 step 4 — leads becomes deals
-- -----------------------------------------------------------------------------
-- "Two tables holding pre-contract opportunities would need a rule about which
-- one a dealer submission goes to, and that rule would be wrong within a month.
-- One migration now, with leads retained as a read-only view for one release so
-- nothing referencing it breaks mid-deploy."
do $$
begin
  if to_regclass('public.deals') is null then
    alter table public.leads rename to deals;
  end if;
end
$$;

create table if not exists public.deals (
  id uuid primary key default gen_random_uuid()
);

alter table public.deals
  add column if not exists stage text not null default 'new'
    check (stage in ('new', 'contacted', 'qualified', 'proposal',
                     'negotiation', 'contract_out', 'won', 'lost')),
  add column if not exists stage_entered_at      timestamptz not null default now(),
  add column if not exists client_id             uuid references public.clients (id) on delete set null,
  add column if not exists owner_id              uuid references public.profiles (id) on delete set null,
  add column if not exists next_action           text,
  add column if not exists next_action_at        date,
  add column if not exists next_action_owner_id  uuid references public.profiles (id) on delete set null,
  add column if not exists property_address_id   uuid references public.client_addresses (id) on delete set null,
  add column if not exists source_id             uuid references public.client_sources (id) on delete set null,
  -- qualification (stage 3)
  add column if not exists homeowner_confirmed   boolean not null default false,
  add column if not exists roof_type_id          uuid references public.roof_types (id) on delete set null,
  add column if not exists roof_age              integer,
  add column if not exists shading_concern       text,
  add column if not exists avg_monthly_bill      numeric(10,2),
  add column if not exists utility_id            uuid references public.utilities (id) on delete set null,
  add column if not exists annual_usage_kwh      integer,
  add column if not exists credit_band           text,
  add column if not exists timeline_intent       text,
  add column if not exists decision_maker_identified boolean not null default false,
  add column if not exists qualification_state   jsonb not null default '{}'::jsonb,
  -- proposal (stage 4)
  add column if not exists system_size_kw        numeric(8,3),
  add column if not exists module_id             uuid references public.module_types (id) on delete set null,
  add column if not exists inverter_id           uuid references public.inverter_types (id) on delete set null,
  add column if not exists battery_id            uuid references public.battery_types (id) on delete set null,
  add column if not exists battery_qty           integer,
  add column if not exists production_estimate_kwh integer,
  add column if not exists gross_price           numeric(12,2),
  add column if not exists incentives            numeric(12,2),
  add column if not exists net_price             numeric(12,2),
  add column if not exists financing_route       text,
  add column if not exists financing_company_id  uuid references public.financing_companies (id) on delete set null,
  add column if not exists monthly_payment       numeric(10,2),
  -- commercial
  add column if not exists expected_close_date   date,
  add column if not exists probability           integer check (probability between 0 and 100),
  add column if not exists probability_is_override boolean not null default false,
  add column if not exists contract_value        numeric(12,2),
  add column if not exists expected_commission   numeric(12,2),
  add column if not exists competitor_id         uuid references public.competitors (id) on delete set null,
  -- outcome
  add column if not exists won_at                timestamptz,
  add column if not exists lost_at               timestamptz,
  add column if not exists lost_reason_id        uuid references public.deal_loss_reasons (id) on delete set null,
  add column if not exists lost_notes            text,
  add column if not exists project_id            uuid references public.projects (id) on delete set null,
  add column if not exists reopened_from_deal_id uuid references public.deals (id) on delete set null,
  add column if not exists code                  text,
  add column if not exists created_at            timestamptz not null default now(),
  add column if not exists updated_at            timestamptz not null default now();

-- Recorded so the next part can tell that this one finished.
insert into public.sf_migration_parts (part) values ('20260803003400-crm-foundation-part4')
  on conflict (part) do nothing;
