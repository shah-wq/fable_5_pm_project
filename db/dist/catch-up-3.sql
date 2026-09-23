-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · catch-up 3 of 3 · newest migration: 20260803004800_ai_automation.sql
--
-- Paste this whole file into a SQL console (e.g. the Neon SQL Editor) and run
-- it. Safe to run more than once: every statement below skips work already
-- done, so 'already exists' errors cannot happen. NOTICE lines saying
-- 'does not exist, skipping' are normal.
--
-- Run the catch-up files in order, each as its own execution: catch-up-1.sql, catch-up-2.sql, catch-up-3.sql.
-- Each break falls where one script adds a value to an enum and the next uses
-- it, which PostgreSQL will not allow in a single transaction.
-- Includes: 20260803003400_crm_foundation.sql, 20260803003500_deals.sql, 20260803003600_contact_intake.sql, 20260803003700_contact_create.sql, 20260803003800_contact_stages.sql, 20260803003900_contract_signed_system.sql, 20260803004000_project_holds_contact.sql, 20260803004100_signing_creates_project.sql, 20260803004200_sales_see_deal_projects.sql, 20260803004300_stage_upload_fix.sql, 20260803004400_esignature.sql, 20260803004500_sales_see_dealer_names.sql, 20260803004600_stage_fields_solar.sql, 20260803004700_notifications.sql, 20260803004800_ai_automation.sql, migration bookkeeping
-- ============================================================================

-- >>> 20260803003400_crm_foundation.sql

-- =============================================================================
-- Modules 16–19 · Part 2 and Part 10 — the CRM foundation
--
-- "This revises the CRM Module Specification to sit inside SolarFlow PM rather
-- than beside it. … There is no second person table, no second pipeline engine,
-- no second activity log, no second document store, no second notification
-- layer, no second reporting engine and no new login."
--
-- So this migration extends four tables, adds six, renames one, and adds a role.
-- It is deliberately the whole of Part 10 steps 1–5 in one file, because the
-- steps are only independently verifiable if they all exist: step 2 backfills
-- what step 1 adds, and step 4's compatibility view is what keeps the running
-- deployment alive while step 6 (the read cut-over, in the application) lands.
--
-- Nothing here changes an existing behaviour. Every new column is nullable or
-- defaulted, `leads` keeps working as a view, and the audit trigger writes the
-- same rows it wrote yesterday.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Prerequisites from earlier migrations
-- -----------------------------------------------------------------------------
-- 001900 (dealer portal) brings leads and commissions; 002400 brings the
-- customer-management columns this builds on. Guarded rather than assumed: a
-- database that skipped one of those should say so in one line instead of
-- failing forty statements later with a column that does not exist.
do $$
begin
  if to_regclass('public.leads') is null and to_regclass('public.deals') is null then
    raise exception 'Run 20260803001900_dealer_portal.sql first — leads is the table this renames.'
      using hint = 'If that file refuses too, this database is behind by more than one module: run db/dist/catch-up-1.sql, then catch-up-2.sql, then catch-up-3.sql, each as its own execution. They carry everything from 001400 onwards and are safe on a database that already has some of it.';
  end if;
  if to_regclass('public.clients') is null then
    raise exception 'Run 20260803000200_tables.sql first — clients is the person record this extends.'
      using hint = 'If that file refuses too, this database is behind by more than one module: run db/dist/catch-up-1.sql, then catch-up-2.sql, then catch-up-3.sql, each as its own execution. They carry everything from 001400 onwards and are safe on a database that already has some of it.';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 1. Capability flags (Part 8)
-- -----------------------------------------------------------------------------
-- The Sales role itself is added by 003300, which has to be its own script: a
-- new enum value cannot be used in the transaction that adds it, and every
-- policy below compares against it.
do $$
begin
  if not exists (select 1 from pg_enum e
                  join pg_type t on t.oid = e.enumtypid
                 where t.typname = 'user_role' and e.enumlabel = 'sales') then
    raise exception 'Run 20260803003300_add_sales_role.sql first, in its own script.'
      using hint = 'If that file refuses too, this database is behind by more than one module: run db/dist/catch-up-1.sql, then catch-up-2.sql, then catch-up-3.sql, each as its own execution. They carry everything from 001400 onwards and are safe on a database that already has some of it.';
  end if;
end
$$;

-- The flags live on the profile rather than in a roles table, because there are
-- five of them and they are per-user. deal_visibility is the one with three
-- values: Part 8 is explicit that whether reps see each other's numbers is a
-- cultural decision, so it is a setting and not a rule.
alter table public.profiles
  add column if not exists manage_all_deals    boolean not null default false,
  add column if not exists manage_marketing    boolean not null default false,
  add column if not exists manage_consent      boolean not null default false,
  add column if not exists deal_visibility     text not null default 'own'
    check (deal_visibility in ('own', 'team', 'all'));

/**
 * Capability lookups, in the same shape as app.is_admin().
 *
 * Admin holds every flag implicitly — Part 8: "Everything, including merge,
 * anonymise, consent overrides, reference lists and all capability flags."
 * Writing that here rather than ticking five boxes on every admin account is
 * what stops a new admin from being quietly less powerful than an old one.
 */
create or replace function app.has_capability(p_flag text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when app.current_user_role() = 'admin' then true
    else coalesce(
      (select case p_flag
                when 'manage_all_deals' then p.manage_all_deals
                when 'manage_marketing' then p.manage_marketing
                when 'manage_consent'   then p.manage_consent
                else false
              end
         from public.profiles p
        where p.id = (select auth.uid())),
      false)
  end;
$$;

/** Staff who work the sales side. Ops and admin see deals as part of the job. */
create or replace function app.is_sales_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.current_user_role() in ('admin', 'ops', 'sales');
$$;

-- -----------------------------------------------------------------------------
-- 2. Part 10 step 1 — additive columns
-- -----------------------------------------------------------------------------

-- EXTENDED · clients (the person record; already the spine, now complete)
alter table public.clients
  -- lifecycle is NOT a column. Part 2: "Never typed by hand: a manual lifecycle
  -- field goes stale inside a week and then quietly lies to every report built
  -- on it." It is derived in the view at the end of this file.
  add column if not exists source_id                uuid,
  add column if not exists owner_id                 uuid references public.profiles (id) on delete set null,
  add column if not exists preferred_name           text,
  add column if not exists salutation               text,
  add column if not exists do_not_email             boolean not null default false,
  add column if not exists do_not_call              boolean not null default false,
  add column if not exists do_not_sms               boolean not null default false,
  add column if not exists preferred_channel        text
    check (preferred_channel in ('email', 'phone', 'sms')),
  add column if not exists preferred_contact_time   text,
  add column if not exists last_activity_at         timestamptz,
  add column if not exists last_contacted_at        timestamptz,
  add column if not exists import_batch_id          uuid;

-- The one real change the extension requires (Part 2): "Today a client implies a
-- project; after this, a client with lifecycle prospect has none."
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'clients'
                and column_name = 'dealer_id' and is_nullable = 'NO') then
    alter table public.clients alter column dealer_id drop not null;
  end if;
end
$$;

-- EXTENDED · dealers (module 18 fields; the module adds the screens)
alter table public.dealers
  add column if not exists tier_id                uuid,
  add column if not exists territory              text,
  add column if not exists relationship_owner_id  uuid references public.profiles (id) on delete set null,
  add column if not exists agreement_document_id  uuid references public.documents (id) on delete set null,
  add column if not exists agreement_start        date,
  add column if not exists agreement_end          date,
  add column if not exists licence_number         text,
  add column if not exists licence_expiry         date,
  add column if not exists insurance_expiry       date,
  add column if not exists tax_form_on_file       boolean not null default false,
  add column if not exists onboarding_state       jsonb not null default '{}'::jsonb;

-- EXTENDED · projects — the origin link, immutable after conversion (Part 9).
alter table public.projects
  add column if not exists deal_id uuid;

