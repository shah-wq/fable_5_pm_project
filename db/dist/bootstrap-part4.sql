-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
-- Bootstrap part 4 of 4 for a fresh database via a SQL console (e.g. Neon SQL Editor).
-- Run the parts in order, each as its own execution.
-- Includes: 20260803003400_crm_foundation.sql, 20260803003500_deals.sql, 20260803003600_contact_intake.sql, 20260803003700_contact_create.sql, migration bookkeeping
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
    raise exception 'Run 20260803001900_dealer_portal.sql first — leads is the table this renames.';
  end if;
  if to_regclass('public.clients') is null then
    raise exception 'Run 20260803000200_tables.sql first — clients is the person record this extends.';
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
    raise exception 'Run 20260803003300_add_sales_role.sql first, in its own script.';
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
    raise exception 'Run 20260803003400_crm_foundation.sql first — it creates deals.';
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
    raise exception 'Run 20260803003400_crm_foundation.sql first — it creates deals.';
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
    raise exception 'Run 20260803003400_crm_foundation.sql first — it creates deals.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'clients'
                    and column_name = 'mailing_street') then
    raise exception 'Run 20260803003600_contact_intake.sql first — it adds the intake fields.';
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
    mailing_street, mailing_city, mailing_state, mailing_postal_code, mailing_country)
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
    p_client ->> 'mailing_postal_code', p_client ->> 'mailing_country')
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
  ('20260803003700_contact_create.sql')
on conflict (name) do nothing;