-- -----------------------------------------------------------------------------
-- 3. Reference lists (Part 4, Part 5, Part 6)
-- -----------------------------------------------------------------------------
-- "Admin-managed and referenced by ID, per the master spec's rule on all
-- dropdown lists." Same shape as module_types and the rest, so the existing
-- admin entity screen can render them with no new code.
create table if not exists public.client_sources (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  is_active  boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.deal_loss_reasons (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  /** Internal reasons never reach the dealer portal (Part 5, Part 6). */
  internal_only boolean not null default false,
  is_active  boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.dealer_tiers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  /** May carry a commission default; the forward-only rule is in module 18. */
  commission_percent numeric(5,2),
  is_active  boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.competitors (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  is_active  boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.roof_types (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  is_active  boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'clients_source_id_fkey') then
    alter table public.clients
      add constraint clients_source_id_fkey
      foreign key (source_id) references public.client_sources (id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dealers_tier_id_fkey') then
    alter table public.dealers
      add constraint dealers_tier_id_fkey
      foreign key (tier_id) references public.dealer_tiers (id) on delete set null;
  end if;
end
$$;

-- The seeds are the spec's own lists (Part 4: "E-book download, web form, dealer
-- submission, referral, inbound call, event, campaign, import").
insert into public.client_sources (name, sort_order) values
  ('E-book download', 10), ('Web form', 20), ('Dealer submission', 30),
  ('Referral', 40), ('Inbound call', 50), ('Event', 60), ('Campaign', 70),
  ('Import', 80)
on conflict (name) do nothing;

insert into public.deal_loss_reasons (name, internal_only, sort_order) values
  ('Price', false, 10),
  ('Went with a competitor', false, 20),
  ('Roof not suitable', false, 30),
  ('Finance declined', false, 40),
  ('Timing — postponed', false, 50),
  ('Moving house', false, 60),
  ('Unresponsive', false, 70),
  ('Not a homeowner', false, 80),
  ('Poor fit — we declined', true, 90),
  ('Duplicate', true, 100)
on conflict (name) do nothing;

insert into public.roof_types (name, sort_order) values
  ('Asphalt shingle', 10), ('Tile', 20), ('Metal standing seam', 30),
  ('Flat / TPO', 40), ('Wood shake', 50), ('Slate', 60), ('Ground mount', 70)
on conflict (name) do nothing;

insert into public.dealer_tiers (name, sort_order) values
  ('Standard', 10), ('Preferred', 20), ('Strategic', 30)
on conflict (name) do nothing;

-- -----------------------------------------------------------------------------
-- 4. Part 10 step 2 and 3 — channels and addresses
-- -----------------------------------------------------------------------------
-- "The existing single email and phone columns stay populated as the primary
-- values so nothing that reads them breaks. New code reads the child tables.
-- This is what lets the migration be additive rather than a rewrite."
create table if not exists public.client_channels (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients (id) on delete cascade,
  kind             text not null check (kind in ('email', 'phone')),
  value            text not null,
  /** Lower-cased email / digits-only phone: what duplicate detection compares. */
  value_normalised text not null,
  type             text check (type in ('home', 'work', 'mobile', 'other')),
  is_primary       boolean not null default false,
  verified_at      timestamptz,
  /** Hard bounces land here as well as in suppression, so the record shows it. */
  bounce_state     text check (bounce_state in ('soft', 'hard', 'complained')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists client_channels_one_primary_idx
  on public.client_channels (client_id, kind) where is_primary;
create index if not exists client_channels_client_idx on public.client_channels (client_id);
create index if not exists client_channels_lookup_idx on public.client_channels (kind, value_normalised);

create table if not exists public.client_addresses (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients (id) on delete cascade,
  /** A property address is what a deal attaches to (Part 4). */
  kind            text not null check (kind in ('mailing', 'property')),
  lines           text not null,
  city            text,
  state           text,
  postal_code     text,
  lat             numeric(9,6),
  lng             numeric(9,6),
  jurisdiction_id uuid references public.jurisdictions (id) on delete set null,
  is_primary      boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists client_addresses_one_primary_idx
  on public.client_addresses (client_id, kind) where is_primary;
create index if not exists client_addresses_client_idx on public.client_addresses (client_id);

/**
 * Normalisation, in one place because duplicate detection and the uniqueness of
 * a channel both depend on agreeing about what "the same address" means.
 */
create or replace function app.normalise_channel(p_kind text, p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_value is null then null
    when p_kind = 'email' then lower(btrim(p_value))
    else regexp_replace(p_value, '[^0-9]', '', 'g')
  end;
$$;

create or replace function app.tg_channel_normalise()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.value_normalised := app.normalise_channel(new.kind, new.value);
  return new;
end;
$$;

drop trigger if exists channel_normalise on public.client_channels;
create trigger channel_normalise before insert or update on public.client_channels
  for each row execute function app.tg_channel_normalise();

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

-- A deal needs a human-readable handle for the same reason a project has one.
update public.deals set code = 'DEA-' || upper(substr(replace(id::text, '-', ''), 1, 8))
 where code is null;
alter table public.deals alter column code set default
  ('DEA-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)));
create unique index if not exists deals_code_idx on public.deals (code);

-- The migrated rows: "set every migrated row to stage New or Qualified depending
-- on its existing state". The old status vocabulary was submitted / under_review
-- / converted / declined.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'deals' and column_name = 'status') then
    update public.deals
       set stage = case status
                     when 'submitted'     then 'new'
                     when 'under_review'  then 'qualified'
                     when 'converted'     then 'won'
                     when 'declined'      then 'lost'
                     else 'new'
                   end
     where stage = 'new';
    update public.deals set project_id = converted_project_id
     where converted_project_id is not null and project_id is null;
    update public.deals set won_at = coalesce(won_at, updated_at) where stage = 'won';
    update public.deals set lost_at = coalesce(lost_at, updated_at) where stage = 'lost';
  end if;
end
$$;

-- Attribution: the dealer company and submitting user "are kept and become the
-- permanent attribution fields" (Part 2). dealer_id is nullable now because a
-- deal can also arrive from a web form with no dealer at all.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'deals'
                and column_name = 'dealer_id' and is_nullable = 'NO') then
    alter table public.deals alter column dealer_id drop not null;
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'deals'
                and column_name = 'address' and is_nullable = 'NO') then
    alter table public.deals alter column address drop not null;
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'deals'
                and column_name = 'customer_first' and is_nullable = 'NO') then
    alter table public.deals alter column customer_first drop not null;
    alter table public.deals alter column customer_last drop not null;
  end if;
end
$$;

-- The rename carries the old table's constraints, and one of them is now wrong.
-- `leads` required an email or a phone *on the row*, because a lead was a
-- standalone scrap of contact detail. A deal's person is the clients record, and
-- the channel lives there — so the rule becomes "reachable somehow": a linked
-- person, or a direct channel for a submission that has not been matched yet.
do $$
declare
  c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.deals'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%customer_email%'
  loop
    execute format('alter table public.deals drop constraint %I', c.conname);
  end loop;

  if not exists (select 1 from pg_constraint where conname = 'deals_reachable') then
    alter table public.deals
      add constraint deals_reachable
      check (client_id is not null
             or customer_email is not null
             or customer_phone is not null);
  end if;
end
$$;

create index if not exists deals_stage_idx on public.deals (stage, stage_entered_at desc);create index if not exists deals_owner_idx on public.deals (owner_id, stage);
create index if not exists deals_client_idx on public.deals (client_id);
create index if not exists deals_next_action_idx on public.deals (next_action_at)
  where stage not in ('won', 'lost');

-- The compatibility view: anything still saying `leads` keeps working for one
-- release. Read-only on purpose — a write path that still targets the old name
-- is a bug to find now, not to paper over.
do $$
begin
  if to_regclass('public.leads') is not null
     and (select relkind from pg_class where oid = to_regclass('public.leads')) = 'r' then
    -- The rename above did not happen (a database that already had deals), so
    -- leave the real table alone rather than shadowing it.
    return;
  end if;
  execute 'create or replace view public.leads as select * from public.deals';
  execute 'grant select on public.leads to authenticated';
end
$$;

-- -----------------------------------------------------------------------------
-- 6. Part 10 step 5 — the activity log gains two columns and a kind
-- -----------------------------------------------------------------------------
-- "One log renders the project audit trail, the customer Activity tab and the
-- deal timeline. A separate CRM would hold half of a person's history in a table
-- the project side cannot see."
alter table public.audit_log
  add column if not exists kind text not null default 'field_change'
    check (kind in ('call', 'email', 'sms', 'meeting', 'note', 'form', 'download',
                    'login', 'system', 'field_change', 'stage_move')),
  add column if not exists deal_id   uuid,
  add column if not exists client_id uuid;

create index if not exists audit_log_deal_idx on public.audit_log (deal_id, occurred_at desc);
create index if not exists audit_log_client_idx on public.audit_log (client_id, occurred_at desc);

-- -----------------------------------------------------------------------------
-- 7. The genuinely new tables (Part 2)
-- -----------------------------------------------------------------------------
create table if not exists public.deal_contacts (
  id        uuid primary key default gen_random_uuid(),
  deal_id   uuid not null references public.deals (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  /** "Most residential deals involve two people" (Part 5). */
  role      text not null default 'primary'
    check (role in ('primary', 'co_owner', 'decision_maker', 'referrer', 'dealer_rep')),
  created_at timestamptz not null default now(),
  unique (deal_id, client_id, role)
);
create index if not exists deal_contacts_client_idx on public.deal_contacts (client_id);

create table if not exists public.proposals (
  id            uuid primary key default gen_random_uuid(),
  deal_id       uuid not null references public.deals (id) on delete cascade,
  /** Versioned rows, not overwrites: "What did we quote them in March?" */
  version       integer not null,
  document_id   uuid references public.documents (id) on delete set null,
  sent_at       timestamptz,
  viewed_at     timestamptz,
  gross_price   numeric(12,2),
  incentives    numeric(12,2),
  net_price     numeric(12,2),
  monthly_payment numeric(10,2),
  notes         text,
  superseded_by_id uuid references public.proposals (id) on delete set null,
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (deal_id, version)
);

create table if not exists public.lists (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique,
  description    text,
  /** Double opt-in is on by default and configurable per list (Part 7). */
  double_optin   boolean not null default true,
  /** Sunset policy: months of no engagement before re-permission. */
  sunset_months  integer not null default 12,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.lead_magnets (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  version      text,
  list_id      uuid references public.lists (id) on delete set null,
  document_id  uuid references public.documents (id) on delete set null,
  download_count integer not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients (id) on delete cascade,
  list_id         uuid not null references public.lists (id) on delete cascade,
  lead_magnet_id  uuid references public.lead_magnets (id) on delete set null,
  status          text not null default 'pending'
    check (status in ('pending', 'subscribed', 'unsubscribed', 'bounced',
                      'complained', 'suppressed')),
  -- "Recorded at the moment of consent because it cannot be assembled
  -- afterwards. This is the record produced if someone complains."
  consent_basis   text not null default 'consent'
    check (consent_basis in ('consent', 'legitimate_interest', 'contract', 'imported')),
  consent_at      timestamptz not null default now(),
  consent_source  text,
  consent_ip      inet,
  consent_statement_text text,
  double_optin_confirmed_at timestamptz,
  confirm_token_hash text,
  unsubscribed_at timestamptz,
  sends           integer not null default 0,
  opens           integer not null default 0,
  clicks          integer not null default 0,
  last_engaged_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (client_id, list_id)
);
create index if not exists subscriptions_list_idx on public.subscriptions (list_id, status);

-- "Hard bounces, complaints, unsubscribes and manual suppressions in one set
-- that every send checks, marketing and transactional alike."
create table if not exists public.suppression (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null default 'email' check (kind in ('email', 'phone')),
  value_normalised text not null,
  reason           text not null
    check (reason in ('unsubscribed', 'hard_bounce', 'complaint', 'manual', 'sunset', 'deleted')),
  notes            text,
  created_by       uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (kind, value_normalised)
);

-- -----------------------------------------------------------------------------
-- 8. Lifecycle, derived (Part 2)
-- -----------------------------------------------------------------------------
/**
 * "Prospect if no project, customer if any live project, past customer if all
 * projects are complete or cancelled."
 *
 * A function rather than a column, and a view over it rather than a join every
 * caller writes by hand.
 */
create or replace function public.client_lifecycle(p_client uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not exists (select 1 from public.projects p where p.client_id = p_client)
      then 'prospect'
    when exists (select 1 from public.projects p
                  where p.client_id = p_client
                    and p.status not in ('complete', 'cancelled'))
      then 'customer'
    else 'past_customer'
  end;
$$;

-- security_invoker so the reader's own RLS on clients decides which rows they
-- see — the view adds the roll-ups, never access.
create or replace view public.people_overview
with (security_invoker = true) as
select c.id,
       c.first_name,
       c.last_name,
       coalesce(c.preferred_name, c.first_name) as display_first,
       c.email,
       c.phone,
       c.dealer_id,
       c.owner_id,
       c.source_id,
       c.is_archived,
       c.created_at,
       c.last_activity_at,
       c.last_contacted_at,
       public.client_lifecycle(c.id) as lifecycle,
       (select count(*) from public.projects p where p.client_id = c.id) as project_count,
       (select count(*) from public.deals d where d.client_id = c.id) as deal_count,
       (select count(*) from public.deals d
         where d.client_id = c.id and d.stage not in ('won', 'lost')) as open_deal_count,
       (select count(*) from public.subscriptions s
         where s.client_id = c.id and s.status = 'subscribed') as subscription_count,
       c.do_not_email,
       c.do_not_call,
       c.do_not_sms
  from public.clients c;

grant select on public.people_overview to authenticated;

-- -----------------------------------------------------------------------------
-- 9. RLS — "new policies, same model" (Part 3)
-- -----------------------------------------------------------------------------
alter table public.client_channels enable row level security;
alter table public.client_addresses enable row level security;
alter table public.deal_contacts enable row level security;
alter table public.proposals enable row level security;
alter table public.subscriptions enable row level security;
alter table public.lists enable row level security;
alter table public.lead_magnets enable row level security;
alter table public.suppression enable row level security;
alter table public.client_sources enable row level security;
alter table public.deal_loss_reasons enable row level security;
alter table public.dealer_tiers enable row level security;
alter table public.competitors enable row level security;
alter table public.roof_types enable row level security;

grant select, insert, update, delete on
  public.client_channels, public.client_addresses, public.deal_contacts,
  public.proposals, public.subscriptions, public.lists, public.lead_magnets,
  public.suppression
to authenticated;
grant select on
  public.client_sources, public.deal_loss_reasons, public.dealer_tiers,
  public.competitors, public.roof_types
to authenticated;
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
drop policy if exists subscriptions_write on public.subscriptions;
create policy subscriptions_write on public.subscriptions
  for all to authenticated
  using (app.has_capability('manage_marketing') or app.has_capability('manage_consent'))
  with check (app.has_capability('manage_marketing') or app.has_capability('manage_consent'));

do $$
declare
  t text;
begin
  foreach t in array array['lists', 'lead_magnets'] loop
    execute format('drop policy if exists %1$s_select on public.%1$s', t);
    execute format($p$
      create policy %1$s_select on public.%1$s
        for select to authenticated using (true)
    $p$, t);
    execute format('drop policy if exists %1$s_write on public.%1$s', t);
    execute format($p$
      create policy %1$s_write on public.%1$s
        for all to authenticated
        using (app.has_capability('manage_marketing'))
        with check (app.has_capability('manage_marketing'))
    $p$, t);
  end loop;

  -- The reference lists: everyone reads, admin writes, exactly like the lists
  -- the master spec already has.
  foreach t in array array['client_sources', 'deal_loss_reasons', 'dealer_tiers',
                           'competitors', 'roof_types'] loop
    execute format('drop policy if exists %1$s_select on public.%1$s', t);
    execute format($p$
      create policy %1$s_select on public.%1$s
        for select to authenticated using (true)
    $p$, t);
    execute format('drop policy if exists %1$s_write on public.%1$s', t);
    execute format($p$
      create policy %1$s_write on public.%1$s
        for all to authenticated
        using ((select app.is_admin())) with check ((select app.is_admin()))
    $p$, t);
  end loop;
end
$$;

drop policy if exists suppression_select on public.suppression;
create policy suppression_select on public.suppression
  for select to authenticated
  using (app.is_sales_staff() or app.has_capability('manage_marketing'));
drop policy if exists suppression_write on public.suppression;
create policy suppression_write on public.suppression
  for all to authenticated
  using (app.has_capability('manage_consent'))
  with check (app.has_capability('manage_consent'));

-- The Sales role reads what it needs on the project side: Part 8 gives it
-- "read-only on projects that came from their own deals".
drop policy if exists projects_select_sales on public.projects;
create policy projects_select_sales on public.projects
  for select to authenticated
  using (
    (select app.current_user_role()) = 'sales'
    and exists (select 1 from public.deals d
                 where d.project_id = projects.id
                   and (d.owner_id = (select auth.uid())
                        or app.has_capability('manage_all_deals')))
  );

-- And a person: sales staff read every person, because a deal without its
-- person is unusable. Writes stay where they were.
drop policy if exists clients_select_sales on public.clients;
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



-- >>> 20260803003500_deals.sql

-- =============================================================================
-- Modules 16–19 · Part 5 and Part 9 — deals, proposals and the Won handoff
-- =============================================================================
-- 003400 gave deals their columns. This gives them the two things that cannot
-- live in the application: an activity writer that can attribute a row to a
-- deal or a person, and a conversion that either produces a project and a won
-- deal together or produces neither.
--
-- Part 9: "Transactional. If the project insert fails the deal does not move and
-- the user is told why. A half-converted deal is the worst available state and
-- is prevented at the database rather than repaired by a support script."
-- =============================================================================

do $$
begin
  if to_regclass('public.deals') is null then
    raise exception 'Run 20260803003400_crm_foundation.sql first — it creates deals.'
      using hint = 'If that file refuses too, this database is behind by more than one module: run db/dist/catch-up-1.sql, then catch-up-2.sql, then catch-up-3.sql, each as its own execution. They carry everything from 001400 onwards and are safe on a database that already has some of it.';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 1. The activity writer, extended
-- -----------------------------------------------------------------------------
-- The existing five-argument log_audit_event stays exactly as it is: every
-- caller in the product uses it and none of them knows about deals. This is an
-- overload, so a CRM caller can attribute a row to a deal or a person and get
-- the same immutability, the same actor resolution and the same table.
create or replace function public.log_audit_event(
  p_action      text,
  p_entity_type text,
  p_entity_id   text,
  p_project_id  uuid,
  p_context     jsonb,
  p_kind        text,
  p_deal_id     uuid,
  p_client_id   uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if p_kind is not null and p_kind not in
     ('call', 'email', 'sms', 'meeting', 'note', 'form', 'download',
      'login', 'system', 'field_change', 'stage_move') then
    raise exception 'unknown activity kind %', p_kind using errcode = '22023';
  end if;

  insert into public.audit_log
    (actor_id, actor_role, action, entity_type, entity_id, project_id, context,
     kind, deal_id, client_id)
  values
    ((select auth.uid()), app.current_user_role(), p_action, p_entity_type,
     p_entity_id, p_project_id, coalesce(p_context, '{}'::jsonb),
     coalesce(p_kind, 'field_change'), p_deal_id, p_client_id)
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function
  public.log_audit_event(text, text, text, uuid, jsonb, text, uuid, uuid) from public, anon;
grant execute on function
  public.log_audit_event(text, text, text, uuid, jsonb, text, uuid, uuid) to authenticated;

-- The CRM half of the timeline has to be readable by the people who write it.
-- audit_log is admin-only, and deliberately so — it is the tamper-evident record
-- of who changed what. But Part 3 puts the deal timeline in that same table
-- ("One log renders the project audit trail, the customer Activity tab and the
-- deal timeline"), and a timeline only an admin can read is not a timeline. So
-- the rows that belong to a deal or a person are readable by the staff who work
-- them; everything else stays exactly as locked as it was.
drop policy if exists audit_log_select_crm on public.audit_log;
create policy audit_log_select_crm on public.audit_log
  for select to authenticated
  using (
    (deal_id is not null or client_id is not null)
    and app.is_sales_staff()
  );

-- Contact is a fact about the deal, not only a row in the log. Part 5 gates the
-- move out of New on it, and that gate has to be answerable from the deal row:
-- a board that asks the audit log per card would be both slow and — for anyone
-- who cannot read that table — wrong.
alter table public.deals
  add column if not exists first_contact_at timestamptz,
  add column if not exists last_contact_at  timestamptz,
  add column if not exists contact_count    integer not null default 0;

/**
 * Log an interaction against a deal, and record what it proves.
 *
 * `p_reached` is the difference between a conversation and an attempt: "A
 * voicemail is an attempt, logged as an activity; the deal stays in New."
 */
create or replace function public.log_deal_contact(
  p_deal    uuid,
  p_kind    text,
  p_note    text,
  p_reached boolean
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client uuid;
  v_id     bigint;
begin
  if not app.is_sales_staff() then
    raise exception 'only the sales team may log against a deal' using errcode = '42501';
  end if;

  select client_id into v_client from public.deals where id = p_deal;
  if not found then
    raise exception 'that deal no longer exists' using errcode = 'P0002';
  end if;

  v_id := public.log_audit_event(
    p_note, 'deals', p_deal::text, null,
    jsonb_build_object('reached', coalesce(p_reached, false)),
    case when coalesce(p_reached, false) then p_kind else 'note' end,
    p_deal, v_client);

  if coalesce(p_reached, false) then
    update public.deals
       set first_contact_at = coalesce(first_contact_at, now()),
           last_contact_at = now(),
           contact_count = contact_count + 1
     where id = p_deal;
  end if;

  return v_id;
end;
$$;

revoke execute on function public.log_deal_contact(uuid, text, text, boolean) from public, anon;
grant execute on function public.log_deal_contact(uuid, text, text, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Proposals are versioned, never overwritten (Part 5)
-- -----------------------------------------------------------------------------
-- "Versioned rows, not overwrites, each with its document, sent and viewed
-- dates. 'What did we quote them in March?' has to have an answer."
create or replace function public.add_proposal(
  p_deal        uuid,
  p_gross       numeric,
  p_incentives  numeric,
  p_net         numeric,
  p_monthly     numeric,
  p_document    uuid,
  p_notes       text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version integer;
  v_id      uuid;
begin
  if not app.is_sales_staff() then
    raise exception 'only the sales team may quote a deal' using errcode = '42501';
  end if;
  if not exists (select 1 from public.deals d where d.id = p_deal) then
    raise exception 'that deal no longer exists' using errcode = 'P0002';
  end if;

  select coalesce(max(version), 0) + 1 into v_version
    from public.proposals where deal_id = p_deal;

  insert into public.proposals
    (deal_id, version, document_id, gross_price, incentives, net_price,
     monthly_payment, notes, created_by)
  values
    (p_deal, v_version, p_document, p_gross, p_incentives, p_net,
     p_monthly, p_notes, (select auth.uid()))
  returning id into v_id;

  -- The previous version is superseded rather than deleted, so the history
  -- reads as a sequence of offers instead of a single mutable number.
  update public.proposals
     set superseded_by_id = v_id
   where deal_id = p_deal and version = v_version - 1;

  -- The deal's headline price follows its newest proposal.
  update public.deals
     set gross_price = coalesce(p_gross, gross_price),
         incentives = coalesce(p_incentives, incentives),
         net_price = coalesce(p_net, net_price),
         monthly_payment = coalesce(p_monthly, monthly_payment)
   where id = p_deal;

  return v_id;
end;
$$;

revoke execute on function
  public.add_proposal(uuid, numeric, numeric, numeric, numeric, uuid, text) from public, anon;
grant execute on function
  public.add_proposal(uuid, numeric, numeric, numeric, numeric, uuid, text) to authenticated;

/** Marking a proposal sent is its own step: a draft is not an offer. */
create or replace function public.mark_proposal_sent(p_proposal uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  if not app.is_sales_staff() then
    raise exception 'only the sales team may send a proposal' using errcode = '42501';
  end if;
  update public.proposals set sent_at = coalesce(sent_at, now())
   where id = p_proposal
  returning sent_at into v_at;
  if not found then
    raise exception 'that proposal no longer exists' using errcode = 'P0002';
  end if;
  return v_at;
end;
$$;

revoke execute on function public.mark_proposal_sent(uuid) from public, anon;
grant execute on function public.mark_proposal_sent(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 2b. A document can belong to a deal or a dealer, not only a project (Part 3)
-- -----------------------------------------------------------------------------
-- "Module 5 already does versioning and per-document visibility flags defaulting
-- to hidden. Proposals, contracts and dealer agreements are documents with a
-- deal_id or dealer_id instead of a project_id. On conversion, the signed
-- contract already sits where the project expects it — no copy, no second store,
-- no divergent visibility rules."
--
-- Which needs project_id to be nullable. It has been NOT NULL since 000200,
-- because until now every document was about a job.
alter table public.documents
  add column if not exists deal_id   uuid references public.deals (id) on delete cascade,
  add column if not exists dealer_id uuid references public.dealers (id) on delete cascade;

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'documents'
                and column_name = 'project_id' and is_nullable = 'NO') then
    alter table public.documents alter column project_id drop not null;
  end if;

  -- A document still has to be about something. Without this, a null in every
  -- relation makes a file nobody can find and nobody can delete.
  if not exists (select 1 from pg_constraint where conname = 'documents_belong_somewhere') then
    alter table public.documents
      add constraint documents_belong_somewhere
      check (project_id is not null or deal_id is not null or dealer_id is not null);
  end if;
end
$$;

create index if not exists documents_deal_idx on public.documents (deal_id);
create index if not exists documents_dealer_idx on public.documents (dealer_id);

-- The existing policies are all written against project_id, and a null there
-- fails app.can_access_project() — so these are *additional* permissive
-- policies covering the two new owners. The project rules are untouched.
drop policy if exists documents_select_crm on public.documents;
create policy documents_select_crm on public.documents
  for select to authenticated
  using (
    ((deal_id is not null or dealer_id is not null) and app.is_sales_staff())
    -- A dealer sees their own agreements and their own submissions' documents,
    -- under the same hard exclusions the portal already applies.
    or (dealer_id is not null and dealer_id in (select app.current_dealer_ids()))
    or (deal_id is not null and exists (
          select 1 from public.deals d
           where d.id = documents.deal_id
             and d.dealer_id in (select app.current_dealer_ids())))
  );

drop policy if exists documents_write_crm on public.documents;
create policy documents_write_crm on public.documents
  for all to authenticated
  using ((deal_id is not null or dealer_id is not null) and app.is_sales_staff())
  with check ((deal_id is not null or dealer_id is not null) and app.is_sales_staff());

-- -----------------------------------------------------------------------------
-- 3. Won becomes a project, or nothing happens (Part 9)
-- -----------------------------------------------------------------------------
create or replace function public.convert_deal_to_project(
  p_deal  uuid,
  p_stage public.project_stage default 'survey'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  d           public.deals;
  v_client    uuid;
  v_address   text;
  v_project   uuid;
  v_name      text;
begin
  if not app.is_sales_staff() then
    raise exception 'only the sales team may convert a deal' using errcode = '42501';
  end if;

  select * into d from public.deals where id = p_deal for update;
  if not found then
    raise exception 'that deal no longer exists' using errcode = 'P0002';
  end if;

  -- Idempotent: a second press of a button that already worked returns the
  -- project it already made rather than making another one.
  if d.project_id is not null then
    return d.project_id;
  end if;

  -- The person is the same clients row, "whose lifecycle flips from prospect to
  -- customer with no copying at all". A deal that arrived as a dealer
  -- submission may have no person yet, so one is created from what it carries.
  v_client := d.client_id;
  if v_client is null then
    if coalesce(btrim(d.customer_first), '') = ''
       or coalesce(btrim(d.customer_last), '') = '' then
      raise exception 'a project needs a first and last name' using errcode = '23514';
    end if;
    insert into public.clients (dealer_id, first_name, last_name, email, phone, source_id)
    values (d.dealer_id, btrim(d.customer_first), btrim(d.customer_last),
            d.customer_email, d.customer_phone, d.source_id)
    returning id into v_client;

    if d.customer_email is not null then
      insert into public.client_channels (client_id, kind, value, value_normalised, is_primary)
      values (v_client, 'email', d.customer_email, '', true)
      on conflict do nothing;
    end if;
    if d.customer_phone is not null then
      insert into public.client_channels (client_id, kind, value, value_normalised, is_primary)
      values (v_client, 'phone', d.customer_phone, '', true)
      on conflict do nothing;
    end if;

    update public.deals set client_id = v_client where id = p_deal;
  end if;

  -- "Property address becomes site address."
  select coalesce(a.lines, d.address) into v_address
    from (select 1) _
    left join public.client_addresses a on a.id = d.property_address_id;
  if coalesce(btrim(v_address), '') = '' then
    raise exception 'a project needs a site address' using errcode = '23514';
  end if;

  if d.dealer_id is null then
    raise exception 'a project needs a dealer' using errcode = '23514';
  end if;

  select c.first_name || ' ' || c.last_name into v_name
    from public.clients c where c.id = v_client;

  -- Everything the proposal already decided pre-fills the specification, and
  -- the contract value becomes the contract total. Nothing else is required:
  -- "a Friday-evening signature is never blocked by a missing module selection".
  insert into public.projects
    (name, address, dealer_id, client_id, stage, status, contract_value,
     system_size_kw, module_type_id, inverter_type_id, battery_type_id,
     battery_quantity, financing_company_id, utility_id, deal_id, created_by)
  values
    (v_name, btrim(v_address), d.dealer_id, v_client, p_stage, 'active',
     coalesce(d.contract_value, d.net_price),
     d.system_size_kw, d.module_id, d.inverter_id, d.battery_id,
     d.battery_qty, d.financing_company_id, d.utility_id, p_deal,
     (select auth.uid()))
  returning id into v_project;

  -- "Documents are already filed and simply gain the project relation." No
  -- copying, no second store: the same row, one more foreign key.
  update public.documents
     set project_id = v_project
   where project_id is null
     and deal_id = p_deal;

  update public.deals
     set project_id = v_project,
         stage = 'won',
         won_at = coalesce(won_at, now()),
         client_id = v_client
   where id = p_deal;

  perform public.log_audit_event(
    'deal.converted', 'deals', p_deal::text, v_project,
    jsonb_build_object('project_id', v_project, 'client_id', v_client),
    'stage_move', p_deal, v_client);

  return v_project;
end;
$$;

revoke execute on function public.convert_deal_to_project(uuid, public.project_stage)
  from public, anon;
grant execute on function public.convert_deal_to_project(uuid, public.project_stage)
  to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Attribution does not move (Part 6, Part 9)
-- -----------------------------------------------------------------------------
-- "Originating dealer company and submitting user recorded on every deal and
-- carried to the project, editable afterwards only by an admin with a reason.
-- Commission and performance reporting both depend on this not moving."
create or replace function app.tg_project_deal_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.deal_id is not null and new.deal_id is distinct from old.deal_id
     and not app.is_admin() then
    raise exception 'a project''s originating deal cannot be changed'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists project_deal_immutable on public.projects;
create trigger project_deal_immutable before update on public.projects
  for each row execute function app.tg_project_deal_immutable();

-- A won deal is read-only apart from the fields that describe its outcome.
create or replace function app.tg_deal_won_readonly()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.stage = 'won' and not app.is_admin() then
    if new.stage is distinct from old.stage then
      raise exception 'a deal cannot be un-won — cancel the project instead'
        using errcode = '42501';
    end if;
    if new.contract_value is distinct from old.contract_value
       or new.client_id is distinct from old.client_id
       or new.dealer_id is distinct from old.dealer_id then
      raise exception 'a won deal''s contract and attribution are fixed'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists deal_won_readonly on public.deals;
create trigger deal_won_readonly before update on public.deals
  for each row execute function app.tg_deal_won_readonly();

-- -----------------------------------------------------------------------------
-- 5. The board's roll-ups (Part 5: "Column headers carry count and total value")
-- -----------------------------------------------------------------------------
create or replace view public.deal_stage_totals
with (security_invoker = true) as
select d.stage,
       count(*) as deals,
       sum(coalesce(d.contract_value, d.net_price, 0)) as total_value,
       sum(coalesce(d.contract_value, d.net_price, 0)
           * coalesce(d.probability, 0) / 100.0) as weighted_value
  from public.deals d
 group by d.stage;

grant select on public.deal_stage_totals to authenticated;

-- Deals needing action: no next action, or one that is due (Part 5). The same
-- shape as the project board's attention list, computed the same way.
create or replace view public.deals_needing_action
with (security_invoker = true) as
select d.id, d.code, d.stage, d.owner_id, d.next_action, d.next_action_at,
       coalesce(c.first_name || ' ' || c.last_name,
                nullif(btrim(coalesce(d.customer_first, '') || ' ' ||
                             coalesce(d.customer_last, '')), ''),
                'Unnamed') as person_name,
       case when d.next_action is null or d.next_action_at is null then 'no next action'
            else 'next action due' end as reason
  from public.deals d
  left join public.clients c on c.id = d.client_id
 where d.stage not in ('won', 'lost')
   and (d.next_action is null
        or d.next_action_at is null
        or d.next_action_at <= current_date);

grant select on public.deals_needing_action to authenticated;



-- >>> 20260803003600_contact_intake.sql

-- =============================================================================
-- Modules 16–19 · the contact intake fields
-- =============================================================================
-- The fields a rep fills in on a contact: identity and mailing on the person,
-- and the solar/commercial detail on the deal.
--
-- Why the split rather than putting all fifty on clients: a person can have two
-- properties and two deals, and "System size" then has two answers. The person
-- record holds what is true about the person; the deal holds what is true about
-- one opportunity. The Contacts screen shows both together against the deal
-- being worked, which is what the request actually asks for — one screen with
-- every field on it.
--
-- Everything here is additive and nullable. Nothing is required, because an
-- intake form that refuses to save half-known information is a form people keep
-- in a spreadsheet instead.
-- =============================================================================

do $$
begin
  if to_regclass('public.deals') is null then
    raise exception 'Run 20260803003400_crm_foundation.sql first — it creates deals.'
      using hint = 'If that file refuses too, this database is behind by more than one module: run db/dist/catch-up-1.sql, then catch-up-2.sql, then catch-up-3.sql, each as its own execution. They carry everything from 001400 onwards and are safe on a database that already has some of it.';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 1. The person
-- -----------------------------------------------------------------------------
alter table public.clients
  -- Contact owner and lead source already exist (owner_id, source_id).
  add column if not exists created_by       uuid references public.profiles (id) on delete set null,
  /** Free text about the person, distinct from internal_notes: this one is the
      description a rep writes, not the PM's private note. */
  add column if not exists description      text,
  /** The property owner's number, when the contact is not the owner — a spouse,
      an adult child, a landlord. Kept apart from phone so neither overwrites
      the other during a merge. */
  add column if not exists owner_phone      text,
  -- Mailing address, in the parts a mail merge needs. clients.mailing_address
  -- stays as the single-line legacy value and is kept in step by the trigger
  -- below, so anything already reading it keeps working.
  add column if not exists mailing_street   text,
  add column if not exists mailing_city     text,
  add column if not exists mailing_state    text,
  add column if not exists mailing_postal_code text,
  add column if not exists mailing_country  text;

/**
 * One address, two shapes. The parts are what the form edits; the single line is
 * what every existing query and export already reads.
 */
create or replace function app.tg_client_mailing_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line text;
begin
  if new.mailing_street is distinct from old.mailing_street
     or new.mailing_city is distinct from old.mailing_city
     or new.mailing_state is distinct from old.mailing_state
     or new.mailing_postal_code is distinct from old.mailing_postal_code
     or new.mailing_country is distinct from old.mailing_country
     or old.id is null then
    v_line := nullif(
      btrim(concat_ws(', ',
        nullif(btrim(coalesce(new.mailing_street, '')), ''),
        nullif(btrim(coalesce(new.mailing_city, '')), ''),
        nullif(btrim(coalesce(new.mailing_state, '')), ''),
        nullif(btrim(coalesce(new.mailing_postal_code, '')), ''),
        nullif(btrim(coalesce(new.mailing_country, '')), ''))),
      '');
    if v_line is not null then
      new.mailing_address := v_line;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists client_mailing_line on public.clients;
create trigger client_mailing_line before insert or update on public.clients
  for each row execute function app.tg_client_mailing_line();

-- Created-by is filled going forward; existing rows keep a null rather than a
-- guess, because a wrong attribution is worse than an absent one.
create or replace function app.tg_client_created_by()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.created_by is null then
    new.created_by := (select auth.uid());
  end if;
  return new;
end;
$$;

drop trigger if exists client_created_by on public.clients;
create trigger client_created_by before insert on public.clients
  for each row execute function app.tg_client_created_by();

-- -----------------------------------------------------------------------------
-- 2. The deal — system, documents-adjacent detail, and the money
-- -----------------------------------------------------------------------------
alter table public.deals
  -- System. Brand columns already exist as references to the admin lists
  -- (module_id, inverter_id, battery_id); these are the numbers beside them.
  add column if not exists module_quantity      integer check (module_quantity >= 0),
  add column if not exists module_wattage       integer check (module_wattage >= 0),
  add column if not exists inverter_size_kw     numeric(8,3),
  add column if not exists battery_size_kwh     numeric(8,2),
  add column if not exists includes_battery     boolean,
  add column if not exists mount_type           text
    check (mount_type in ('rooftop', 'ground', 'both')),
  /** Yes / no / unknown rather than a boolean: "we have not asked yet" is the
      commonest answer at this stage and it is not the same as no. */
  add column if not exists hoa                  text
    check (hoa in ('yes', 'no', 'unknown')),
  add column if not exists comparable_brand_ok  boolean,

  -- Money. gross_price is the system price; the rest is how it is being paid.
  add column if not exists down_payment         numeric(12,2),
  add column if not exists amount_financed      numeric(12,2),

  -- Attribution and notes.
  add column if not exists dealer_code          text,
  add column if not exists wave_sales_notes     text,
  add column if not exists additional_information text,
  add column if not exists reschedule_reason    text;

/**
 * "System includes battery?" answers itself when a quantity is known, and is
 * only asked when it is not. Kept in the database so the answer is the same in
 * a report as it is on the screen.
 */
create or replace function app.tg_deal_battery_flag()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.battery_qty is not null and new.battery_qty > 0 then
    new.includes_battery := true;
  elsif new.battery_qty = 0 then
    new.includes_battery := false;
  end if;
  return new;
end;
$$;

drop trigger if exists deal_battery_flag on public.deals;
create trigger deal_battery_flag before insert or update on public.deals
  for each row execute function app.tg_deal_battery_flag();

-- -----------------------------------------------------------------------------
-- 3. The intake documents
-- -----------------------------------------------------------------------------
-- Categories are text on public.documents, so these need no schema change —
-- but they do need to exist as a list somewhere the application and a human can
-- both read, and this is the file that introduces them:
--
--   solar_proposal              Updated solar proposal
--   electricity_bill_front      Updated electricity bill (front)
--   electricity_bill_back       Updated electricity bill (back)
--   electric_bill               Electric bill
--   signed_installation_agreement  Updated signed solar installation agreement
--   electrical_panel            Updated electrical panel
--   electrical_meter            Updated electrical meter
--   dealer_code_form            Dealer code form
--
-- They attach to a deal (documents.deal_id, added in 003500) and gain the
-- project relation on conversion, so nothing is re-uploaded after a sale.
-- Every one of them defaults to customer_visible = false, like every other
-- document in the product.

create index if not exists documents_deal_category_idx
  on public.documents (deal_id, category) where deal_id is not null;

/**
 * Filing one of them. The deal twin of record_staff_upload(): same buckets,
 * same size and type rules, same hidden-by-default visibility — the only
 * difference is which column the document hangs off, because there is no
 * project yet.
 */
create or replace function public.record_deal_document(
  p_deal     uuid,
  p_category text,
  p_filename text,
  p_mime     text,
  p_data     bytea
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_path text;
  v_object_id uuid;
  v_document_id uuid;
  v_bucket text;
begin
  if not app.is_sales_staff() then
    raise exception 'only the sales team may file documents on a deal' using errcode = '42501';
  end if;
  if not exists (select 1 from public.deals d where d.id = p_deal) then
    raise exception 'that deal no longer exists' using errcode = 'P0002';
  end if;
  if p_category is null or btrim(p_category) = '' then
    raise exception 'category is required';
  end if;
  if p_mime not in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
                    'application/pdf') then
    raise exception 'only photos and PDFs are accepted';
  end if;
  if p_data is null or octet_length(p_data) = 0 or octet_length(p_data) > 26214400 then
    raise exception 'file must be between 1 byte and 25 MB';
  end if;

  v_name := coalesce(nullif(regexp_replace(coalesce(p_filename, ''), '[^\w.\-]+', '_', 'g'), ''), 'file');
  v_name := right(v_name, 100);
  v_path := 'deal/' || p_deal || '/' || p_category || '/'
            || floor(extract(epoch from clock_timestamp()) * 1000)::bigint || '-' || v_name;
  v_bucket := case when p_mime = 'application/pdf' then 'project-deliverables' else 'project-photos' end;

  insert into storage.objects (bucket_id, name, owner)
  values (v_bucket, v_path, (select auth.uid()))
  returning id into v_object_id;

  insert into storage.object_data (object_id, data) values (v_object_id, p_data);

  insert into public.documents
    (deal_id, bucket, object_path, kind, category, title, mime_type, size_bytes,
     customer_visible, uploaded_by)
  values
    (p_deal, v_bucket, v_path,
     (case when p_mime = 'application/pdf' then 'pdf' else 'photo' end)::public.document_kind,
     btrim(p_category), p_filename, p_mime, octet_length(p_data), false, (select auth.uid()))
  returning id into v_document_id;

  perform public.log_audit_event(
    'document.uploaded', 'documents', v_document_id::text, null,
    jsonb_build_object('category', p_category, 'filename', p_filename),
    'form', p_deal, (select client_id from public.deals where id = p_deal));

  return v_document_id;
end;
$$;

revoke execute on function public.record_deal_document(uuid, text, text, text, bytea)
  from public, anon;
grant execute on function public.record_deal_document(uuid, text, text, text, bytea)
  to authenticated;

-- -----------------------------------------------------------------------------
-- 4. One row per contact for the screen and the report builder
-- -----------------------------------------------------------------------------
/**
 * The person, plus the deal a rep is most likely to mean: the newest open one,
 * falling back to the newest of any kind. A contact with two live deals is
 * ambiguous by nature, so the screen lets them switch — this view is what it
 * opens on, and what a report reads when it asks for "the contact's system
 * size" without naming a deal.
 */
-- Dropped first rather than replaced: create or replace view can only append
-- columns, so a later migration that adds one in the middle would make this file
-- un-runnable the second time. Migrations are pasted in order, so the last file
-- to define this view is the one whose shape survives.
drop view if exists public.contact_intake;

create view public.contact_intake
with (security_invoker = true) as
select c.id as client_id,
       c.first_name, c.last_name, c.email, c.phone, c.owner_phone,
       c.mailing_street, c.mailing_city, c.mailing_state,
       c.mailing_postal_code, c.mailing_country, c.description,
       coalesce(owner.full_name, owner.email) as contact_owner,
       coalesce(creator.full_name, creator.email) as created_by_name,
       src.name as lead_source,
       dl.name as dealer_name,
       d.id as deal_id, d.code as deal_code, d.stage as lead_status,
       d.system_size_kw, d.module_quantity, d.module_wattage,
       d.battery_qty, d.battery_size_kwh, d.includes_battery,
       d.inverter_size_kw, d.mount_type, d.hoa, d.comparable_brand_ok,
       d.annual_usage_kwh, d.production_estimate_kwh, d.avg_monthly_bill,
       d.gross_price, d.contract_value, d.down_payment, d.amount_financed,
       d.financing_route, d.dealer_code, d.wave_sales_notes,
       d.additional_information, d.reschedule_reason,
       mod.name as module_brand, inv.name as inverter_brand, bat.name as battery_brand,
       fin.name as financing_company, u.name as electric_utility,
       lr.name as lost_reason
  from public.clients c
  left join public.profiles owner on owner.id = c.owner_id
  left join public.profiles creator on creator.id = c.created_by
  left join public.client_sources src on src.id = c.source_id
  left join public.dealers dl on dl.id = c.dealer_id
  left join lateral (
    select * from public.deals dd
     where dd.client_id = c.id
     order by (dd.stage not in ('won', 'lost')) desc, dd.updated_at desc
     limit 1
  ) d on true
  left join public.module_types mod on mod.id = d.module_id
  left join public.inverter_types inv on inv.id = d.inverter_id
  left join public.battery_types bat on bat.id = d.battery_id
  left join public.financing_companies fin on fin.id = d.financing_company_id
  left join public.utilities u on u.id = d.utility_id
  left join public.deal_loss_reasons lr on lr.id = d.lost_reason_id;

grant select on public.contact_intake to authenticated;



-- >>> 20260803003700_contact_create.sql

-- =============================================================================
-- Modules 16–19 · creating a contact
-- =============================================================================
-- Contacts is where every person lives — the ones who have signed and the ones
-- who never will. This file adds the last few columns the Create Contact form
-- asks for that had nowhere to go: a salutation, a second email, the consultant
-- working the account, and the campaign attribution a web lead arrives with.
--
-- Everything is additive and nullable, for the same reason as 003600: a form
-- that refuses half-known information is a form people keep in a spreadsheet.
-- =============================================================================

do $$
begin
  if to_regclass('public.deals') is null then
    raise exception 'Run 20260803003400_crm_foundation.sql first — it creates deals.'
      using hint = 'If that file refuses too, this database is behind by more than one module: run db/dist/catch-up-1.sql, then catch-up-2.sql, then catch-up-3.sql, each as its own execution. They carry everything from 001400 onwards and are safe on a database that already has some of it.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'clients'
                    and column_name = 'mailing_street') then
    raise exception 'Run 20260803003600_contact_intake.sql first — it adds the intake fields.'
      using hint = 'If that file refuses too, this database is behind by more than one module: run db/dist/catch-up-1.sql, then catch-up-2.sql, then catch-up-3.sql, each as its own execution. They carry everything from 001400 onwards and are safe on a database that already has some of it.';
  end if;
end
$$;

alter table public.clients
  /** Mr / Ms / Dr. A picklist on the form, free text here: honorifics are not a
      closed set and a check constraint on them ages badly. */
  add column if not exists salutation      text,
  /** A second address for the same person. Kept as a column rather than a
      channel row because the form edits one box; client_channels still holds
      the full set for matching and de-duplication. */
  add column if not exists secondary_email text,
  /** The consultant working the account, which is not always a system user —
      often a subcontracted rep — so this is a name, not a reference. */
  add column if not exists consultant      text,
  -- Where the enquiry came from, as the web form recorded it. source_id is the
  -- tidy internal list; these four are the raw truth from the landing page, and
  -- they are what a marketing spend report has to reconcile against.
  add column if not exists original_source text,
  add column if not exists utm_source      text,
  add column if not exists utm_medium      text,
  add column if not exists utm_campaign    text;

-- -----------------------------------------------------------------------------
-- The one-row-per-contact view, with the new columns
-- -----------------------------------------------------------------------------
-- Dropped and recreated rather than replaced: create or replace view can only
-- append columns, and these belong beside the ones they relate to.
drop view if exists public.contact_intake;

create view public.contact_intake
with (security_invoker = true) as
select c.id as client_id,
       c.salutation, c.first_name, c.last_name,
       c.email, c.secondary_email, c.phone, c.alternate_phone as mobile, c.owner_phone,
       c.mailing_street, c.mailing_city, c.mailing_state,
       c.mailing_postal_code, c.mailing_country, c.description,
       c.consultant, c.original_source, c.utm_source, c.utm_medium, c.utm_campaign,
       coalesce(owner.full_name, owner.email) as contact_owner,
       coalesce(creator.full_name, creator.email) as created_by_name,
       src.name as lead_source,
       dl.name as dealer_name,
       d.id as deal_id, d.code as deal_code, d.stage as lead_status,
       d.system_size_kw, d.module_quantity, d.module_wattage,
       d.battery_qty, d.battery_size_kwh, d.includes_battery,
       d.inverter_size_kw, d.mount_type, d.hoa, d.comparable_brand_ok,
       d.annual_usage_kwh, d.production_estimate_kwh, d.avg_monthly_bill,
       d.gross_price, d.contract_value, d.down_payment, d.amount_financed,
       d.financing_route, d.dealer_code, d.wave_sales_notes,
       d.additional_information, d.reschedule_reason,
       mod.name as module_brand, inv.name as inverter_brand, bat.name as battery_brand,
       fin.name as financing_company, u.name as electric_utility,
       lr.name as lost_reason
  from public.clients c
  left join public.profiles owner on owner.id = c.owner_id
  left join public.profiles creator on creator.id = c.created_by
  left join public.client_sources src on src.id = c.source_id
  left join public.dealers dl on dl.id = c.dealer_id
  left join lateral (
    select * from public.deals dd
     where dd.client_id = c.id
     order by (dd.stage not in ('won', 'lost')) desc, dd.updated_at desc
     limit 1
  ) d on true
  left join public.module_types mod on mod.id = d.module_id
  left join public.inverter_types inv on inv.id = d.inverter_id
  left join public.battery_types bat on bat.id = d.battery_id
  left join public.financing_companies fin on fin.id = d.financing_company_id
  left join public.utilities u on u.id = d.utility_id
  left join public.deal_loss_reasons lr on lr.id = d.lost_reason_id;

grant select on public.contact_intake to authenticated;

-- -----------------------------------------------------------------------------
-- A contact and its first deal, made together
-- -----------------------------------------------------------------------------
/**
 * Create Contact fills in one form and expects one record back, but the answers
 * live in two tables — the person, and the opportunity that carries the system
 * and the money. This makes both in one statement so a failure halfway leaves
 * neither behind, and returns the pair.
 *
 * The deal is only made when there is something to put on it. A contact typed
 * in from a business card is a person and nothing else, and inventing an empty
 * opportunity for them would put a phantom on the board and in the forecast.
 */
create or replace function public.create_contact(
  p_client jsonb,
  p_deal   jsonb default null
)
returns table (client_id uuid, deal_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_client uuid;
  v_deal uuid;
  v_stage text;
begin
  insert into public.clients (
    salutation, first_name, last_name, email, secondary_email, phone, alternate_phone,
    owner_phone, owner_id, source_id, dealer_id, description, consultant,
    original_source, utm_source, utm_medium, utm_campaign,
    mailing_street, mailing_city, mailing_state, mailing_postal_code, mailing_country,
    contact_stage)
  values (
    p_client ->> 'salutation', p_client ->> 'first_name', p_client ->> 'last_name',
    lower(nullif(btrim(coalesce(p_client ->> 'email', '')), '')),
    lower(nullif(btrim(coalesce(p_client ->> 'secondary_email', '')), '')),
    p_client ->> 'phone', p_client ->> 'alternate_phone', p_client ->> 'owner_phone',
    (p_client ->> 'owner_id')::uuid, (p_client ->> 'source_id')::uuid,
    (p_client ->> 'dealer_id')::uuid,
    p_client ->> 'description', p_client ->> 'consultant',
    p_client ->> 'original_source', p_client ->> 'utm_source',
    p_client ->> 'utm_medium', p_client ->> 'utm_campaign',
    p_client ->> 'mailing_street', p_client ->> 'mailing_city', p_client ->> 'mailing_state',
    p_client ->> 'mailing_postal_code', p_client ->> 'mailing_country',
    -- The stage is the contact's own, and a new one starts where they are: on
    -- file. A form that offers it may say otherwise, and anything it does not
    -- recognise falls back rather than failing the insert.
    coalesce(nullif(p_client ->> 'contact_stage', ''), 'created'))
  returning id into v_client;

  -- The channels, so the person is findable by either address and the duplicate
  -- check on the next creation can see them.
  if (p_client ->> 'email') is not null then
    insert into public.client_channels (client_id, kind, value, value_normalised, is_primary)
    values (v_client, 'email', p_client ->> 'email', '', true) on conflict do nothing;
  end if;
  if (p_client ->> 'secondary_email') is not null then
    insert into public.client_channels (client_id, kind, value, value_normalised, is_primary)
    values (v_client, 'email', p_client ->> 'secondary_email', '', false) on conflict do nothing;
  end if;
  if (p_client ->> 'phone') is not null then
    insert into public.client_channels (client_id, kind, value, value_normalised, is_primary)
    values (v_client, 'phone', p_client ->> 'phone', '', true) on conflict do nothing;
  end if;
  if (p_client ->> 'alternate_phone') is not null then
    insert into public.client_channels (client_id, kind, value, value_normalised, is_primary)
    values (v_client, 'phone', p_client ->> 'alternate_phone', '', false) on conflict do nothing;
  end if;

  if p_deal is not null and p_deal <> '{}'::jsonb then
    -- Won and Lost are outcomes, not starting points: Won is reached through
    -- the conversion that creates the project, and Lost needs a reason from the
    -- list. Anything else on the board is a fair place to start.
    v_stage := coalesce(p_deal ->> 'stage', 'new');
    if v_stage not in ('new', 'contacted', 'qualified', 'proposal',
                       'negotiation', 'contract_out') then
      v_stage := 'new';
    end if;

    insert into public.deals (
      client_id, customer_first, customer_last, customer_email, customer_phone,
      address, dealer_id, source_id, owner_id, stage,
      system_size_kw, module_id, module_quantity, module_wattage,
      inverter_id, inverter_size_kw, battery_id, battery_qty, battery_size_kwh,
      mount_type, roof_type_id, hoa, comparable_brand_ok,
      utility_id, avg_monthly_bill, annual_usage_kwh, production_estimate_kwh,
      gross_price, contract_value, down_payment, amount_financed,
      financing_route, financing_company_id, lost_reason_id,
      dealer_code, wave_sales_notes, additional_information, reschedule_reason)
    values (
      v_client, p_client ->> 'first_name', p_client ->> 'last_name',
      lower(nullif(btrim(coalesce(p_client ->> 'email', '')), '')), p_client ->> 'phone',
      coalesce(nullif(btrim(coalesce(p_deal ->> 'address', '')), ''),
               nullif(btrim(concat_ws(', ', p_client ->> 'mailing_street',
                                            p_client ->> 'mailing_city',
                                            p_client ->> 'mailing_state')), ''),
               'Address to be confirmed'),
      (p_client ->> 'dealer_id')::uuid, (p_client ->> 'source_id')::uuid,
      (p_client ->> 'owner_id')::uuid, v_stage,
      (p_deal ->> 'system_size_kw')::numeric, (p_deal ->> 'module_id')::uuid,
      (p_deal ->> 'module_quantity')::integer, (p_deal ->> 'module_wattage')::integer,
      (p_deal ->> 'inverter_id')::uuid, (p_deal ->> 'inverter_size_kw')::numeric,
      (p_deal ->> 'battery_id')::uuid, (p_deal ->> 'battery_qty')::integer,
      (p_deal ->> 'battery_size_kwh')::numeric,
      p_deal ->> 'mount_type', (p_deal ->> 'roof_type_id')::uuid, p_deal ->> 'hoa',
      (p_deal ->> 'comparable_brand_ok')::boolean,
      (p_deal ->> 'utility_id')::uuid, (p_deal ->> 'avg_monthly_bill')::numeric,
      (p_deal ->> 'annual_usage_kwh')::integer, (p_deal ->> 'production_estimate_kwh')::integer,
      (p_deal ->> 'gross_price')::numeric, (p_deal ->> 'contract_value')::numeric,
      (p_deal ->> 'down_payment')::numeric, (p_deal ->> 'amount_financed')::numeric,
      p_deal ->> 'financing_route', (p_deal ->> 'financing_company_id')::uuid,
      (p_deal ->> 'lost_reason_id')::uuid,
      p_deal ->> 'dealer_code', p_deal ->> 'wave_sales_notes',
      p_deal ->> 'additional_information', p_deal ->> 'reschedule_reason')
    returning id into v_deal;
  end if;

  return query select v_client, v_deal;
end;
$$;

revoke execute on function public.create_contact(jsonb, jsonb) from public, anon;
grant execute on function public.create_contact(jsonb, jsonb) to authenticated;



-- >>> 20260803003800_contact_stages.sql

-- =============================================================================
-- Contact stages — the contact's own pipeline
-- =============================================================================
-- The board had been reading the deal's stage, which was the right answer while
-- the two vocabularies matched. They do not. The stages the business actually
-- works are about reaching a person and getting in front of them:
--
--   Contact created · Appointment scheduled · Appointment rescheduled ·
--   No-show · Quoted · Financing approved · Contract signed · Lost
--
-- Three of those — rescheduled, no-show, and the return from either — are not
-- forward steps. A contact who does not answer the door goes back to being
-- rescheduled, and a deal pipeline that only moves forward cannot say so. And a
-- contact with no deal at all still has a stage: they were created, and nobody
-- has booked them in yet.
--
-- So the stage belongs to the person. The deal keeps its own (new → contacted →
-- qualified → proposal → negotiation → contract out, won, lost), which is about
-- the money rather than the diary, and the two no longer have to be the same
-- word in two places.
-- =============================================================================

alter table public.clients
  add column if not exists contact_stage text not null default 'created'
    check (contact_stage in ('created', 'appointment_scheduled', 'appointment_rescheduled',
                             'no_show', 'quoted', 'financing_approved', 'contract_signed',
                             'lost')),
  /** When they entered it — the board shows the days, because a contact sitting
      in Appointment scheduled for three weeks is the whole point of a board. */
  add column if not exists contact_stage_at timestamptz not null default now();

create index if not exists clients_contact_stage_idx
  on public.clients (contact_stage, contact_stage_at desc);

/**
 * The clock restarts when the stage changes, and only then. Editing somebody's
 * phone number does not make them newly scheduled.
 */
create or replace function app.tg_client_stage_stamp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.contact_stage is distinct from old.contact_stage then
    new.contact_stage_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists client_stage_stamp on public.clients;
create trigger client_stage_stamp before update on public.clients
  for each row execute function app.tg_client_stage_stamp();

-- -----------------------------------------------------------------------------
-- What the contacts already on file were doing
-- -----------------------------------------------------------------------------
-- Everyone starts at Contact created, which is true of everyone. Where a deal
-- says more than that, it is used — a signed contract and a lost deal are the
-- same fact in both vocabularies, and a proposal out is a quote given. Nothing
-- is invented for the middle: no appointment was ever recorded, so claiming one
-- was scheduled would be a guess written into the database.
do $$
begin
  if to_regclass('public.deals') is null then
    return;
  end if;

  update public.clients c
     set contact_stage = v.stage,
         contact_stage_at = coalesce(v.moved_at, c.created_at, now())
    from (
      select distinct on (d.client_id)
             d.client_id,
             case d.stage
               when 'won'  then 'contract_signed'
               when 'lost' then 'lost'
               when 'proposal' then 'quoted'
               when 'negotiation' then 'quoted'
               when 'contract_out' then 'quoted'
               else 'created'
             end as stage,
             d.stage_entered_at as moved_at
        from public.deals d
       where d.client_id is not null
       order by d.client_id, (d.stage not in ('won', 'lost')) desc, d.updated_at desc
    ) v
   where v.client_id = c.id
     and c.contact_stage = 'created'
     and v.stage <> 'created';
end
$$;

-- -----------------------------------------------------------------------------
-- Moving one
-- -----------------------------------------------------------------------------
/**
 * Any stage to any stage, which is the honest rule here: a no-show goes back to
 * rescheduled, a lost contact comes back to life, and there is no ordering
 * between them worth enforcing in a database. What it does insist on is that
 * the stage is a real one and that the move is written to the activity log,
 * because "who moved this and when" is the question a board always raises.
 */
create or replace function public.set_contact_stage(
  p_client uuid,
  p_stage  text,
  p_note   text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before text;
begin
  if not app.is_sales_staff() then
    raise exception 'only the sales team may move a contact' using errcode = '42501';
  end if;
  if p_stage not in ('created', 'appointment_scheduled', 'appointment_rescheduled',
                     'no_show', 'quoted', 'financing_approved', 'contract_signed', 'lost') then
    raise exception 'that is not a contact stage' using errcode = '22023';
  end if;

  select contact_stage into v_before from public.clients where id = p_client;
  if v_before is null then
    raise exception 'that contact no longer exists' using errcode = 'P0002';
  end if;
  if v_before = p_stage then
    return v_before;
  end if;

  update public.clients set contact_stage = p_stage where id = p_client;

  perform public.log_audit_event(
    'contact.stage_moved', 'clients', p_client::text, null,
    jsonb_build_object('from', v_before, 'to', p_stage, 'note', p_note),
    'stage_move', null, p_client);

  return v_before;
end;
$$;

revoke execute on function public.set_contact_stage(uuid, text, text) from public, anon;
grant execute on function public.set_contact_stage(uuid, text, text) to authenticated;



-- >>> 20260803003900_contract_signed_system.sql

-- =============================================================================
-- Contract signed — the system is recorded at the moment it is sold
-- =============================================================================
-- A contact is a person until they sign, and nothing about a system belongs on
-- a person who has not bought one. Once they sign, the system is the most
-- important thing about them: what was sold, at what size, for how much.
--
-- So signing is a step rather than a drag. Moving somebody into Contract signed
-- asks for the system there and then, records it on the deal, moves them, and
-- creates the project (004100). From that moment the contact record shows the
-- system. Before it, the contact record shows nothing about systems at all,
-- because there is nothing true to show.
--
-- The facts live on the deal, as they always have: a person with two
-- properties signs two contracts. What this file adds is the marker that says
-- "this deal's system was recorded at signing".
-- =============================================================================

do $$
begin
  if to_regclass('public.deals') is null then
    raise exception 'Run 20260803003400_crm_foundation.sql first — it creates deals.'
      using hint = 'Admin → Database → Apply runs every missing file in order.';
  end if;
  if to_regprocedure('public.convert_deal_to_project(uuid,public.project_stage)') is null then
    raise exception 'Run 20260803003500_deals.sql first — it converts deals to projects.'
      using hint = 'Admin → Database → Apply runs every missing file in order.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'clients'
                    and column_name = 'contact_stage') then
    raise exception 'Run 20260803003800_contact_stages.sql first — it adds the contact stage.'
      using hint = 'Admin → Database → Apply runs every missing file in order.';
  end if;
end
$$;

/** When the system was recorded at signing. Null means it never was — which is
    true of every deal still being worked, and of every one signed before this
    file, unless the backfill below can say otherwise. */
alter table public.deals
  add column if not exists system_recorded_at timestamptz;

-- -----------------------------------------------------------------------------
-- The contacts who had already signed
-- -----------------------------------------------------------------------------
-- A contact already in Contract signed whose deal carries a system size had it
-- recorded, just not by this screen. Marking those means the System tab
-- appears for them straight away rather than asking again for something that is
-- already on file. A signed contact with no size on their deal stays unmarked:
-- nothing was recorded, and claiming otherwise would put an empty panel on the
-- record that says "here is the system" over nothing.
update public.deals d
   set system_recorded_at = coalesce(d.stage_entered_at, d.updated_at, now())
  from public.clients c
 where c.id = d.client_id
   and c.contact_stage = 'contract_signed'
   and d.system_size_kw is not null
   and d.system_recorded_at is null;

-- The signing function itself is in 20260803004100_signing_creates_project.sql.
-- It was first defined here, in a shape that made no project, and databases
-- that took that shape report this file as applied — so the final version has
-- a file of its own, which a database without it can see it is missing.



-- >>> 20260803004000_project_holds_contact.sql

-- =============================================================================
-- The project holds the contact in place, until it is deleted
-- =============================================================================
-- 003900 makes signing record the system and create the project. This file
-- adds what follows from there being a project: the contact stays in Contract
-- signed. Moving somebody with a live installation back to Quoted, or out to
-- Lost, would put the board and the job in disagreement about whether they are
-- a customer — so the move is refused until the project is deleted, which is
-- the one honest way to say "this sale did not happen after all".
--
-- Deleting a project is new here, and it is admin-only. It is not the same as
-- cancelling one: a cancelled project is a job that stopped and stays on
-- record; a deleted one is a sale that is being unwound. The deal's documents
-- — the signed agreement, the bills — belong to the sale, and are kept.
-- =============================================================================

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'deals'
                    and column_name = 'system_recorded_at') then
    raise exception 'Run 20260803003900_contract_signed_system.sql first — it adds signing.'
      using hint = 'Admin → Database → Apply runs every missing file in order.';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- The project a signed contact is held by
-- -----------------------------------------------------------------------------
/**
 * The project made when this contact signed, if it still exists. Their newest
 * signing wins where there is more than one. Null means nothing holds them.
 *
 * Only a signed deal counts — one whose system was recorded at signing. A
 * returning customer whose project from five years ago came through the deal
 * board is not held in place by it.
 */
create or replace function public.contact_project(p_client uuid)
returns table (project_id uuid, project_code text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.code
    from public.deals d
    join public.projects p on p.id = d.project_id
   where d.client_id = p_client
     and d.system_recorded_at is not null
   order by d.system_recorded_at desc
   limit 1;
$$;

revoke execute on function public.contact_project(uuid) from public, anon;
grant execute on function public.contact_project(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- The hold
-- -----------------------------------------------------------------------------
/**
 * A contact with a project cannot leave Contract signed.
 *
 * On the table rather than in the move function, because there are three ways
 * to change a stage — the board, the Lead status box, and anything with SQL —
 * and a rule that holds on two of them does not hold.
 */
create or replace function app.tg_client_stage_hold()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  if old.contact_stage = 'contract_signed'
     and new.contact_stage is distinct from old.contact_stage then
    select cp.project_code into v_code from public.contact_project(new.id) cp;
    if v_code is not null then
      raise exception 'this contact has a project (%) — delete the project before moving them out of Contract signed', v_code
        using errcode = '55000',
              hint = 'The project holds them in place. An admin can delete it from the project page.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists client_stage_hold on public.clients;
create trigger client_stage_hold before update of contact_stage on public.clients
  for each row execute function app.tg_client_stage_hold();

-- -----------------------------------------------------------------------------
-- Deleting a project
-- -----------------------------------------------------------------------------
/**
 * Unwind a sale: the project goes, and the deal is open again.
 *
 * Admin-only, and the project's code has to be typed to confirm — this takes
 * the project's stages, tasks, messages and forms with it, and there is no
 * undo. What it keeps:
 *
 *   · the deal's documents. They were filed against the deal and only gained
 *     the project relation at conversion; the signed agreement belongs to the
 *     sale, not to the job. Documents filed against the project alone go with
 *     it.
 *   · the deal, reopened at Contract out with its system intact, and no longer
 *     Won — a won deal with no project is the state the conversion exists to
 *     prevent.
 *   · the activity log, which is not tied to the project row.
 *
 * The contact stays in Contract signed, and can now be moved.
 */
create or replace function public.delete_project(p_project uuid, p_confirm text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.projects%rowtype;
  v_deals uuid[];
begin
  if not app.is_admin() then
    raise exception 'only an admin may delete a project' using errcode = '42501';
  end if;

  select * into v from public.projects p where p.id = p_project for update;
  if not found then
    raise exception 'that project no longer exists' using errcode = 'P0002';
  end if;
  if p_confirm is distinct from v.code then
    raise exception 'type the project code % to confirm', v.code using errcode = '22023';
  end if;

  update public.documents d set project_id = null
   where d.project_id = p_project and d.deal_id is not null;

  select coalesce(array_agg(d.id), '{}') into v_deals
    from public.deals d where d.project_id = p_project;
  update public.deals d
     set project_id = null, stage = 'contract_out', won_at = null
   where d.project_id = p_project;
  -- The one reference that would otherwise refuse the delete: a dealer
  -- submission that was converted to this project. The submission stays; it
  -- just no longer points at a project that is not there.
  update public.deals d set converted_project_id = null
   where d.converted_project_id = p_project;

  delete from public.projects p where p.id = p_project;

  perform public.log_audit_event(
    'project.deleted', 'projects', p_project::text, p_project,
    jsonb_build_object('code', v.code, 'name', v.name, 'client_id', v.client_id,
                       'reopened_deals', to_jsonb(v_deals)),
    'system', v_deals[1], v.client_id);

  return v.client_id;
end;
$$;

revoke execute on function public.delete_project(uuid, text) from public, anon;
grant execute on function public.delete_project(uuid, text) to authenticated;



-- >>> 20260803004100_signing_creates_project.sql

-- =============================================================================
-- Signing creates the project
-- =============================================================================
-- Contract signed records the system (003900) and, from this file, creates the
-- project in the same step — so a signed contract becomes work for the install
-- team without anybody converting anything by hand.
--
-- Why a file of its own: sign_contact was first shipped inside 003900 in a
-- shape that recorded the system but made no project. Databases that took that
-- shape have 003900 recorded as applied, and a function that exists answers
-- "yes" to "is it there?" whatever it returns — so Admin → Database said Up to
-- date while signing failed. This file is probed by the function's result
-- columns, not its name, so a database with the first shape is shown as
-- missing it, and Apply fixes it.
-- =============================================================================

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'deals'
                    and column_name = 'system_recorded_at') then
    raise exception 'Run 20260803003900_contract_signed_system.sql first — it adds signing.'
      using hint = 'Admin → Database → Apply runs every missing file in order.';
  end if;
  if to_regprocedure('public.convert_deal_to_project(uuid,public.project_stage)') is null then
    raise exception 'Run 20260803003500_deals.sql first — it converts deals to projects.'
      using hint = 'Admin → Database → Apply runs every missing file in order.';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Signing
-- -----------------------------------------------------------------------------
-- Dropped first: the first version returned the deal alone, and a function's
-- result columns cannot change in place. This is the only file that defines
-- it, so re-running anything never puts that version back.
drop function if exists public.sign_contact(uuid, jsonb, uuid, text);

/**
 * Record the system, move the contact to Contract signed, and create the
 * project — as one statement. Any refusal, including the project's own, leaves
 * everything as it was: nobody ends up signed without a project, or with a
 * project and not signed.
 *
 * The form asks for the two things a project cannot exist without and a
 * contact can: a dealer, and a site address. Both are written to the deal; the
 * dealer goes on the contact too when they had none, since the attribution is
 * theirs from now on.
 *
 * The rest is as 003900: the named open deal, else their newest open one, else
 * a new one; only the system, usage, money, dealer and address columns are
 * written, whatever the payload carries; whole-number columns are rounded.
 */
create function public.sign_contact(
  p_client  uuid,
  p_deal    jsonb,
  p_deal_id uuid default null,
  p_note    text default null
)
returns table (signed_deal_id uuid, deal_created boolean,
               signed_project_id uuid, signed_project_code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed constant text[] := array[
    'system_size_kw', 'module_id', 'module_quantity', 'module_wattage',
    'inverter_id', 'inverter_size_kw', 'battery_id', 'battery_qty', 'battery_size_kwh',
    'includes_battery', 'mount_type', 'roof_type_id', 'hoa', 'comparable_brand_ok',
    'utility_id', 'avg_monthly_bill', 'annual_usage_kwh', 'production_estimate_kwh',
    'gross_price', 'contract_value', 'down_payment', 'amount_financed',
    'financing_route', 'financing_company_id',
    'dealer_id', 'address'];
  v_integers constant text[] := array[
    'module_quantity', 'module_wattage', 'battery_qty',
    'annual_usage_kwh', 'production_estimate_kwh'];
  -- What a deal made for a contact with no address to give is written with. A
  -- project cannot be surveyed at it, so it counts as no address at all.
  v_placeholder constant text := 'Address to be confirmed';
  v_client  public.clients%rowtype;
  v_row     public.deals%rowtype;
  v_new     public.deals%rowtype;
  v_patch   jsonb;
  v_deal    uuid;
  v_created boolean := false;
  v_before  text;
  v_project uuid;
  v_code    text;
begin
  if not app.is_sales_staff() then
    raise exception 'only the sales team may sign a contact' using errcode = '42501';
  end if;

  select * into v_client from public.clients c where c.id = p_client for update;
  if not found then
    raise exception 'that contact no longer exists' using errcode = 'P0002';
  end if;
  v_before := v_client.contact_stage;

  select coalesce(jsonb_object_agg(
           e.key,
           case when e.key = any(v_integers) and jsonb_typeof(e.value) = 'number'
                then to_jsonb(round((e.value #>> '{}')::numeric))
                when e.key = 'address' and jsonb_typeof(e.value) = 'string'
                then to_jsonb(nullif(btrim(e.value #>> '{}'), ''))
                else e.value end), '{}'::jsonb)
    into v_patch
    from jsonb_each(coalesce(p_deal, '{}'::jsonb)) e
   where e.key = any(v_allowed);

  if p_deal_id is not null then
    select d.id into v_deal from public.deals d
     where d.id = p_deal_id and d.client_id = p_client
       and d.stage not in ('won', 'lost');
    if v_deal is null then
      raise exception 'that deal is not an open deal on this contact' using errcode = '22023';
    end if;
  else
    select d.id into v_deal from public.deals d
     where d.client_id = p_client and d.stage not in ('won', 'lost')
     order by d.updated_at desc
     limit 1;
  end if;

  if v_deal is null then
    insert into public.deals (
      client_id, customer_first, customer_last, customer_email, customer_phone,
      address, dealer_id, source_id, owner_id, stage)
    values (
      p_client, v_client.first_name, v_client.last_name, v_client.email, v_client.phone,
      coalesce(nullif(btrim(concat_ws(', ', v_client.mailing_street,
                                            v_client.mailing_city,
                                            v_client.mailing_state)), ''),
               v_placeholder),
      v_client.dealer_id, v_client.source_id, v_client.owner_id, 'contract_out')
    returning id into v_deal;
    v_created := true;
  end if;

  select * into v_row from public.deals d where d.id = v_deal for update;
  v_new := jsonb_populate_record(v_row, v_patch);

  -- What the project will need, checked before anything is written so the
  -- refusal names the field rather than surfacing from inside the conversion.
  if v_new.system_size_kw is null or v_new.system_size_kw <= 0 then
    raise exception 'a signed contract needs a system size'
      using errcode = '22023',
            hint = 'Enter the system size in kW — it is the one field signing insists on.';
  end if;
  if v_new.dealer_id is null then
    raise exception 'the project needs a dealer'
      using errcode = '22023', hint = 'Choose the dealer this sale belongs to.';
  end if;
  if coalesce(btrim(v_new.address), '') in ('', v_placeholder) then
    raise exception 'the project needs a site address'
      using errcode = '22023', hint = 'Enter the address the system is being installed at.';
  end if;

  update public.deals d set
    system_size_kw          = v_new.system_size_kw,
    module_id               = v_new.module_id,
    module_quantity         = v_new.module_quantity,
    module_wattage          = v_new.module_wattage,
    inverter_id             = v_new.inverter_id,
    inverter_size_kw        = v_new.inverter_size_kw,
    battery_id              = v_new.battery_id,
    battery_qty             = v_new.battery_qty,
    battery_size_kwh        = v_new.battery_size_kwh,
    includes_battery        = v_new.includes_battery,
    mount_type              = v_new.mount_type,
    roof_type_id            = v_new.roof_type_id,
    hoa                     = v_new.hoa,
    comparable_brand_ok     = v_new.comparable_brand_ok,
    utility_id              = v_new.utility_id,
    avg_monthly_bill        = v_new.avg_monthly_bill,
    annual_usage_kwh        = v_new.annual_usage_kwh,
    production_estimate_kwh = v_new.production_estimate_kwh,
    gross_price             = v_new.gross_price,
    contract_value          = v_new.contract_value,
    down_payment            = v_new.down_payment,
    amount_financed         = v_new.amount_financed,
    financing_route         = v_new.financing_route,
    financing_company_id    = v_new.financing_company_id,
    dealer_id               = v_new.dealer_id,
    address                 = btrim(v_new.address),
    system_recorded_at      = now()
  where d.id = v_deal;

  if v_client.dealer_id is null then
    update public.clients c set dealer_id = v_new.dealer_id where c.id = p_client;
  end if;

  if v_before is distinct from 'contract_signed' then
    update public.clients c set contact_stage = 'contract_signed' where c.id = p_client;
    perform public.log_audit_event(
      'contact.stage_moved', 'clients', p_client::text, null,
      jsonb_build_object('from', v_before, 'to', 'contract_signed', 'note', p_note),
      'stage_move', v_deal, p_client);
  end if;

  -- The project, through the same conversion the deal board uses, so a
  -- project made by signing is the same shape as one made there: the system
  -- pre-filled, the documents gaining the project relation, the deal Won.
  -- It starts at Survey, as it does from the board.
  v_project := public.convert_deal_to_project(v_deal, 'survey'::public.project_stage);

  -- The conversion copies the system size and the brands but not the module
  -- count, which the signing form asks for and the project's specification
  -- shows. Only where the project has none: a project the conversion returned
  -- rather than made keeps whatever it already says.
  update public.projects p
     set module_quantity = coalesce(p.module_quantity, nullif(v_new.module_quantity, 0))
   where p.id = v_project;

  select p.code into v_code from public.projects p where p.id = v_project;

  perform public.log_audit_event(
    'contact.contract_signed', 'deals', v_deal::text, v_project,
    jsonb_build_object('deal_created', v_created,
                       'project_id', v_project,
                       'project_code', v_code,
                       'system_size_kw', v_new.system_size_kw,
                       'contract_value', v_new.contract_value),
    'form', v_deal, p_client);

  return query select v_deal, v_created, v_project, v_code;
end;
$$;

revoke execute on function public.sign_contact(uuid, jsonb, uuid, text) from public, anon;
grant execute on function public.sign_contact(uuid, jsonb, uuid, text) to authenticated;



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



-- >>> 20260803004300_stage_upload_fix.sql

-- =============================================================================
-- Stage-form uploads work again
-- =============================================================================
-- public.record_staff_upload — the function behind every file on a stage form
-- (install pictures, shading reports, and now each stage's attachments) —
-- wrote the document's kind as a CASE of two string literals. PostgreSQL types
-- that CASE as text, and documents.kind is the enum public.document_kind, so
-- every upload failed:
--
--   column "kind" is of type public.document_kind but expression is of type text
--
-- The same slip was fixed for deal documents in 003500. This replaces the
-- function with the cast in place; nothing else about it changes. Added as a
-- new file rather than an edit to 001400, because a database that already has
-- 001400 would never see an edit.
-- =============================================================================

create or replace function public.record_staff_upload(
  p_project_id uuid,
  p_category   text,
  p_filename   text,
  p_mime       text,
  p_data       bytea
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_path text;
  v_object_id uuid;
  v_document_id uuid;
begin
  if not app.is_project_staff(p_project_id) then
    raise exception 'only project staff may upload' using errcode = '42501';
  end if;
  if p_category is null or btrim(p_category) = '' then
    raise exception 'category is required';
  end if;
  if p_mime not in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
                    'application/pdf') then
    raise exception 'only photos and PDFs are accepted';
  end if;
  if p_data is null or octet_length(p_data) = 0 or octet_length(p_data) > 26214400 then
    raise exception 'file must be between 1 byte and 25 MB';
  end if;

  v_name := coalesce(nullif(regexp_replace(coalesce(p_filename, ''), '[^\w.\-]+', '_', 'g'), ''), 'file');
  v_name := right(v_name, 100);
  v_path := p_project_id || '/uploads/' || p_category || '/'
            || floor(extract(epoch from clock_timestamp()) * 1000)::bigint || '-' || v_name;

  insert into storage.objects (bucket_id, name, owner)
  values (case when p_mime = 'application/pdf' then 'project-deliverables' else 'project-photos' end,
          v_path, auth.uid())
  returning id into v_object_id;

  insert into storage.object_data (object_id, data) values (v_object_id, p_data);

  insert into public.documents
    (project_id, bucket, object_path, kind, category, title, mime_type, size_bytes,
     customer_visible, uploaded_by)
  values
    (p_project_id,
     case when p_mime = 'application/pdf' then 'project-deliverables' else 'project-photos' end,
     v_path,
     (case when p_mime = 'application/pdf' then 'pdf' else 'photo' end)::public.document_kind,
     btrim(p_category), p_filename, p_mime, octet_length(p_data), false, auth.uid())
  returning id into v_document_id;

  perform app.write_audit('document.uploaded', 'documents', v_document_id::text, p_project_id,
    null, null, jsonb_build_object('category', p_category, 'filename', p_filename));

  return v_document_id;
end;
$$;

revoke execute on function public.record_staff_upload(uuid, text, text, text, bytea) from public, anon;
grant execute on function public.record_staff_upload(uuid, text, text, text, bytea) to authenticated;



-- >>> 20260803004400_esignature.sql

-- =============================================================================
-- E-signature: contracts and change orders signed through PandaDoc
-- =============================================================================
-- A contract can now be sent to the homeowner to sign instead of being marked
-- signed by hand, and a change order can be sent the same way. What happens
-- when the signature lands is exactly what happens today when somebody signs
-- by hand, because it is the same function:
--
--   contract      public.sign_contact() with the system the rep entered when
--                 sending — the project is created, the contact is held —
--                 and the signed PDF is filed on the deal and the project as
--                 the signed installation agreement.
--   change order  the change order is approved, its amount is added to the
--                 project's contract value, and the signed PDF is filed on
--                 the project and linked from the change order.
--
-- One row per document sent, in public.esign_envelopes. Nobody writes to that
-- table directly: every change goes through the functions below, so the
-- permission rules are the ones signing already has (the sales team for a
-- contract, the project's staff for a change order).
--
-- Completion is idempotent. PandaDoc retries webhooks, the embedded signing
-- screen reports completion to the browser as well, and a person can press
-- Check status — all three can arrive for the same document, and only the
-- first does anything.
--
-- Nothing here talks to PandaDoc. The application does that; the database
-- records what it was told and applies the outcome.
-- =============================================================================

do $$
begin
  if to_regprocedure('public.sign_contact(uuid, jsonb, uuid, text)') is null then
    raise exception 'Run 20260803004100_signing_creates_project.sql first — it adds signing.';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 1. Settings: which PandaDoc templates to use
-- -----------------------------------------------------------------------------
-- The API key and the webhook key are secrets and live in the environment
-- (PANDADOC_API_KEY, PANDADOC_WEBHOOK_KEY), never in the database. The
-- templates are not secrets, and an admin changes them, so they live here.
alter table public.app_settings
  add column if not exists pandadoc_contract_template     text,
  add column if not exists pandadoc_change_order_template text,
  add column if not exists pandadoc_signer_role           text not null default 'Client';

-- -----------------------------------------------------------------------------
-- 2. Envelopes
-- -----------------------------------------------------------------------------
create table if not exists public.esign_envelopes (
  id                   uuid primary key default gen_random_uuid(),
  provider             text not null default 'pandadoc' check (provider in ('pandadoc')),
  provider_document_id text unique,
  purpose              text not null check (purpose in ('contract', 'change_order')),
  client_id            uuid references public.clients (id) on delete cascade,
  deal_id              uuid references public.deals (id) on delete set null,
  project_id           uuid references public.projects (id) on delete cascade,
  change_order_id      uuid references public.change_orders (id) on delete cascade,
  -- The provider's state, in our words. 'completed' means signed by everyone;
  -- whether we have acted on it yet is applied_at.
  status               text not null default 'preparing'
                       check (status in ('preparing', 'sent', 'viewed', 'completed',
                                         'declined', 'voided', 'failed')),
  delivery             text not null default 'email' check (delivery in ('email', 'embedded')),
  signer_name          text,
  signer_email         text not null,
  -- For a contract: the signing form as the rep sent it — what sign_contact()
  -- receives when the homeowner signs.
  payload              jsonb not null default '{}'::jsonb,
  note                 text,
  signed_object_id     uuid references storage.objects (id) on delete set null,
  document_id          uuid references public.documents (id) on delete set null,
  outcome              jsonb,
  last_error           text,
  created_by           uuid references public.profiles (id),
  created_at           timestamptz not null default now(),
  sent_at              timestamptz,
  viewed_at            timestamptz,
  completed_at         timestamptz,
  applied_at           timestamptz,
  updated_at           timestamptz not null default now(),
  constraint esign_envelopes_subject check (
    (purpose = 'contract' and client_id is not null)
    or (purpose = 'change_order' and change_order_id is not null and project_id is not null))
);

create index if not exists esign_envelopes_client_idx on public.esign_envelopes (client_id);
create index if not exists esign_envelopes_project_idx on public.esign_envelopes (project_id);
create index if not exists esign_envelopes_co_idx on public.esign_envelopes (change_order_id);
-- One document out for signature per subject at a time.
create unique index if not exists esign_envelopes_one_open_contract
  on public.esign_envelopes (client_id)
  where purpose = 'contract' and status in ('preparing', 'sent', 'viewed');
create unique index if not exists esign_envelopes_one_open_co
  on public.esign_envelopes (change_order_id)
  where purpose = 'change_order' and status in ('preparing', 'sent', 'viewed');

drop trigger if exists set_updated_at on public.esign_envelopes;
create trigger set_updated_at before update on public.esign_envelopes
  for each row execute function app.tg_set_updated_at();
drop trigger if exists audit_row on public.esign_envelopes;
create trigger audit_row after insert or update or delete on public.esign_envelopes
  for each row execute function app.tg_audit_row();

alter table public.esign_envelopes enable row level security;
revoke all on public.esign_envelopes from public, anon;
grant select on public.esign_envelopes to authenticated;

drop policy if exists esign_envelopes_select on public.esign_envelopes;
create policy esign_envelopes_select on public.esign_envelopes
  for select to authenticated
  using (
    (purpose = 'contract' and app.is_sales_staff())
    or (purpose = 'change_order' and app.is_project_staff(project_id))
  );

-- -----------------------------------------------------------------------------
-- 3. Who may act on an envelope
-- -----------------------------------------------------------------------------
create or replace function app.can_act_on_envelope(p_purpose text, p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_purpose
           when 'contract' then app.is_sales_staff()
           when 'change_order' then app.is_project_staff(p_project)
           else false
         end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Opening one
-- -----------------------------------------------------------------------------
/**
 * Record a document about to be sent. Returns the envelope id; the application
 * then creates the document in PandaDoc and reports back with esign_mark().
 *
 * A contract is checked the way signing checks it, before anybody is emailed:
 * the contact must not already have a project, and the three fields a project
 * cannot be made without must be in the payload. Finding out after the
 * homeowner has signed would be the worst time.
 */
create or replace function public.esign_open(
  p_purpose      text,
  p_client       uuid,
  p_deal         uuid,
  p_change_order uuid,
  p_signer_name  text,
  p_signer_email text,
  p_delivery     text,
  p_payload      jsonb,
  p_note         text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id      uuid;
  v_project uuid;
  v_co      public.change_orders%rowtype;
  v_held    text;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
begin
  if p_signer_email is null or p_signer_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'the signer needs a valid email address' using errcode = '22023';
  end if;
  if coalesce(p_delivery, 'email') not in ('email', 'embedded') then
    raise exception 'unknown delivery %', p_delivery using errcode = '22023';
  end if;

  if p_purpose = 'contract' then
    if not app.is_sales_staff() then
      raise exception 'only the sales team may send a contract' using errcode = '42501';
    end if;
    if not exists (select 1 from public.clients c where c.id = p_client) then
      raise exception 'that contact no longer exists' using errcode = 'P0002';
    end if;
    select cp.project_code into v_held from public.contact_project(p_client) cp;
    if v_held is not null then
      raise exception 'this contact is already signed — project % holds them', v_held
        using errcode = '55000';
    end if;
    if coalesce((v_payload ->> 'system_size_kw')::numeric, 0) <= 0 then
      raise exception 'a signed contract needs a system size' using errcode = '22023';
    end if;
    if coalesce(v_payload ->> 'dealer_id', '') = '' then
      raise exception 'the project needs a dealer' using errcode = '22023';
    end if;
    if coalesce(btrim(v_payload ->> 'address'), '') in ('', 'Address to be confirmed') then
      raise exception 'the project needs a site address' using errcode = '22023';
    end if;
    if exists (select 1 from public.esign_envelopes e
                where e.client_id = p_client and e.purpose = 'contract'
                  and e.status in ('preparing', 'sent', 'viewed')) then
      raise exception 'a contract is already out for signature for this contact — void it first'
        using errcode = '23505';
    end if;

    insert into public.esign_envelopes
      (purpose, client_id, deal_id, signer_name, signer_email, delivery, payload, note, created_by)
    values
      ('contract', p_client, p_deal, nullif(btrim(p_signer_name), ''), lower(btrim(p_signer_email)),
       coalesce(p_delivery, 'email'), v_payload, p_note, (select auth.uid()))
    returning id into v_id;

    perform public.log_audit_event(
      'esign.sent', 'esign_envelopes', v_id::text, null,
      jsonb_build_object('purpose', 'contract', 'signer', lower(btrim(p_signer_email))),
      'email', p_deal, p_client);

  elsif p_purpose = 'change_order' then
    select * into v_co from public.change_orders co where co.id = p_change_order for update;
    if not found then
      raise exception 'that change order no longer exists' using errcode = 'P0002';
    end if;
    v_project := v_co.project_id;
    if not app.is_project_staff(v_project) then
      raise exception 'only the project team may send a change order' using errcode = '42501';
    end if;
    if v_co.status not in ('draft', 'pending_approval', 'rejected') then
      raise exception 'a % change order cannot be sent for signature', v_co.status
        using errcode = '22023';
    end if;
    if exists (select 1 from public.esign_envelopes e
                where e.change_order_id = p_change_order
                  and e.status in ('preparing', 'sent', 'viewed')) then
      raise exception 'this change order is already out for signature — void it first'
        using errcode = '23505';
    end if;

    insert into public.esign_envelopes
      (purpose, project_id, change_order_id, client_id, signer_name, signer_email, delivery,
       note, created_by)
    values
      ('change_order', v_project, p_change_order,
       (select p.client_id from public.projects p where p.id = v_project),
       nullif(btrim(p_signer_name), ''), lower(btrim(p_signer_email)),
       coalesce(p_delivery, 'email'), p_note, (select auth.uid()))
    returning id into v_id;

    update public.change_orders set status = 'pending_approval' where id = p_change_order;

    perform app.write_audit('change_order.sent', 'change_orders', p_change_order::text, v_project,
      null, null, jsonb_build_object('number', v_co.number, 'signer', lower(btrim(p_signer_email))));
  else
    raise exception 'unknown purpose %', p_purpose using errcode = '22023';
  end if;

  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. What PandaDoc said
-- -----------------------------------------------------------------------------
/**
 * Record the provider's document id or a change in its state. States only move
 * forward: a late 'viewed' after 'completed' changes nothing, and nothing
 * leaves 'completed'.
 */
create or replace function public.esign_mark(
  p_envelope    uuid,
  p_provider_id text,
  p_status      text,
  p_error       text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_env  public.esign_envelopes%rowtype;
  v_rank constant jsonb := '{"preparing":0,"sent":1,"viewed":2,"declined":3,"voided":3,"failed":3,"completed":4}';
begin
  select * into v_env from public.esign_envelopes e where e.id = p_envelope for update;
  if not found then
    raise exception 'that envelope no longer exists' using errcode = 'P0002';
  end if;
  if not app.can_act_on_envelope(v_env.purpose, v_env.project_id) then
    raise exception 'not allowed to change this envelope' using errcode = '42501';
  end if;
  if p_status is not null and not (v_rank ? p_status) then
    raise exception 'unknown status %', p_status using errcode = '22023';
  end if;

  if p_provider_id is not null and v_env.provider_document_id is null then
    update public.esign_envelopes set provider_document_id = p_provider_id where id = p_envelope;
  end if;

  if p_status is not null
     and v_env.status <> 'completed'
     and (v_rank ->> p_status)::int >= (v_rank ->> v_env.status)::int
     and p_status <> v_env.status then
    update public.esign_envelopes set
      status       = p_status,
      sent_at      = case when p_status in ('sent', 'viewed', 'completed') then coalesce(sent_at, now()) else sent_at end,
      viewed_at    = case when p_status in ('viewed', 'completed') then coalesce(viewed_at, now()) else viewed_at end,
      completed_at = case when p_status = 'completed' then coalesce(completed_at, now()) else completed_at end,
      last_error   = coalesce(p_error, last_error)
    where id = p_envelope;

    if v_env.purpose = 'change_order' and p_status in ('declined', 'voided', 'failed') then
      update public.change_orders
         set status = case when p_status = 'declined' then 'rejected' else 'draft' end::public.change_order_status
       where id = v_env.change_order_id and status = 'pending_approval';
    end if;

    perform public.log_audit_event(
      'esign.' || p_status, 'esign_envelopes', p_envelope::text, v_env.project_id,
      jsonb_build_object('purpose', v_env.purpose, 'error', p_error),
      'system', v_env.deal_id, v_env.client_id);
  elsif p_error is not null then
    update public.esign_envelopes set last_error = p_error where id = p_envelope;
  end if;

  return (select status from public.esign_envelopes where id = p_envelope);
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Who a webhook acts as
-- -----------------------------------------------------------------------------
/**
 * A webhook carries no session. Once the application has checked PandaDoc's
 * signature on it, this says which envelope it is about and who sent that
 * envelope, so the outcome is applied as that person — with their permissions,
 * and in the activity log under their name. Nothing else about the envelope is
 * returned.
 */
create or replace function public.esign_webhook_target(p_provider_id text)
returns table (envelope_id uuid, sender_id uuid, sender_role text, sender_active boolean,
               sender_email text, status text, applied boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, e.created_by, pr.role::text, coalesce(pr.is_active, false), pr.email,
         e.status, e.applied_at is not null
    from public.esign_envelopes e
    left join public.profiles pr on pr.id = e.created_by
   where e.provider_document_id = p_provider_id;
$$;

-- -----------------------------------------------------------------------------
-- 7. Signed
-- -----------------------------------------------------------------------------
/**
 * Everyone has signed: file the PDF and apply the outcome.
 *
 * The PDF is stored first and kept whatever happens next — it is the signed
 * contract. If applying the outcome fails (a contact already moved on, a rule
 * the form did not check), the envelope is left completed but not applied,
 * with the reason in last_error, and pressing Finish on the record runs this
 * again with nothing to download.
 */
create or replace function public.esign_complete(
  p_envelope uuid,
  p_filename text,
  p_data     bytea
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_env      public.esign_envelopes%rowtype;
  v_object   uuid;
  v_path     text;
  v_size     bigint;
  v_name     text;
  v_deal     uuid;
  v_project  uuid;
  v_code     text;
  v_error    text;
  v_doc      uuid;
  v_co       public.change_orders%rowtype;
  v_category text;
  v_outcome  jsonb;
  v_created  boolean := false;
begin
  select * into v_env from public.esign_envelopes e where e.id = p_envelope for update;
  if not found then
    raise exception 'that envelope no longer exists' using errcode = 'P0002';
  end if;
  if not app.can_act_on_envelope(v_env.purpose, v_env.project_id) then
    raise exception 'not allowed to complete this envelope' using errcode = '42501';
  end if;
  if v_env.applied_at is not null then
    return v_env.outcome || jsonb_build_object('already', true);
  end if;
  if v_env.status in ('declined', 'voided') then
    raise exception 'this document was % and cannot be completed', v_env.status
      using errcode = '22023';
  end if;

  -- The signed PDF, once.
  if v_env.signed_object_id is null then
    if p_data is null or octet_length(p_data) = 0 then
      raise exception 'the signed PDF is required' using errcode = '22023';
    end if;
    if octet_length(p_data) > 26214400 then
      raise exception 'the signed PDF is larger than 25 MB' using errcode = '22023';
    end if;
    v_name := coalesce(nullif(regexp_replace(coalesce(p_filename, ''), '[^\w.\-]+', '_', 'g'), ''),
                       'signed.pdf');
    v_path := 'esign/' || p_envelope || '/'
              || floor(extract(epoch from clock_timestamp()) * 1000)::bigint || '-' || right(v_name, 100);
    insert into storage.objects (bucket_id, name, owner)
    values ('project-deliverables', v_path, (select auth.uid()))
    returning id into v_object;
    insert into storage.object_data (object_id, data) values (v_object, p_data);
    update public.esign_envelopes set signed_object_id = v_object where id = p_envelope;
    v_env.signed_object_id := v_object;
  end if;
  select o.name into v_path from storage.objects o where o.id = v_env.signed_object_id;
  select octet_length(od.data) into v_size from storage.object_data od
   where od.object_id = v_env.signed_object_id;

  if v_env.purpose = 'contract' then
    v_category := 'signed_installation_agreement';
    select cp.project_id, cp.project_code into v_project, v_code
      from public.contact_project(v_env.client_id) cp;
    if v_project is not null then
      -- Signed by hand while the document was out: the project is there
      -- already, and the PDF joins it.
      select d.id into v_deal from public.deals d where d.project_id = v_project limit 1;
    else
      begin
        select s.signed_deal_id, s.signed_project_id, s.signed_project_code, s.deal_created
          into v_deal, v_project, v_code, v_created
          from public.sign_contact(
                 v_env.client_id, v_env.payload,
                 (select d.id from public.deals d
                   where d.id = v_env.deal_id and d.stage not in ('won', 'lost')),
                 coalesce(v_env.note, 'Signed in PandaDoc')) s;
      exception when others then
        v_error := sqlerrm;
      end;
    end if;
    if v_deal is null then
      -- Somewhere for the PDF to live even when signing could not finish.
      select d.id into v_deal from public.deals d
       where d.client_id = v_env.client_id order by d.updated_at desc limit 1;
    end if;
    v_outcome := jsonb_build_object('project_id', v_project, 'project_code', v_code,
                                    'deal_id', v_deal, 'deal_created', v_created);
  else
    v_category := 'change_order';
    v_project := v_env.project_id;
    select * into v_co from public.change_orders co where co.id = v_env.change_order_id for update;
    if not found then
      v_error := 'the change order was deleted before it was signed';
    elsif v_co.status <> 'approved' then
      update public.change_orders set
        status      = 'approved',
        approved_by = (select auth.uid()),
        approved_at = now()
      where id = v_co.id;
      update public.projects p
         set contract_value = coalesce(p.contract_value, 0) + v_co.amount_delta
       where p.id = v_project;
      perform app.write_audit('change_order.signed', 'change_orders', v_co.id::text, v_project,
        null, null, jsonb_build_object('number', v_co.number, 'amount_delta', v_co.amount_delta,
                                       'via', 'pandadoc'));
    end if;
    v_outcome := jsonb_build_object('project_id', v_project, 'change_order_id', v_env.change_order_id,
                                    'amount_delta', v_co.amount_delta,
                                    'contract_value',
                                    (select p.contract_value from public.projects p where p.id = v_project));
  end if;

  -- File it where the rest of the paperwork is.
  if v_env.document_id is null and (v_project is not null or v_deal is not null) then
    insert into public.documents
      (project_id, deal_id, bucket, object_path, kind, category, title, mime_type, size_bytes,
       customer_visible, uploaded_by)
    values
      (v_project, v_deal, 'project-deliverables', v_path, 'pdf'::public.document_kind, v_category,
       coalesce(nullif(p_filename, ''), 'Signed document.pdf'), 'application/pdf', v_size,
       false, (select auth.uid()))
    returning id into v_doc;
    update public.esign_envelopes set document_id = v_doc where id = p_envelope;
    if v_env.purpose = 'change_order' and v_co.id is not null then
      update public.change_orders set document_id = v_doc where id = v_co.id;
    end if;
  else
    v_doc := v_env.document_id;
  end if;
  v_outcome := v_outcome || jsonb_build_object('document_id', v_doc);

  update public.esign_envelopes set
    status       = 'completed',
    completed_at = coalesce(completed_at, now()),
    applied_at   = case when v_error is null then now() else null end,
    outcome      = v_outcome,
    last_error   = v_error,
    project_id   = coalesce(project_id, v_project),
    deal_id      = coalesce(deal_id, v_deal)
  where id = p_envelope;

  perform public.log_audit_event(
    case when v_error is null then 'esign.completed' else 'esign.needs_attention' end,
    'esign_envelopes', p_envelope::text, v_project,
    v_outcome || jsonb_build_object('purpose', v_env.purpose, 'error', v_error),
    'system', v_deal, v_env.client_id);

  return v_outcome || jsonb_build_object('error', v_error);
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Change orders, created on the project
-- -----------------------------------------------------------------------------
create or replace function public.create_change_order(
  p_project      uuid,
  p_reason       text,
  p_description  text,
  p_amount_delta numeric,
  p_requires_signature boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id     uuid;
  v_number integer;
begin
  if not app.is_project_staff(p_project) then
    raise exception 'only the project team may raise a change order' using errcode = '42501';
  end if;
  if not exists (select 1 from public.projects p where p.id = p_project) then
    raise exception 'that project no longer exists' using errcode = 'P0002';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a change order needs a reason' using errcode = '22023';
  end if;
  if p_amount_delta is null then
    raise exception 'a change order needs an amount (0 when the price does not change)'
      using errcode = '22023';
  end if;

  -- The company's numbering (Admin → Settings: prefix and next number), taken
  -- and advanced in one statement — the row lock serialises two people raising
  -- one at once. Skipped past any number this project already has, so an admin
  -- resetting the counter cannot collide with (project_id, number).
  update public.app_settings s set co_next_number = greatest(
           s.co_next_number,
           (select coalesce(max(co.number), 0) + 1 from public.change_orders co
             where co.project_id = p_project)) + 1
   where s.id
  returning s.co_next_number - 1 into v_number;
  if v_number is null then
    select coalesce(max(co.number), 0) + 1 into v_number
      from public.change_orders co where co.project_id = p_project;
  end if;

  insert into public.change_orders
    (project_id, number, status, reason, description, amount_delta,
     requires_customer_signature, requested_by)
  values
    (p_project, v_number, 'draft', btrim(p_reason), nullif(btrim(p_description), ''),
     round(p_amount_delta, 2), coalesce(p_requires_signature, true), (select auth.uid()))
  returning id into v_id;

  perform app.write_audit('change_order.created', 'change_orders', v_id::text, p_project,
    null, null, jsonb_build_object('number', v_number, 'amount_delta', round(p_amount_delta, 2)));
  return v_id;
end;
$$;

/**
 * Approve a change order without e-signature — one that needs no customer
 * signature, or one signed on paper. Admin and ops only; applies the amount
 * exactly as a signed one does.
 */
create or replace function public.approve_change_order(p_change_order uuid, p_note text default null)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_co public.change_orders%rowtype;
  v_value numeric;
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'only admin or ops may approve a change order by hand' using errcode = '42501';
  end if;
  select * into v_co from public.change_orders co where co.id = p_change_order for update;
  if not found then
    raise exception 'that change order no longer exists' using errcode = 'P0002';
  end if;
  if v_co.status = 'approved' then
    raise exception 'that change order is already approved' using errcode = '22023';
  end if;
  if v_co.status = 'void' then
    raise exception 'a void change order cannot be approved' using errcode = '22023';
  end if;
  if exists (select 1 from public.esign_envelopes e
              where e.change_order_id = p_change_order and e.status in ('preparing', 'sent', 'viewed')) then
    raise exception 'this change order is out for signature — void that first' using errcode = '23505';
  end if;

  update public.change_orders set status = 'approved', approved_by = (select auth.uid()),
         approved_at = now() where id = p_change_order;
  update public.projects p set contract_value = coalesce(p.contract_value, 0) + v_co.amount_delta
   where p.id = v_co.project_id
  returning p.contract_value into v_value;
  perform app.write_audit('change_order.approved', 'change_orders', p_change_order::text,
    v_co.project_id, null, null,
    jsonb_build_object('number', v_co.number, 'amount_delta', v_co.amount_delta,
                       'via', 'manual', 'note', p_note));
  return v_value;
end;
$$;

/** Void a draft or pending change order; an approved one is history. */
create or replace function public.void_change_order(p_change_order uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_co public.change_orders%rowtype;
begin
  select * into v_co from public.change_orders co where co.id = p_change_order for update;
  if not found then
    raise exception 'that change order no longer exists' using errcode = 'P0002';
  end if;
  if not app.is_project_staff(v_co.project_id) then
    raise exception 'only the project team may void a change order' using errcode = '42501';
  end if;
  if v_co.status = 'approved' then
    raise exception 'an approved change order cannot be voided — raise a new one to reverse it'
      using errcode = '22023';
  end if;
  update public.change_orders set status = 'void' where id = p_change_order;
  update public.esign_envelopes set status = 'voided'
   where change_order_id = p_change_order and status in ('preparing', 'sent', 'viewed');
  perform app.write_audit('change_order.voided', 'change_orders', p_change_order::text,
    v_co.project_id, null, null, jsonb_build_object('number', v_co.number));
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. The templates, for the people who send
-- -----------------------------------------------------------------------------
-- app_settings is readable by admin and ops only, and a sales rep sending a
-- contract needs to know which template to use. This hands over exactly that
-- and the company name printed on it — nothing else in the settings row.
drop function if exists public.esign_settings();
create function public.esign_settings()
returns table (contract_template text, change_order_template text, signer_role text,
               company_name text, co_prefix text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.pandadoc_contract_template, s.pandadoc_change_order_template,
         coalesce(nullif(btrim(s.pandadoc_signer_role), ''), 'Client'), s.company_name,
         s.co_prefix
    from public.app_settings s
   where s.id and app.current_user_role() in ('admin', 'ops', 'sales');
$$;

revoke execute on function public.esign_settings() from public, anon;
grant execute on function public.esign_settings() to authenticated;

revoke execute on function app.can_act_on_envelope(text, uuid) from public, anon;
revoke execute on function public.esign_open(text, uuid, uuid, uuid, text, text, text, jsonb, text) from public, anon;
revoke execute on function public.esign_mark(uuid, text, text, text) from public, anon;
revoke execute on function public.esign_webhook_target(text) from public, anon;
revoke execute on function public.esign_complete(uuid, text, bytea) from public, anon;
revoke execute on function public.create_change_order(uuid, text, text, numeric, boolean) from public, anon;
revoke execute on function public.approve_change_order(uuid, text) from public, anon;
revoke execute on function public.void_change_order(uuid) from public, anon;
grant execute on function app.can_act_on_envelope(text, uuid) to authenticated;
grant execute on function public.esign_open(text, uuid, uuid, uuid, text, text, text, jsonb, text) to authenticated;
grant execute on function public.esign_mark(uuid, text, text, text) to authenticated;
grant execute on function public.esign_webhook_target(text) to authenticated;
grant execute on function public.esign_complete(uuid, text, bytea) to authenticated;
grant execute on function public.create_change_order(uuid, text, text, numeric, boolean) to authenticated;
grant execute on function public.approve_change_order(uuid, text) to authenticated;
grant execute on function public.void_change_order(uuid) to authenticated;



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



-- >>> 20260803004600_stage_fields_solar.sql

-- =============================================================================
-- Stage fields a solar installer needs
-- =============================================================================
-- The stage forms recorded the milestones (status and dates) and the money.
-- They did not record the facts each stage produces — the main panel rating
-- found at survey, the permit number and its expiry, the purchase order, the
-- crew, the inspector, the meter set, the monitoring site — so those lived in
-- notes, email and people's heads, where no report, reminder or automation
-- could reach them.
--
-- Every column here is optional. Nothing changes what a stage needs to
-- advance; these are the places the facts go, and the document reader
-- (migration 004800) writes into them. Numbers are numeric so they can be
-- summed and compared in reports; short choices are text with a check, in the
-- form's own vocabulary.
-- =============================================================================

-- Survey: what the site is -----------------------------------------------------
alter table public.stage1_survey
  add column if not exists surveyor_id             uuid references public.profiles (id) on delete set null,
  add column if not exists survey_scheduled_date   date,
  add column if not exists roof_type               text check (roof_type in
    ('comp_shingle', 'tile', 'metal', 'flat', 'wood_shake', 'other')),
  add column if not exists roof_age_years          numeric(5,1) check (roof_age_years >= 0),
  add column if not exists roof_condition          text check (roof_condition in
    ('good', 'fair', 'poor', 'replace_first')),
  add column if not exists stories                 numeric(3,1) check (stories > 0),
  add column if not exists roof_pitch              text,
  add column if not exists main_panel_rating_amps  numeric(5,0) check (main_panel_rating_amps > 0),
  add column if not exists bus_bar_rating_amps     numeric(5,0) check (bus_bar_rating_amps > 0),
  add column if not exists main_breaker_amps       numeric(5,0) check (main_breaker_amps > 0),
  add column if not exists panel_upgrade_needed    text check (panel_upgrade_needed in ('yes', 'no', 'tbd')),
  add column if not exists meter_number            text,
  add column if not exists utility_account_number  text,
  add column if not exists attic_access            text check (attic_access in ('yes', 'no', 'limited')),
  add column if not exists trenching_distance_ft   numeric(7,1) check (trenching_distance_ft >= 0),
  add column if not exists shading_notes           text,
  add column if not exists site_notes              text;

-- Design: what was designed -----------------------------------------------------
alter table public.stage2_design
  add column if not exists final_system_size_kw    numeric(8,3) check (final_system_size_kw > 0),
  add column if not exists final_module_count      numeric(5,0) check (final_module_count > 0),
  add column if not exists production_estimate_kwh numeric(10,0) check (production_estimate_kwh >= 0),
  add column if not exists offset_percent          numeric(5,1) check (offset_percent >= 0),
  add column if not exists design_revision         numeric(3,0) check (design_revision >= 0),
  add column if not exists customer_approval_date  date,
  add column if not exists design_tool_url         text,
  add column if not exists engineering_firm        text,
  add column if not exists pe_stamp_required       text check (pe_stamp_required in ('yes', 'no', 'tbd'));

-- Permits: the numbers on the paperwork -----------------------------------------
alter table public.stage3_permit
  add column if not exists permit_number           text,
  add column if not exists permit_expiry_date      date,
  add column if not exists permit_fee              numeric(10,2) check (permit_fee >= 0),
  add column if not exists permit_submission_method text check (permit_submission_method in
    ('portal', 'email', 'in_person', 'solarapp')),
  add column if not exists ica_application_number  text,
  add column if not exists meter_swap_required     text check (meter_swap_required in ('yes', 'no', 'na')),
  add column if not exists hoa_name                text,
  add column if not exists hoa_contact             text;

-- Procurement: the order -------------------------------------------------------
alter table public.stage4_procurement
  add column if not exists vendor_name             text,
  add column if not exists po_number               text,
  add column if not exists order_date              date,
  add column if not exists expected_delivery_date  date,
  add column if not exists tracking_number         text,
  add column if not exists material_location       text check (material_location in
    ('vendor', 'warehouse', 'site')),
  add column if not exists material_cost           numeric(12,2) check (material_cost >= 0);

-- Install: who, how long, signed off ---------------------------------------------
alter table public.stage5_install
  add column if not exists crew_lead               text,
  add column if not exists crew_size               numeric(3,0) check (crew_size > 0),
  add column if not exists install_duration_days   numeric(4,1) check (install_duration_days > 0),
  add column if not exists mpu_completed_date      date,
  add column if not exists homeowner_signoff_date  date,
  add column if not exists install_notes           text;

-- Inspection & PTO: the visit, the utility, the monitoring -----------------------
alter table public.stage6_inspection
  add column if not exists inspection_scheduled_date date,
  add column if not exists inspector_name          text,
  add column if not exists reinspection_date       date,
  add column if not exists pto_application_number  text,
  add column if not exists meter_set_date          date,
  add column if not exists monitoring_platform     text check (monitoring_platform in
    ('enphase', 'solaredge', 'tesla', 'generac', 'other')),
  add column if not exists monitoring_site_id      text;

-- Complete: closing out ----------------------------------------------------------
alter table public.stage7_complete
  add column if not exists warranty_registration_date date,
  add column if not exists final_payment_received_date date,
  add column if not exists closeout_packet_sent_date date,
  add column if not exists review_requested_date   date,
  add column if not exists referral_asked          text check (referral_asked in ('yes', 'no'));

-- The permit expiry is what the reminder job watches (004700); an index keeps
-- that a cheap question.
create index if not exists stage3_permit_expiry_idx
  on public.stage3_permit (permit_expiry_date) where permit_expiry_date is not null;



-- >>> 20260803004700_notifications.sql

-- =============================================================================
-- Notifications: one catalogue, every audience, every channel
-- =============================================================================
-- Until now each notification was its own code: five customer pushes, chat
-- emails, a rating email, a digest. Nothing told the PM a permit was about to
-- expire, nothing told the dealer their project moved, nothing told a
-- homeowner their permit was approved unless they opened the app, and there
-- was no list anywhere of what had been sent to whom.
--
-- This file makes notifications a thing the database records:
--
--   notification_rules   the catalogue. One row per kind of notification, with
--                        who it is for and which channels it uses (in-app,
--                        email, push). Admins switch each one on or off.
--   notifications        one row per notification per person: the in-app feed
--                        for customers, staff and dealers, and the delivery
--                        record for email and push.
--
-- Triggers on the business tables raise notifications when things happen — a
-- stage moves, a permit is approved, a payment is requested, a document is
-- signed. Time-based ones (ageing, expiring permits, stale leads) are raised
-- by the scheduled job. Delivery (rendering the words, sending email and push,
-- honouring quiet hours) is the application's work, in src/lib/notify.
--
-- Dedupe is built in: a kind + key is raised once per recipient, so a project
-- moved back and forth, or a job run twice, sends nothing twice.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The catalogue
-- -----------------------------------------------------------------------------
create table if not exists public.notification_rules (
  kind        text primary key,
  audience    text not null check (audience in ('customer', 'pm', 'admin', 'sales', 'dealer', 'user')),
  label       text not null,
  description text,
  enabled     boolean not null default true,
  in_app      boolean not null default true,
  email       boolean not null default true,
  push        boolean not null default false,
  updated_at  timestamptz not null default now()
);

drop trigger if exists set_updated_at on public.notification_rules;
create trigger set_updated_at before update on public.notification_rules
  for each row execute function app.tg_set_updated_at();

alter table public.notification_rules enable row level security;
revoke all on public.notification_rules from public, anon;
grant select, update on public.notification_rules to authenticated;
drop policy if exists notification_rules_select on public.notification_rules;
create policy notification_rules_select on public.notification_rules
  for select to authenticated using (true);
drop policy if exists notification_rules_update on public.notification_rules;
create policy notification_rules_update on public.notification_rules
  for update to authenticated using ((select app.is_admin())) with check ((select app.is_admin()));

-- Seeded with sensible defaults. Push defaults on only where the existing
-- customer pushes do not already cover the same moment.
insert into public.notification_rules (kind, audience, label, description, in_app, email, push) values
  -- homeowner
  ('project_created',        'customer', 'Project started',              'Their project has been created after signing.', true, true, false),
  ('stage_advanced',         'customer', 'Stage advanced',               'Their project moved to the next stage.', true, true, false),
  ('survey_scheduled',       'customer', 'Survey scheduled',             'The site survey has a date.', true, true, true),
  ('survey_completed',       'customer', 'Survey completed',             'The site survey is done.', true, false, false),
  ('design_ready',           'customer', 'Design ready',                 'Their system design has been received.', true, true, true),
  ('permit_submitted',       'customer', 'Permit submitted',             'The building permit application went in.', true, true, false),
  ('permit_approved',        'customer', 'Permit approved',              'The building permit was approved.', true, true, true),
  ('ica_approved',           'customer', 'Utility interconnection approved', 'The utility approved the interconnection agreement.', true, true, false),
  ('hoa_approved',           'customer', 'HOA approved',                 'The HOA approved the installation.', true, true, false),
  ('material_ordered',       'customer', 'Equipment ordered',            'Their equipment has been ordered.', true, true, false),
  ('material_delivered',     'customer', 'Equipment delivered',          'Their equipment has arrived.', true, true, false),
  ('install_scheduled',      'customer', 'Installation scheduled',       'The installation has a date (the app already pushes this).', true, true, false),
  ('install_completed',      'customer', 'Installation completed',       'The crew has finished the installation.', true, true, true),
  ('inspection_scheduled',   'customer', 'Inspection scheduled',         'The city inspection has a date.', true, true, true),
  ('inspection_passed',      'customer', 'Inspection passed',            'The inspection was passed.', true, true, true),
  ('inspection_failed',      'customer', 'Inspection needs corrections', 'The inspection found items to fix; we are on it.', true, true, false),
  ('pto_applied',            'customer', 'Permission to operate requested', 'The utility has been asked for permission to operate.', true, true, false),
  ('pto_received',           'customer', 'Permission to operate granted', 'The utility granted permission to operate.', true, true, true),
  ('system_energized',       'customer', 'System switched on',           'Their system is producing (the app already pushes this).', true, true, false),
  ('project_complete',       'customer', 'Project complete',             'Everything is finished.', true, true, false),
  ('project_on_hold',        'customer', 'Project paused',               'Their project was put on hold (the app already pushes this).', true, true, false),
  ('project_resumed',        'customer', 'Project resumed',              'Their project is moving again.', true, true, true),
  ('payment_requested',      'customer', 'Payment requested',            'A payment milestone is due.', true, true, true),
  ('payment_received',       'customer', 'Payment received',             'A payment was received — a receipt.', true, true, false),
  ('action_needed',          'customer', 'Something needed from them',   'The PM asked for a photo, a document or information (the app already pushes this).', true, true, false),
  ('contract_signed',        'customer', 'Contract signed',              'Confirmation that their contract was signed.', true, true, false),
  ('change_order_confirmed', 'customer', 'Change order confirmed',       'A change order was signed or approved.', true, true, false),
  ('new_message',            'customer', 'New message',                  'Their project manager wrote (chat already pushes and emails this).', true, false, false),
  -- project manager
  ('project_assigned',       'pm', 'Project assigned to you',     'A project was assigned to this PM.', true, true, true),
  ('customer_message',       'pm', 'Customer wrote',              'A customer message arrived (the digest emails these).', true, false, true),
  ('customer_request',       'pm', 'Customer request',            'A homeowner asked for dates, a contact change or sent a document.', true, true, true),
  ('customer_uploaded',      'pm', 'Customer uploaded a file',    'A homeowner uploaded a photo or document.', true, false, false),
  ('stage_ageing',           'pm', 'Project ageing',              'A project has been in its stage longer than the threshold.', true, true, false),
  ('permit_expiring',        'pm', 'Permit expiring',             'A permit expires soon and the project is not installed.', true, true, true),
  ('permit_revision',        'pm', 'Permit correction requested', 'The AHJ or utility sent a permit back.', true, true, true),
  ('inspection_failed_pm',   'pm', 'Inspection failed',           'An inspection failed; correction items are on the form.', true, true, true),
  ('install_readiness',      'pm', 'Install tomorrow not ready',  'Tomorrow''s install is missing a permit, materials or a confirmation.', true, true, true),
  ('esign_completed',        'pm', 'Document signed',             'A contract or change order was signed.', true, true, false),
  ('esign_declined',         'pm', 'Document declined',           'The homeowner declined to sign.', true, true, true),
  ('esign_needs_attention',  'pm', 'Signed but not applied',      'A signed document could not be applied; press Finish.', true, true, true),
  ('change_order_approved',  'pm', 'Change order approved',       'A change order was signed or approved and the contract value updated.', true, false, false),
  ('low_rating',             'pm', 'Low customer rating',         'A homeowner rated a stage 1 or 2 (the follow-up email already goes out).', true, false, true),
  ('ai_exception',           'pm', 'AI needs a decision',         'The document reader was unsure about something.', true, false, false),
  ('daily_briefing',         'pm', 'Morning briefing',            'The day''s summary from Ask SolarFlow.', true, true, false),
  -- admin
  ('admin_project_created',  'admin', 'New project',              'A contract was signed and a project created.', true, false, false),
  ('deal_won',               'admin', 'Deal won',                 'A deal was marked won.', true, false, false),
  ('esign_failed',           'admin', 'E-signature failed',       'PandaDoc refused a document; the reason is on the record.', true, true, false),
  -- sales
  ('lead_assigned',          'sales', 'Lead assigned to you',     'A contact was assigned to this rep.', true, true, true),
  ('contact_stale',          'sales', 'Contact going quiet',      'A quoted or booked contact has not been contacted for a while.', true, true, false),
  ('deal_stale',             'sales', 'Deal going quiet',         'An open deal has not moved for a while.', true, true, false),
  -- dealer
  ('dealer_project_created', 'dealer', 'Your project started',   'A project was created for one of the dealer''s customers.', true, true, false),
  ('dealer_stage_advanced',  'dealer', 'Your project moved',     'One of the dealer''s projects changed stage.', true, false, false),
  ('dealer_project_complete','dealer', 'Your project completed', 'One of the dealer''s projects is complete.', true, true, false),
  ('dealer_project_on_hold', 'dealer', 'Your project paused',    'One of the dealer''s projects is on hold.', true, true, false),
  ('commission_payable',     'dealer', 'Commission payable',     'A commission became payable.', true, true, false)
on conflict (kind) do nothing;

-- -----------------------------------------------------------------------------
-- 2. The feed and delivery record
-- -----------------------------------------------------------------------------
create table if not exists public.notifications (
  id              bigint generated always as identity primary key,
  kind            text not null references public.notification_rules (kind) on delete cascade,
  -- Who: a login, or (a homeowner without one) an email address.
  user_id         uuid references public.profiles (id) on delete cascade,
  recipient_email text,
  project_id      uuid references public.projects (id) on delete cascade,
  deal_id         uuid references public.deals (id) on delete set null,
  client_id       uuid references public.clients (id) on delete set null,
  -- What happened, for the words: stage, date, amount, reason…
  payload         jsonb not null default '{}'::jsonb,
  dedupe_key      text,
  deliver_after   timestamptz not null default now(),
  claimed_at      timestamptz,
  delivered_at    timestamptz,
  emailed_at      timestamptz,
  pushed_at       timestamptz,
  delivery_error  text,
  read_at         timestamptz,
  created_at      timestamptz not null default now(),
  constraint notifications_recipient check (user_id is not null or recipient_email is not null)
);

create unique index if not exists notifications_dedupe_idx
  on public.notifications (kind, coalesce(user_id::text, recipient_email), dedupe_key)
  where dedupe_key is not null;
create index if not exists notifications_feed_idx
  on public.notifications (user_id, created_at desc) where user_id is not null;
create index if not exists notifications_unread_idx
  on public.notifications (user_id) where read_at is null and user_id is not null;
create index if not exists notifications_undelivered_idx
  on public.notifications (deliver_after) where delivered_at is null;
create index if not exists notifications_project_idx on public.notifications (project_id);

alter table public.notifications enable row level security;
revoke all on public.notifications from public, anon;
grant select on public.notifications to authenticated;
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated
  using (user_id = (select auth.uid()) or (select app.is_admin()));

alter table public.app_settings
  add column if not exists contact_stale_days         integer not null default 7,
  add column if not exists deal_stale_days            integer not null default 14,
  add column if not exists permit_expiry_warning_days integer not null default 14,
  add column if not exists briefing_hour              integer not null default 7;

-- -----------------------------------------------------------------------------
-- 3. Raising one
-- -----------------------------------------------------------------------------
/**
 * Raise a notification for one recipient. Silent when the kind is unknown or
 * switched off, when there is nobody to send it to, or when the same kind and
 * key was already raised for them. Returns the id, or null when nothing was
 * raised. Internal: the triggers and the helpers below call it.
 */
create or replace function app.notify(
  p_kind       text,
  p_user       uuid,
  p_email      text,
  p_project    uuid,
  p_deal       uuid,
  p_client     uuid,
  p_payload    jsonb,
  p_dedupe     text,
  p_after      timestamptz default now()
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if p_user is null and nullif(btrim(coalesce(p_email, '')), '') is null then
    return null;
  end if;
  if not exists (select 1 from public.notification_rules r where r.kind = p_kind and r.enabled) then
    return null;
  end if;
  if p_user is not null and not exists (
       select 1 from public.profiles pr where pr.id = p_user and pr.is_active and pr.deleted_at is null) then
    return null;
  end if;
  insert into public.notifications
    (kind, user_id, recipient_email, project_id, deal_id, client_id, payload, dedupe_key, deliver_after)
  values
    (p_kind, p_user, case when p_user is null then lower(btrim(p_email)) end,
     p_project, p_deal, p_client, coalesce(p_payload, '{}'::jsonb), p_dedupe, coalesce(p_after, now()))
  on conflict do nothing
  returning id into v_id;
  return v_id;
end;
$$;

/** The homeowner of a project: their login when they have one, else their email. */
create or replace function app.notify_customer(p_project uuid, p_kind text, p_payload jsonb, p_dedupe text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client public.clients%rowtype;
begin
  select c.* into v_client
    from public.projects p join public.clients c on c.id = p.client_id
   where p.id = p_project;
  if not found then return; end if;
  if coalesce(v_client.email_opt_out, false) and v_client.user_id is null then return; end if;
  -- Keys are scoped to the project: "permit_approved" once per project, not once per person.
  perform app.notify(p_kind, v_client.user_id, v_client.email, p_project, null, v_client.id,
                     p_payload, p_project::text || ':' || p_dedupe);
end;
$$;

/** The project's PM; with no PM assigned, every active admin. */
create or replace function app.notify_project_staff(p_project uuid, p_kind text, p_payload jsonb, p_dedupe text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pm uuid;
  v_admin uuid;
begin
  select p.assigned_pm into v_pm from public.projects p where p.id = p_project;
  if v_pm is not null then
    perform app.notify(p_kind, v_pm, null, p_project, null, null, p_payload, p_project::text || ':' || p_dedupe);
    return;
  end if;
  for v_admin in select pr.id from public.profiles pr
                  where pr.role = 'admin' and pr.is_active and pr.deleted_at is null loop
    perform app.notify(p_kind, v_admin, null, p_project, null, null, p_payload, p_project::text || ':' || p_dedupe);
  end loop;
end;
$$;

create or replace function app.notify_admins(p_kind text, p_project uuid, p_deal uuid, p_client uuid,
                                             p_payload jsonb, p_dedupe text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid;
begin
  for v_admin in select pr.id from public.profiles pr
                  where pr.role = 'admin' and pr.is_active and pr.deleted_at is null loop
    perform app.notify(p_kind, v_admin, null, p_project, p_deal, p_client, p_payload,
                       coalesce(p_project::text, p_deal::text, p_client::text, '') || ':' || p_dedupe);
  end loop;
end;
$$;

/** Every login at the project's dealer. */
create or replace function app.notify_dealer(p_project uuid, p_kind text, p_payload jsonb, p_dedupe text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  for v_user in select du.user_id from public.dealer_users du
                 join public.projects p on p.dealer_id = du.dealer_id
                where p.id = p_project loop
    perform app.notify(p_kind, v_user, null, p_project, null, null, p_payload, p_project::text || ':' || p_dedupe);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. What raises them
-- -----------------------------------------------------------------------------
-- Projects: created, moved, held, resumed, completed, cancelled, reassigned.
create or replace function app.tg_notify_project()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
begin
  if tg_op = 'INSERT' then
    perform app.notify_customer(new.id, 'project_created', jsonb_build_object('stage', new.stage), 'created');
    perform app.notify_dealer(new.id, 'dealer_project_created', '{}'::jsonb, 'created');
    perform app.notify_admins('admin_project_created', new.id, new.deal_id, new.client_id, '{}'::jsonb, 'created');
    if new.assigned_pm is not null then
      perform app.notify('project_assigned', new.assigned_pm, null, new.id, null, null, '{}'::jsonb, new.id::text || ':assigned');
    end if;
    return new;
  end if;

  if new.assigned_pm is distinct from old.assigned_pm and new.assigned_pm is not null then
    perform app.notify('project_assigned', new.assigned_pm, null, new.id, null, null, '{}'::jsonb,
                       new.id::text || ':assigned:' || to_char(now(), 'YYYYMMDDHH24MI'));
  end if;

  if new.stage is distinct from old.stage and new.status = 'active' and new.stage <> 'complete' then
    perform app.notify_customer(new.id, 'stage_advanced', jsonb_build_object('stage', new.stage, 'from', old.stage),
                                'stage:' || new.stage);
    perform app.notify_dealer(new.id, 'dealer_stage_advanced', jsonb_build_object('stage', new.stage), 'stage:' || new.stage);
  end if;

  if new.status is distinct from old.status then
    if new.status = 'on_hold' then
      select h.reason into v_reason from public.project_holds h
       where h.project_id = new.id and h.resume_date is null order by h.created_at desc limit 1;
      perform app.notify_customer(new.id, 'project_on_hold', jsonb_build_object('reason', v_reason),
                                  'hold:' || to_char(now(), 'YYYYMMDDHH24MI'));
      perform app.notify_dealer(new.id, 'dealer_project_on_hold', jsonb_build_object('reason', v_reason),
                                'hold:' || to_char(now(), 'YYYYMMDDHH24MI'));
    elsif new.status = 'active' and old.status = 'on_hold' then
      perform app.notify_customer(new.id, 'project_resumed', jsonb_build_object('stage', new.stage),
                                  'resumed:' || to_char(now(), 'YYYYMMDDHH24MI'));
    elsif new.status = 'complete' then
      perform app.notify_customer(new.id, 'project_complete', '{}'::jsonb, 'complete');
      perform app.notify_dealer(new.id, 'dealer_project_complete', '{}'::jsonb, 'complete');
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists notify_project on public.projects;
create trigger notify_project after insert or update on public.projects
  for each row execute function app.tg_notify_project();

-- A payment milestone changing hands, shared by the four stage tables that hold one.
create or replace function app.notify_payment(p_project uuid, p_label text, p_old text, p_new text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_new is distinct from p_old and p_new = 'requested' then
    perform app.notify_customer(p_project, 'payment_requested', jsonb_build_object('milestone', p_label),
                                'payment_requested:' || p_label);
  elsif p_new is distinct from p_old and p_new = 'received' then
    perform app.notify_customer(p_project, 'payment_received', jsonb_build_object('milestone', p_label),
                                'payment_received:' || p_label);
  end if;
end;
$$;

create or replace function app.tg_notify_stage1()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.survey_status is distinct from old.survey_status and new.survey_status = 'scheduled' then
    perform app.notify_customer(new.project_id, 'survey_scheduled',
      jsonb_build_object('date', new.survey_scheduled_date), 'survey_scheduled:' || coalesce(new.survey_scheduled_date::text, 'tbd'));
  elsif new.survey_status is distinct from old.survey_status and new.survey_status = 'completed' then
    perform app.notify_customer(new.project_id, 'survey_completed', '{}'::jsonb, 'survey_completed');
  end if;
  perform app.notify_payment(new.project_id, 'Down payment', old.down_payment_status, new.down_payment_status);
  perform app.notify_payment(new.project_id, 'Milestone 1', old.cash_m1_status, new.cash_m1_status);
  return new;
end;
$$;
drop trigger if exists notify_stage on public.stage1_survey;
create trigger notify_stage after insert or update on public.stage1_survey
  for each row execute function app.tg_notify_stage1();

create or replace function app.tg_notify_stage2()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.design_status is distinct from old.design_status and new.design_status = 'received' then
    perform app.notify_customer(new.project_id, 'design_ready',
      jsonb_build_object('size_kw', new.final_system_size_kw, 'modules', new.final_module_count), 'design_ready');
  end if;
  return new;
end;
$$;
drop trigger if exists notify_stage on public.stage2_design;
create trigger notify_stage after insert or update on public.stage2_design
  for each row execute function app.tg_notify_stage2();

create or replace function app.tg_notify_stage3()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.permit_status is distinct from old.permit_status then
    if new.permit_status = 'applied' then
      perform app.notify_customer(new.project_id, 'permit_submitted', jsonb_build_object('date', new.permit_applied_date), 'permit_submitted');
    elsif new.permit_status = 'approved' then
      perform app.notify_customer(new.project_id, 'permit_approved',
        jsonb_build_object('permit_number', new.permit_number, 'date', new.permit_received_date), 'permit_approved');
    elsif new.permit_status in ('revision_requested', 'rejected') then
      perform app.notify_project_staff(new.project_id, 'permit_revision',
        jsonb_build_object('track', 'Building permit', 'status', new.permit_status, 'notes', new.permit_revision_notes),
        'permit_revision:' || new.permit_status || ':' || to_char(now(), 'YYYYMMDD'));
    end if;
  end if;
  if new.ica_status is distinct from old.ica_status then
    if new.ica_status = 'approved' then
      perform app.notify_customer(new.project_id, 'ica_approved', jsonb_build_object('date', new.ica_received_date), 'ica_approved');
    elsif new.ica_status in ('revision_requested', 'rejected') then
      perform app.notify_project_staff(new.project_id, 'permit_revision',
        jsonb_build_object('track', 'Interconnection', 'status', new.ica_status, 'notes', new.ica_revision_notes),
        'ica_revision:' || new.ica_status || ':' || to_char(now(), 'YYYYMMDD'));
    end if;
  end if;
  if new.hoa_status is distinct from old.hoa_status and new.hoa_status = 'approved' then
    perform app.notify_customer(new.project_id, 'hoa_approved', jsonb_build_object('date', new.hoa_received_date), 'hoa_approved');
  end if;
  perform app.notify_payment(new.project_id, 'Milestone 2', old.cash_m2_status, new.cash_m2_status);
  return new;
end;
$$;
drop trigger if exists notify_stage on public.stage3_permit;
create trigger notify_stage after insert or update on public.stage3_permit
  for each row execute function app.tg_notify_stage3();

create or replace function app.tg_notify_stage4()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.material_status is distinct from old.material_status then
    if new.material_status = 'ordered' then
      perform app.notify_customer(new.project_id, 'material_ordered',
        jsonb_build_object('expected', new.expected_delivery_date), 'material_ordered');
    elsif new.material_status = 'delivered' then
      perform app.notify_customer(new.project_id, 'material_delivered', jsonb_build_object('date', new.material_delivered_date), 'material_delivered');
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists notify_stage on public.stage4_procurement;
create trigger notify_stage after insert or update on public.stage4_procurement
  for each row execute function app.tg_notify_stage4();

create or replace function app.tg_notify_stage5()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.install_scheduled_date is distinct from old.install_scheduled_date and new.install_scheduled_date is not null then
    perform app.notify_customer(new.project_id, 'install_scheduled',
      jsonb_build_object('date', new.install_scheduled_date), 'install_scheduled:' || new.install_scheduled_date::text);
  end if;
  if new.install_status is distinct from old.install_status and new.install_status = 'completed' then
    perform app.notify_customer(new.project_id, 'install_completed', jsonb_build_object('date', new.install_completed_date), 'install_completed');
  end if;
  perform app.notify_payment(new.project_id, 'Milestone 3', old.cash_m3_status, new.cash_m3_status);
  return new;
end;
$$;
drop trigger if exists notify_stage on public.stage5_install;
create trigger notify_stage after insert or update on public.stage5_install
  for each row execute function app.tg_notify_stage5();

create or replace function app.tg_notify_stage6()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.inspection_status is distinct from old.inspection_status then
    if new.inspection_status in ('scheduled', 'reinspection_scheduled') then
      perform app.notify_customer(new.project_id, 'inspection_scheduled',
        jsonb_build_object('date', coalesce(new.reinspection_date, new.inspection_scheduled_date), 'again', new.inspection_status = 'reinspection_scheduled'),
        'inspection_scheduled:' || coalesce(coalesce(new.reinspection_date, new.inspection_scheduled_date)::text, 'tbd'));
    elsif new.inspection_status = 'passed' then
      perform app.notify_customer(new.project_id, 'inspection_passed', jsonb_build_object('date', new.inspection_completed_date), 'inspection_passed');
    elsif new.inspection_status = 'failed' then
      perform app.notify_customer(new.project_id, 'inspection_failed', '{}'::jsonb, 'inspection_failed:' || to_char(now(), 'YYYYMMDD'));
      perform app.notify_project_staff(new.project_id, 'inspection_failed_pm',
        jsonb_build_object('notes', new.inspection_failed_notes), 'inspection_failed:' || to_char(now(), 'YYYYMMDD'));
    end if;
  end if;
  if new.pto_status is distinct from old.pto_status then
    if new.pto_status = 'applied' then
      perform app.notify_customer(new.project_id, 'pto_applied', jsonb_build_object('date', new.pto_applied_date), 'pto_applied');
    elsif new.pto_status = 'received' then
      perform app.notify_customer(new.project_id, 'pto_received', jsonb_build_object('date', new.pto_received_date), 'pto_received');
    end if;
  end if;
  if new.energization_status is distinct from old.energization_status and new.energization_status = 'energized' then
    perform app.notify_customer(new.project_id, 'system_energized', jsonb_build_object('date', new.energization_date), 'energized');
  end if;
  return new;
end;
$$;
drop trigger if exists notify_stage on public.stage6_inspection;
create trigger notify_stage after insert or update on public.stage6_inspection
  for each row execute function app.tg_notify_stage6();

-- The homeowner asks or sends something → the PM.
create or replace function app.tg_notify_customer_request()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform app.notify_project_staff(new.project_id, 'customer_request',
    jsonb_build_object('kind', new.kind, 'message', left(coalesce(new.message, ''), 200)), 'request:' || new.id);
  return new;
end;
$$;
drop trigger if exists notify_request on public.customer_requests;
create trigger notify_request after insert on public.customer_requests
  for each row execute function app.tg_notify_customer_request();

create or replace function app.tg_notify_customer_ask()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform app.notify_customer(new.project_id, 'action_needed',
    jsonb_build_object('label', new.label, 'detail', new.detail), 'ask:' || new.id);
  return new;
end;
$$;
drop trigger if exists notify_ask on public.customer_asks;
create trigger notify_ask after insert on public.customer_asks
  for each row execute function app.tg_notify_customer_ask();

-- A homeowner's upload → the PM (staff uploads notify nobody).
create or replace function app.tg_notify_document()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.project_id is not null and new.uploaded_by is not null and exists (
       select 1 from public.projects p join public.clients c on c.id = p.client_id
        where p.id = new.project_id and c.user_id = new.uploaded_by) then
    perform app.notify_project_staff(new.project_id, 'customer_uploaded',
      jsonb_build_object('title', new.title, 'category', new.category), 'upload:' || new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists notify_document on public.documents;
create trigger notify_document after insert on public.documents
  for each row execute function app.tg_notify_document();

-- Chat: a line in each side's feed (push and email are the chat module's).
create or replace function app.tg_notify_message()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.is_internal then return new; end if;
  if new.sender_role = 'customer' then
    perform app.notify_project_staff(new.project_id, 'customer_message',
      jsonb_build_object('preview', left(new.body, 160)), 'message:' || new.id);
  elsif new.sender_role = 'staff' then
    perform app.notify_customer(new.project_id, 'new_message',
      jsonb_build_object('preview', left(new.body, 160)), 'message:' || new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists notify_message on public.project_messages;
create trigger notify_message after insert on public.project_messages
  for each row execute function app.tg_notify_message();

-- E-signature outcomes → the sender (and the homeowner, when signed).
create or replace function app.tg_notify_esign()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_payload jsonb := jsonb_build_object('purpose', new.purpose, 'signer', new.signer_email);
begin
  if new.status is distinct from old.status then
    if new.status = 'completed' then
      perform app.notify('esign_completed', new.created_by, null, new.project_id, new.deal_id, new.client_id, v_payload, 'esign:' || new.id);
      if new.purpose = 'contract' then
        perform app.notify('contract_signed', (select c.user_id from public.clients c where c.id = new.client_id),
                           (select c.email from public.clients c where c.id = new.client_id),
                           new.project_id, new.deal_id, new.client_id, v_payload, 'contract_signed:' || new.id);
      end if;
    elsif new.status = 'declined' then
      perform app.notify('esign_declined', new.created_by, null, new.project_id, new.deal_id, new.client_id, v_payload, 'esign:' || new.id);
    elsif new.status = 'failed' then
      perform app.notify_admins('esign_failed', new.project_id, new.deal_id, new.client_id,
        v_payload || jsonb_build_object('error', new.last_error), 'esign:' || new.id);
    end if;
  end if;
  if new.status = 'completed' and new.applied_at is null and new.last_error is not null
     and (old.last_error is distinct from new.last_error) then
    perform app.notify('esign_needs_attention', new.created_by, null, new.project_id, new.deal_id, new.client_id,
                       v_payload || jsonb_build_object('error', new.last_error), 'esign_attention:' || new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists notify_esign on public.esign_envelopes;
create trigger notify_esign after update on public.esign_envelopes
  for each row execute function app.tg_notify_esign();

-- Change orders approved → the customer's confirmation and the PM's note.
create or replace function app.tg_notify_change_order()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status and new.status = 'approved' then
    perform app.notify_customer(new.project_id, 'change_order_confirmed',
      jsonb_build_object('number', new.number, 'amount', new.amount_delta, 'reason', new.reason), 'co:' || new.id);
    perform app.notify_project_staff(new.project_id, 'change_order_approved',
      jsonb_build_object('number', new.number, 'amount', new.amount_delta, 'reason', new.reason), 'co:' || new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists notify_change_order on public.change_orders;
create trigger notify_change_order after insert or update on public.change_orders
  for each row execute function app.tg_notify_change_order();

-- A contact assigned to a rep.
create or replace function app.tg_notify_contact()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.owner_id is not null and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id)
     and new.owner_id is distinct from (select auth.uid()) then
    perform app.notify('lead_assigned', new.owner_id, null, null, null, new.id,
      jsonb_build_object('name', concat_ws(' ', new.first_name, new.last_name), 'stage', new.contact_stage),
      'lead:' || new.id || ':' || new.owner_id);
  end if;
  return new;
end;
$$;
drop trigger if exists notify_contact on public.clients;
create trigger notify_contact after insert or update on public.clients
  for each row execute function app.tg_notify_contact();

-- A deal won → admins.
create or replace function app.tg_notify_deal()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.stage is distinct from old.stage and new.stage = 'won' then
    perform app.notify_admins('deal_won', new.project_id, new.id, new.client_id,
      jsonb_build_object('customer', concat_ws(' ', new.customer_first, new.customer_last), 'value', new.contract_value),
      'won:' || new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists notify_deal on public.deals;
create trigger notify_deal after update on public.deals
  for each row execute function app.tg_notify_deal();

-- A low rating → the PM's feed (the follow-up email is the feedback module's).
create or replace function app.tg_notify_rating()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.score is not null and new.score <= 2 and (old.score is null or old.score > 2) then
    perform app.notify_project_staff(new.project_id, 'low_rating',
      jsonb_build_object('stage', new.stage, 'score', new.score, 'comment', left(coalesce(new.comment, ''), 200)),
      'rating:' || new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists notify_rating on public.stage_feedback;
create trigger notify_rating after insert or update on public.stage_feedback
  for each row execute function app.tg_notify_rating();

-- Commission payable → the dealer.
create or replace function app.tg_notify_commission()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status and new.status = 'payable' then
    perform app.notify_dealer(new.project_id, 'commission_payable',
      jsonb_build_object('amount', new.base_amount + new.adjustment, 'payable_date', new.payable_date), 'commission:' || new.project_id);
  end if;
  return new;
end;
$$;
drop trigger if exists notify_commission on public.commissions;
create trigger notify_commission after insert or update on public.commissions
  for each row execute function app.tg_notify_commission();

-- The AI's doubts (004800 fills this table) → the PM.
create or replace function app.tg_notify_exception()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.project_id is not null and new.raised_by = 'ai' then
    perform app.notify_project_staff(new.project_id, 'ai_exception',
      jsonb_build_object('summary', new.summary), 'exception:' || new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists notify_exception on public.exceptions;
create trigger notify_exception after insert on public.exceptions
  for each row execute function app.tg_notify_exception();

-- -----------------------------------------------------------------------------
-- 5. Reading, and delivering
-- -----------------------------------------------------------------------------
create or replace function public.unread_notification_count()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int from public.notifications n
   where n.user_id = (select auth.uid()) and n.read_at is null;
$$;

/** Mark some (or, with null, all) of the caller's notifications read. */
create or replace function public.mark_notifications_read(p_ids bigint[] default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  update public.notifications n set read_at = now()
   where n.user_id = (select auth.uid()) and n.read_at is null
     and (p_ids is null or n.id = any(p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

/**
 * Raise a notification from the application — the time-based rules and the
 * AI jobs. Admin and ops only: a sales rep cannot make the system nag a PM.
 */
create or replace function public.raise_notification(
  p_kind text, p_user uuid, p_project uuid, p_payload jsonb, p_dedupe text, p_after timestamptz default now())
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'only staff may raise notifications' using errcode = '42501';
  end if;
  return app.notify(p_kind, p_user, null, p_project, null, null, p_payload, p_dedupe, p_after);
end;
$$;

/**
 * The next notifications to deliver, claimed so two overlapping runs cannot
 * send the same one twice. Joined with the rule's channels and the recipient's
 * address. A homeowner's are held through quiet hours.
 */
create or replace function public.claim_notifications(p_limit integer default 200)
returns table (
  id bigint, kind text, audience text, in_app boolean, email boolean, push boolean,
  user_id uuid, recipient_email text, recipient_name text, email_opt_out boolean,
  project_id uuid, deal_id uuid, client_id uuid, payload jsonb, created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quiet timestamptz;
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'only staff may deliver notifications' using errcode = '42501';
  end if;
  -- Quiet hours (the chat module's rule): a homeowner's notifications wait for
  -- the morning. Staff and dealers are not held.
  v_quiet := public.chat_quiet_until();
  if v_quiet is not null then
    update public.notifications n set deliver_after = greatest(n.deliver_after, v_quiet)
      from public.notification_rules r
     where r.kind = n.kind and r.audience = 'customer'
       and n.delivered_at is null and n.claimed_at is null and n.deliver_after < v_quiet;
  end if;

  return query
    with picked as (
      select n.id from public.notifications n
       where n.delivered_at is null
         and n.deliver_after <= now()
         and (n.claimed_at is null or n.claimed_at < now() - interval '10 minutes')
       order by n.created_at
       limit p_limit
       for update skip locked
    ), claimed as (
      update public.notifications n set claimed_at = now()
        from picked where n.id = picked.id
      returning n.*
    )
    select c.id, c.kind, r.audience, r.in_app, r.email, r.push,
           c.user_id,
           coalesce(c.recipient_email, cl.email, pr.email) as recipient_email,
           coalesce(nullif(concat_ws(' ', cl.first_name, cl.last_name), ''), pr.full_name) as recipient_name,
           coalesce(cl.email_opt_out, false) as email_opt_out,
           c.project_id, c.deal_id, c.client_id, c.payload, c.created_at
      from claimed c
      join public.notification_rules r on r.kind = c.kind
      left join public.profiles pr on pr.id = c.user_id
      left join public.clients cl on (r.audience = 'customer' and (cl.user_id = c.user_id or cl.id = c.client_id))
     order by c.created_at;
end;
$$;

create or replace function public.notification_delivered(
  p_id bigint, p_emailed boolean, p_pushed boolean, p_error text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'only staff may deliver notifications' using errcode = '42501';
  end if;
  update public.notifications set
    delivered_at   = now(),
    emailed_at     = case when p_emailed then now() end,
    pushed_at      = case when p_pushed then now() end,
    delivery_error = p_error
  where id = p_id;
end;
$$;

/** A person's devices, for a staff or dealer push. Staff-only caller. */
create or replace function public.push_targets_for_user(p_user uuid)
returns table (endpoint text, p256dh text, auth text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.endpoint, s.p256dh, s.auth
    from public.push_subscriptions s
   where s.user_id = p_user and s.disabled_at is null
     and app.current_user_role() in ('admin', 'ops');
$$;

revoke execute on function app.notify(text, uuid, text, uuid, uuid, uuid, jsonb, text, timestamptz) from public, anon, authenticated;
revoke execute on function app.notify_customer(uuid, text, jsonb, text) from public, anon, authenticated;
revoke execute on function app.notify_project_staff(uuid, text, jsonb, text) from public, anon, authenticated;
revoke execute on function app.notify_admins(text, uuid, uuid, uuid, jsonb, text) from public, anon, authenticated;
revoke execute on function app.notify_dealer(uuid, text, jsonb, text) from public, anon, authenticated;
revoke execute on function app.notify_payment(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.unread_notification_count() from public, anon;
revoke execute on function public.mark_notifications_read(bigint[]) from public, anon;
revoke execute on function public.raise_notification(text, uuid, uuid, jsonb, text, timestamptz) from public, anon;
revoke execute on function public.claim_notifications(integer) from public, anon;
revoke execute on function public.notification_delivered(bigint, boolean, boolean, text) from public, anon;
revoke execute on function public.push_targets_for_user(uuid) from public, anon;
grant execute on function public.unread_notification_count() to authenticated;
grant execute on function public.mark_notifications_read(bigint[]) to authenticated;
grant execute on function public.raise_notification(text, uuid, uuid, jsonb, text, timestamptz) to authenticated;
grant execute on function public.claim_notifications(integer) to authenticated;
grant execute on function public.notification_delivered(bigint, boolean, boolean, text) to authenticated;
grant execute on function public.push_targets_for_user(uuid) to authenticated;



-- >>> 20260803004800_ai_automation.sql

-- =============================================================================
-- AI automation: a job queue, document suggestions and reply drafts
-- =============================================================================
-- Ask SolarFlow (004400-era) answers questions. This file gives the same model
-- work to do on its own, in the shape of small jobs the database records and
-- the application runs:
--
--   read_document   a PDF or photo was attached to a stage → read it, and
--                   propose values for the stage's fields (permit number,
--                   expiry date, PO number, system size…) with a confidence
--                   and the words in the document that support each one.
--   draft_reply     a homeowner wrote → draft the PM's answer from the
--                   project's own facts, ready to send or to edit.
--   briefing        each project manager's morning summary, at the hour the
--                   admin chose, written by the assistant under that PM's
--                   own permissions.
--
-- And one that needs no model at all: evidence-based auto-advance. When an
-- admin allows it for a stage, a project whose form and attachments are
-- complete moves on by itself — the same gate, the same move service, the
-- same audit entry as the green button.
--
-- Three tables:
--
--   ai_jobs          the queue. Rows are inserted by triggers here and by the
--                    scheduled job; claimed and finished by the application.
--   ai_suggestions   one row per proposed field value. Pending until a person
--                    accepts or rejects it — or applied at once when the admin
--                    has allowed that above a confidence threshold.
--   ai_reply_drafts  one draft per homeowner message the model answered.
--
-- Nothing here writes a stage field on its own. The application does, through
-- the same allowlist as the form (src/lib/stages/fields.ts), and only when the
-- admin has switched auto-apply on or a person pressed Accept. A document the
-- model was unsure about becomes an exception (raised_by 'ai'), which 004700
-- already turns into the PM's "AI needs a decision" notification.
--
-- Every switch defaults to the cautious side: reading on, auto-apply off,
-- auto-advance for no stage, drafts on, auto-send off, briefings on.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The switches
-- -----------------------------------------------------------------------------
alter table public.app_settings
  add column if not exists ai_document_reading     boolean not null default true,
  add column if not exists ai_auto_apply           boolean not null default false,
  add column if not exists ai_confidence_threshold numeric(3,2) not null default 0.85
    check (ai_confidence_threshold between 0.5 and 1),
  add column if not exists ai_auto_advance_stages  text[] not null default '{}',
  add column if not exists ai_reply_drafts         boolean not null default true,
  add column if not exists ai_reply_auto_send      boolean not null default false,
  add column if not exists ai_briefings            boolean not null default true;

-- -----------------------------------------------------------------------------
-- 1b. The automation's own identity
-- -----------------------------------------------------------------------------
-- The scheduled job and the automation act as an admin with the all-zeros id.
-- Until now nothing they did needed a profiles row; a stage move does — the
-- stage-history trigger records who moved it — so the service account gets a
-- real row. No password, never confirmed, so it cannot sign in; inactive and
-- soft-deleted, so it appears in no list and receives no notification. What it
-- does is attributed to it in the audit log and the stage history, which is
-- the point: "the automation moved this" rather than a name borrowed from a PM.
insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000', 'automation@solarflow.local',
        '{"user_role": "admin"}'::jsonb, '{"full_name": "SolarFlow automation"}'::jsonb)
on conflict (id) do nothing;
insert into public.profiles (id, role, email, full_name)
values ('00000000-0000-0000-0000-000000000000', 'admin', 'automation@solarflow.local', 'SolarFlow automation')
on conflict (id) do nothing;
update public.profiles
   set is_active = false, deleted_at = coalesce(deleted_at, now()), full_name = 'SolarFlow automation'
 where id = '00000000-0000-0000-0000-000000000000';

-- -----------------------------------------------------------------------------
-- 2. The queue
-- -----------------------------------------------------------------------------
create table if not exists public.ai_jobs (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('read_document', 'draft_reply', 'briefing')),
  project_id  uuid references public.projects (id) on delete cascade,
  -- What the job is about: a document id, a message id, 'user:date' for a briefing.
  entity_id   text not null,
  payload     jsonb not null default '{}'::jsonb,
  status      text not null default 'queued'
              check (status in ('queued', 'running', 'done', 'failed', 'skipped')),
  attempts    integer not null default 0,
  run_after   timestamptz not null default now(),
  locked_at   timestamptz,
  finished_at timestamptz,
  result      jsonb,
  error       text,
  created_at  timestamptz not null default now()
);

-- A document is read once, a message answered once, a briefing written once a day.
create unique index if not exists ai_jobs_entity_idx on public.ai_jobs (kind, entity_id);
create index if not exists ai_jobs_queue_idx on public.ai_jobs (run_after) where status in ('queued', 'running');
create index if not exists ai_jobs_project_idx on public.ai_jobs (project_id);

alter table public.ai_jobs enable row level security;
revoke all on public.ai_jobs from public, anon;
grant select on public.ai_jobs to authenticated;
drop policy if exists ai_jobs_select on public.ai_jobs;
create policy ai_jobs_select on public.ai_jobs
  for select to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops'));

/** Queue a job. Silent when the same job is already queued or done. */
create or replace function app.enqueue_ai_job(p_kind text, p_project uuid, p_entity text, p_payload jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare v_id bigint;
begin
  insert into public.ai_jobs (kind, project_id, entity_id, payload)
  values (p_kind, p_project, p_entity, coalesce(p_payload, '{}'::jsonb))
  on conflict (kind, entity_id) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

/** The scheduled job's way in: queue a briefing for a person on a date. */
create or replace function public.enqueue_ai_job(p_kind text, p_project uuid, p_entity text, p_payload jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select app.current_user_role()) not in ('admin', 'ops') then
    raise exception 'only staff queue automation' using errcode = '42501';
  end if;
  return app.enqueue_ai_job(p_kind, p_project, p_entity, p_payload);
end;
$$;
revoke execute on function public.enqueue_ai_job(text, uuid, text, jsonb) from public, anon;
grant execute on function public.enqueue_ai_job(text, uuid, text, jsonb) to authenticated;

/**
 * Claim up to p_limit jobs to run. A job left 'running' for ten minutes is
 * taken to have died with its process and is claimed again; after three
 * attempts it is failed for good, so a document the model cannot read does
 * not cost a call every ten minutes for ever.
 */
create or replace function public.claim_ai_jobs(p_limit integer default 10)
returns setof public.ai_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select app.current_user_role()) not in ('admin', 'ops') then
    raise exception 'only staff run automation' using errcode = '42501';
  end if;
  update public.ai_jobs j
     set status = 'failed', finished_at = now(),
         error = coalesce(j.error, 'gave up after ' || j.attempts || ' attempts')
   where j.status = 'running' and j.locked_at < now() - interval '10 minutes' and j.attempts >= 3;

  return query
    with picked as (
      select j.id from public.ai_jobs j
       where j.run_after <= now()
         and (j.status = 'queued'
              or (j.status = 'running' and j.locked_at < now() - interval '10 minutes'))
       order by j.created_at
       limit greatest(1, least(coalesce(p_limit, 10), 50))
       for update skip locked)
    update public.ai_jobs j
       set status = 'running', locked_at = now(), attempts = j.attempts + 1
      from picked where j.id = picked.id
    returning j.*;
end;
$$;
revoke execute on function public.claim_ai_jobs(integer) from public, anon;
grant execute on function public.claim_ai_jobs(integer) to authenticated;

create or replace function public.finish_ai_job(p_id bigint, p_status text, p_result jsonb, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select app.current_user_role()) not in ('admin', 'ops') then
    raise exception 'only staff run automation' using errcode = '42501';
  end if;
  if p_status not in ('done', 'failed', 'skipped', 'queued') then
    raise exception 'unknown job status %', p_status;
  end if;
  update public.ai_jobs
     set status = p_status,
         finished_at = case when p_status = 'queued' then null else now() end,
         -- 'queued' is a retry: back off a little so a flapping API is not hammered.
         run_after = case when p_status = 'queued' then now() + interval '2 minutes' else run_after end,
         locked_at = case when p_status = 'queued' then null else locked_at end,
         result = coalesce(p_result, result),
         error = left(p_error, 1000)
   where id = p_id;
end;
$$;
revoke execute on function public.finish_ai_job(bigint, text, jsonb, text) from public, anon;
grant execute on function public.finish_ai_job(bigint, text, jsonb, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Suggestions: what the reader proposed
-- -----------------------------------------------------------------------------
create table if not exists public.ai_suggestions (
  id          bigint generated always as identity primary key,
  project_id  uuid not null references public.projects (id) on delete cascade,
  document_id uuid references public.documents (id) on delete cascade,
  stage       public.project_stage not null,
  field       text not null,
  value       jsonb not null,
  confidence  numeric(3,2) not null check (confidence between 0 and 1),
  evidence    text,
  status      text not null default 'pending'
              check (status in ('pending', 'applied', 'rejected', 'superseded')),
  decided_by  uuid references public.profiles (id),
  decided_at  timestamptz,
  created_at  timestamptz not null default now()
);
create unique index if not exists ai_suggestions_doc_field_idx
  on public.ai_suggestions (document_id, field) where document_id is not null;
create index if not exists ai_suggestions_project_idx on public.ai_suggestions (project_id) where status = 'pending';

alter table public.ai_suggestions enable row level security;
revoke all on public.ai_suggestions from public, anon;
grant select, insert, update on public.ai_suggestions to authenticated;
drop policy if exists ai_suggestions_select on public.ai_suggestions;
create policy ai_suggestions_select on public.ai_suggestions
  for select to authenticated
  using ((select app.is_admin()) or app.is_project_staff(project_id));
drop policy if exists ai_suggestions_insert on public.ai_suggestions;
create policy ai_suggestions_insert on public.ai_suggestions
  for insert to authenticated
  with check ((select app.is_admin()) or app.is_project_staff(project_id));
drop policy if exists ai_suggestions_update on public.ai_suggestions;
create policy ai_suggestions_update on public.ai_suggestions
  for update to authenticated
  using ((select app.is_admin()) or app.is_project_staff(project_id))
  with check ((select app.is_admin()) or app.is_project_staff(project_id));

drop trigger if exists audit_row on public.ai_suggestions;
create trigger audit_row after update on public.ai_suggestions
  for each row execute function app.tg_audit_row();

/**
 * Once every suggestion from a document has been decided, the exception that
 * asked for the decisions closes itself. Kept in the database so it holds
 * whether the decision came from the exceptions screen or the stage form.
 */
create or replace function app.tg_ai_suggestion_decided()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status <> 'pending' and old.status = 'pending' and new.document_id is not null
     and not exists (select 1 from public.ai_suggestions s
                      where s.document_id = new.document_id and s.status = 'pending') then
    update public.exceptions e
       set status = 'resolved', resolved_at = now(), resolved_by = auth.uid(),
           resolution_notes = coalesce(e.resolution_notes, 'Every suggested value was decided.')
     where e.raised_by = 'ai' and e.entity_type = 'documents' and e.entity_id = new.document_id::text
       and e.status in ('open', 'acknowledged', 'in_progress');
  end if;
  return new;
end;
$$;
drop trigger if exists ai_suggestion_decided on public.ai_suggestions;
create trigger ai_suggestion_decided after update on public.ai_suggestions
  for each row execute function app.tg_ai_suggestion_decided();

-- -----------------------------------------------------------------------------
-- 4. Reply drafts
-- -----------------------------------------------------------------------------
create table if not exists public.ai_reply_drafts (
  id          bigint generated always as identity primary key,
  project_id  uuid not null references public.projects (id) on delete cascade,
  message_id  uuid not null references public.project_messages (id) on delete cascade,
  body        text not null,
  confidence  numeric(3,2) not null check (confidence between 0 and 1),
  -- The model's own view: does this need a person? Why?
  needs_human boolean not null default false,
  reason      text,
  status      text not null default 'draft'
              check (status in ('draft', 'sent', 'sent_auto', 'dismissed')),
  sent_message_id uuid references public.project_messages (id) on delete set null,
  decided_by  uuid references public.profiles (id),
  decided_at  timestamptz,
  created_at  timestamptz not null default now()
);
create unique index if not exists ai_reply_drafts_message_idx on public.ai_reply_drafts (message_id);
create index if not exists ai_reply_drafts_project_idx on public.ai_reply_drafts (project_id) where status = 'draft';

alter table public.ai_reply_drafts enable row level security;
revoke all on public.ai_reply_drafts from public, anon;
grant select, insert, update on public.ai_reply_drafts to authenticated;
drop policy if exists ai_reply_drafts_select on public.ai_reply_drafts;
create policy ai_reply_drafts_select on public.ai_reply_drafts
  for select to authenticated
  using ((select app.is_admin()) or app.is_project_staff(project_id));
drop policy if exists ai_reply_drafts_insert on public.ai_reply_drafts;
create policy ai_reply_drafts_insert on public.ai_reply_drafts
  for insert to authenticated
  with check ((select app.is_admin()) or app.is_project_staff(project_id));
drop policy if exists ai_reply_drafts_update on public.ai_reply_drafts;
create policy ai_reply_drafts_update on public.ai_reply_drafts
  for update to authenticated
  using ((select app.is_admin()) or app.is_project_staff(project_id))
  with check ((select app.is_admin()) or app.is_project_staff(project_id));

-- -----------------------------------------------------------------------------
-- 5. What queues the work
-- -----------------------------------------------------------------------------
-- A stage attachment (a document with a category) → read it. Chat attachments
-- and generated PDFs have no category and are left alone. Only formats the
-- model can read: PDFs and ordinary photos.
create or replace function app.tg_ai_document()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- 'chat' is the chat module's filing category, not a stage field.
  if new.category is null or new.category = 'chat' or new.project_id is null then return new; end if;
  if coalesce(new.mime_type, '') not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp') then
    return new;
  end if;
  if not coalesce((select s.ai_document_reading from public.app_settings s where s.id), true) then
    return new;
  end if;
  perform app.enqueue_ai_job('read_document', new.project_id, new.id::text,
    jsonb_build_object('category', new.category, 'title', new.title, 'mime', new.mime_type));
  return new;
end;
$$;
drop trigger if exists ai_document on public.documents;
create trigger ai_document after insert on public.documents
  for each row execute function app.tg_ai_document();

-- A homeowner's message → draft the answer.
create or replace function app.tg_ai_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.sender_role <> 'customer' or new.is_internal then return new; end if;
  if not coalesce((select s.ai_reply_drafts from public.app_settings s where s.id), true) then
    return new;
  end if;
  perform app.enqueue_ai_job('draft_reply', new.project_id, new.id::text, '{}'::jsonb);
  return new;
end;
$$;
drop trigger if exists ai_message on public.project_messages;
create trigger ai_message after insert on public.project_messages
  for each row execute function app.tg_ai_message();

-- -----------------------------------------------------------------------------
-- 6. The exceptions queue, as the screen reads it
-- -----------------------------------------------------------------------------
/** Open exceptions this person may see, with the project and the pending suggestion count. */
create or replace function public.open_exceptions()
returns table (
  id uuid, project_id uuid, project_code text, project_name text, customer_name text,
  entity_type text, entity_id text, severity text, status text, summary text, details jsonb,
  raised_by text, assigned_to uuid, assigned_name text, pending_suggestions integer, created_at timestamptz
)
language sql
security invoker
stable
set search_path = ''
as $$
  select e.id, e.project_id, p.code, p.name,
         nullif(btrim(concat_ws(' ', cl.first_name, cl.last_name)), ''),
         e.entity_type, e.entity_id, e.severity::text, e.status::text, e.summary, e.details,
         e.raised_by, e.assigned_to, coalesce(pr.full_name, pr.email),
         (select count(*) from public.ai_suggestions s
           where e.entity_type = 'documents' and s.document_id::text = e.entity_id and s.status = 'pending')::int,
         e.created_at
    from public.exceptions e
    left join public.projects p on p.id = e.project_id
    left join public.clients cl on cl.id = p.client_id
    left join public.profiles pr on pr.id = e.assigned_to
   where e.status in ('open', 'acknowledged', 'in_progress')
   order by array_position(array['critical','high','medium','low'], e.severity::text), e.created_at desc
$$;
revoke execute on function public.open_exceptions() from public, anon;
grant execute on function public.open_exceptions() to authenticated;



-- >>> migration bookkeeping (lets `npm run db:migrate` skip these later)
create table if not exists public.schema_migrations (
  name       text primary key,
  applied_at timestamptz not null default now()
);
insert into public.schema_migrations (name) values
  ('20260803000000_platform.sql'),
  ('20260803000100_init_schema_and_enums.sql'),
  ('20260803000200_tables.sql'),
  ('20260803000300_access_helpers.sql'),
  ('20260803000400_hooks_and_views.sql'),
  ('20260803000500_audit.sql'),
  ('20260803000600_rls_policies.sql'),
  ('20260803000700_storage.sql'),
  ('20260803000800_add_ops_role.sql'),
  ('20260803000900_auth_module.sql'),
  ('20260803001000_auth_engine.sql'),
  ('20260803001100_file_storage.sql'),
  ('20260803001200_manual_version.sql'),
  ('20260803001300_admin_panel.sql'),
  ('20260803001400_stage_fields.sql'),
  ('20260803001500_complete_hold_cancel.sql'),
  ('20260803001600_complete_stage_backfill.sql'),
  ('20260803001700_project_details.sql'),
  ('20260803001800_equipment_quantities.sql'),
  ('20260803001900_dealer_portal.sql'),
  ('20260803002000_dealer_companies.sql'),
  ('20260803002100_restore_project_defaults.sql'),
  ('20260803002200_report_builder.sql'),
  ('20260803002300_customer_portal.sql'),
  ('20260803002400_customer_management.sql'),
  ('20260803002500_mobile_app.sql'),
  ('20260803002600_customer_passwords.sql'),
  ('20260803002700_invite_customers_with_tokens.sql'),
  ('20260803002800_dashboard.sql'),
  ('20260803002900_project_chat.sql'),
  ('20260803003000_sign_in.sql'),
  ('20260803003100_typical_durations.sql'),
  ('20260803003200_stage_feedback.sql'),
  ('20260803003300_add_sales_role.sql'),
  ('20260803003400_crm_foundation.sql'),
  ('20260803003500_deals.sql'),
  ('20260803003600_contact_intake.sql'),
  ('20260803003700_contact_create.sql'),
  ('20260803003800_contact_stages.sql'),
  ('20260803003900_contract_signed_system.sql'),
  ('20260803004000_project_holds_contact.sql'),
  ('20260803004100_signing_creates_project.sql'),
  ('20260803004200_sales_see_deal_projects.sql'),
  ('20260803004300_stage_upload_fix.sql'),
  ('20260803004400_esignature.sql'),
  ('20260803004500_sales_see_dealer_names.sql'),
  ('20260803004600_stage_fields_solar.sql'),
  ('20260803004700_notifications.sql'),
  ('20260803004800_ai_automation.sql')
on conflict (name) do nothing;
