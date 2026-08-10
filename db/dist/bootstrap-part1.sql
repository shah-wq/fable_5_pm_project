-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
-- Bootstrap part 1 of 3 for a fresh database via a SQL console (e.g. Neon SQL Editor).
-- Run the parts in order, each as its own execution.
-- Includes: 20260803000000_platform.sql, 20260803000100_init_schema_and_enums.sql, 20260803000200_tables.sql, 20260803000300_access_helpers.sql, 20260803000400_hooks_and_views.sql, 20260803000500_audit.sql, 20260803000600_rls_policies.sql, 20260803000700_storage.sql, 20260803000800_add_ops_role.sql
-- ============================================================================

-- >>> 20260803000000_platform.sql

-- =============================================================================
-- 000000 — Platform baseline (plain PostgreSQL, no Supabase)
-- =============================================================================
-- Recreates the platform surface the rest of the migrations build on: the
-- role model, the auth schema (users + request-claims helpers), and the
-- storage schema (bucket/object metadata; blob bytes arrive in 001100).
--
-- How requests are authorized without Supabase:
--   * The app connects with DATABASE_URL and, for every request, runs
--       set_config('request.jwt.claims', <session claims>, true)
--       SET LOCAL ROLE authenticated
--     inside a transaction (src/lib/db.ts). auth.uid()/auth.jwt() read those
--     claims, so every RLS policy in 000600/000700 keeps working unchanged.
--   * SET LOCAL ROLE also means a superuser DATABASE_URL cannot silently
--     bypass RLS — enforcement happens as `authenticated` either way.
--
-- Run migrations as a privileged user (it must own these objects); run the
-- app as any user that can SET ROLE authenticated.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    begin
      create role service_role nologin bypassrls;
    exception when insufficient_privilege then
      -- Managed Postgres (Neon, RDS, ...) has no superuser, and BYPASSRLS
      -- needs one. The app never connects as service_role — it exists for
      -- grant symmetry — so a plain role is fine there.
      create role service_role nologin;
    end;
  end if;

  -- The app's data layer runs SET LOCAL ROLE authenticated on every
  -- transaction. A superuser can always do that; on managed Postgres the
  -- migration runner (e.g. neondb_owner) needs the membership explicitly.
  execute format('grant anon, authenticated to %I', current_user);
end
$$;

-- extensions schema -----------------------------------------------------------
create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;

-- pgcrypto: password hashing (crypt/gen_salt), token hashing (digest),
-- token generation (gen_random_bytes).
create extension if not exists pgcrypto with schema extensions;

-- auth schema ------------------------------------------------------------------
create schema if not exists auth;

create table auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text not null,
  encrypted_password text,
  email_confirmed_at timestamptz,
  last_sign_in_at    timestamptz,
  failed_attempts    integer not null default 0,
  locked_until       timestamptz,
  raw_app_meta_data  jsonb not null default '{}'::jsonb,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index users_email_lower_idx on auth.users (lower(email));

-- Request-scoped identity, set per transaction by the app.
create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(auth.jwt() ->> 'role', 'anon');
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.jwt(), auth.uid(), auth.role()
  to anon, authenticated, service_role;

-- storage schema ----------------------------------------------------------------
create schema if not exists storage;

create table storage.buckets (
  id                 text primary key,
  name               text unique not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text not null references storage.buckets (id),
  name       text not null,
  owner      uuid,
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bucket_id, name)
);

alter table storage.objects enable row level security;

create or replace function storage.foldername(name text)
returns text[]
language sql
immutable
as $$
  select (string_to_array(name, '/'))[1 : cardinality(string_to_array(name, '/')) - 1];
$$;

grant usage on schema storage to anon, authenticated, service_role;
grant select on storage.buckets to authenticated;
grant select, insert, update, delete on storage.objects to authenticated;
grant all on storage.buckets, storage.objects to service_role;



-- >>> 20260803000100_init_schema_and_enums.sql

-- =============================================================================
-- 000100 — Init: app schema, enums, generic helpers
-- =============================================================================
-- Everything role/permission related lives behind helper functions in the
-- `app` schema so that RLS policies stay one-liners and the logic is defined
-- in exactly one place. `app` is NOT exposed through PostgREST (only `public`
-- is in config.toml), so these are internal building blocks.

create schema if not exists app;

grant usage on schema app to authenticated;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

-- §2 roles. One role per user, stored on public.profiles and stamped
-- request claims (`user_role`) by the session layer on every request.
create type public.user_role as enum (
  'admin',
  'designer',
  'customer',
  'dealer',
  'finance'
);

create type public.project_stage as enum (
  'intake',
  'site_survey',
  'design',
  'design_review',
  'engineering',
  'permitting',
  'permit_approved',
  'installation',
  'inspection',
  'pto',
  'complete'
);

create type public.project_status as enum (
  'active',
  'on_hold',
  'cancelled',
  'complete'
);

create type public.design_status as enum (
  'draft',
  'in_review',
  'approved',
  'rejected',
  'superseded'
);

create type public.permit_status as enum (
  'not_started',
  'preparing',
  'submitted',
  'in_review',
  'revisions_required',
  'approved',
  'rejected',
  'expired'
);

create type public.change_order_status as enum (
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'void'
);

create type public.vendor_quote_status as enum (
  'requested',
  'received',
  'accepted',
  'declined',
  'expired'
);

create type public.exception_status as enum (
  'open',
  'acknowledged',
  'in_progress',
  'resolved',
  'dismissed'
);

create type public.exception_severity as enum (
  'low',
  'medium',
  'high',
  'critical'
);

create type public.slot_status as enum (
  'open',
  'held',
  'booked',
  'cancelled'
);

create type public.document_kind as enum (
  'dwg',
  'pdf',
  'photo',
  'contract',
  'permit_doc',
  'other'
);

-- -----------------------------------------------------------------------------
-- Generic helpers (no table dependencies)
-- -----------------------------------------------------------------------------

-- Keep updated_at honest on every table that has one.
create or replace function app.tg_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;



-- >>> 20260803000200_tables.sql

-- =============================================================================
-- 000200 — All tables (§3), incl. AI-era tables created now so phase two needs
-- zero schema migration. RLS is enabled in 000600; audit triggers in 000500.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Identity & orgs
-- -----------------------------------------------------------------------------

-- One row per auth user. Created automatically by app.tg_handle_new_user()
-- (000400). `role` is the single source of truth for §2 authorization; it is
-- carried in the per-request claims (`user_role`) by the session layer.
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  role        public.user_role not null default 'customer',
  full_name   text,
  email       text,
  phone       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger set_updated_at before update on public.profiles
  for each row execute function app.tg_set_updated_at();

-- Dealer organizations. A dealer's "book" = every client/project whose
-- dealer_id points here.
create table public.dealers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  code        text unique,
  email       text,
  phone       text,
  address     jsonb not null default '{}'::jsonb,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger set_updated_at before update on public.dealers
  for each row execute function app.tg_set_updated_at();

-- Membership of auth users in a dealer org (a dealer org can have several
-- logins). A user with role 'dealer' sees exactly the books of the dealers
-- they belong to.
create table public.dealer_users (
  dealer_id   uuid not null references public.dealers (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  is_owner    boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (dealer_id, user_id)
);

create index dealer_users_user_id_idx on public.dealer_users (user_id);

-- Design staff. Separate from profiles so capacity/skill data doesn't live on
-- the identity row and so a designer can exist before their login does.
create table public.designers (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid unique references public.profiles (id) on delete set null,
  display_name            text not null,
  skills                  text[] not null default '{}',
  max_concurrent_projects integer not null default 10,
  timezone                text not null default 'UTC',
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create trigger set_updated_at before update on public.designers
  for each row execute function app.tg_set_updated_at();

-- Homeowners. `user_id` is set once the customer activates their portal login.
create table public.clients (
  id          uuid primary key default gen_random_uuid(),
  dealer_id   uuid not null references public.dealers (id),
  user_id     uuid unique references public.profiles (id) on delete set null,
  first_name  text not null,
  last_name   text not null,
  email       text,
  phone       text,
  address     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index clients_dealer_id_idx on public.clients (dealer_id);

create trigger set_updated_at before update on public.clients
  for each row execute function app.tg_set_updated_at();

-- -----------------------------------------------------------------------------
-- Reference data
-- -----------------------------------------------------------------------------

-- Authorities Having Jurisdiction (permitting offices).
create table public.jurisdictions (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null,
  state                   text not null,
  county                  text,
  ahj_code                text,
  requirements            jsonb not null default '{}'::jsonb,
  typical_turnaround_days integer,
  contact                 jsonb not null default '{}'::jsonb,
  notes                   text,
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create unique index jurisdictions_state_name_idx on public.jurisdictions (state, name);

create trigger set_updated_at before update on public.jurisdictions
  for each row execute function app.tg_set_updated_at();

create table public.utilities (
  id                           uuid primary key default gen_random_uuid(),
  name                         text not null,
  state                        text not null,
  interconnection_requirements jsonb not null default '{}'::jsonb,
  is_active                    boolean not null default true,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

create trigger set_updated_at before update on public.utilities
  for each row execute function app.tg_set_updated_at();

-- Catalog of parts/services with cost & price. AI-era table (quoting/BOM
-- automation) — created now, written manually until phase two.
create table public.price_book (
  id             uuid primary key default gen_random_uuid(),
  sku            text not null unique,
  name           text not null,
  category       text,
  description    text,
  manufacturer   text,
  unit           text not null default 'each',
  unit_cost      numeric(12,2),
  unit_price     numeric(12,2),
  effective_from date,
  effective_to   date,
  is_active      boolean not null default true,
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger set_updated_at before update on public.price_book
  for each row execute function app.tg_set_updated_at();

-- Rules that add line-item charges when a condition matches (e.g. metal roof,
-- main panel upgrade). `condition` is a JSON predicate evaluated by the app.
create table public.adder_rules (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  condition   jsonb not null default '{}'::jsonb,
  amount      numeric(12,2) not null,
  amount_type text not null default 'flat' check (amount_type in ('flat', 'per_watt', 'percent')),
  priority    integer not null default 100,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger set_updated_at before update on public.adder_rules
  for each row execute function app.tg_set_updated_at();

create table public.vendors (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  contact    jsonb not null default '{}'::jsonb,
  categories text[] not null default '{}',
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at before update on public.vendors
  for each row execute function app.tg_set_updated_at();

-- -----------------------------------------------------------------------------
-- Projects & pipeline
-- -----------------------------------------------------------------------------

create table public.projects (
  id                   uuid primary key default gen_random_uuid(),
  code                 text not null unique default ('PRJ-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
  name                 text not null,
  dealer_id            uuid not null references public.dealers (id),
  client_id            uuid not null references public.clients (id),
  jurisdiction_id      uuid references public.jurisdictions (id),
  utility_id           uuid references public.utilities (id),
  assigned_designer_id uuid references public.designers (id),
  stage                public.project_stage not null default 'intake',
  status               public.project_status not null default 'active',
  priority             integer not null default 0,
  system_size_kw       numeric(8,3),
  panel_count          integer,
  site_address         jsonb not null default '{}'::jsonb,
  -- Financial columns below are the finance-role whitelist surface; the
  -- finance role reads them through public.project_financials (000400).
  contract_value       numeric(12,2),
  dealer_fee           numeric(12,2),
  amount_invoiced      numeric(12,2) not null default 0,
  amount_paid          numeric(12,2) not null default 0,
  target_install_date  date,
  metadata             jsonb not null default '{}'::jsonb,
  created_by           uuid references public.profiles (id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index projects_dealer_id_idx on public.projects (dealer_id);
create index projects_client_id_idx on public.projects (client_id);
create index projects_assigned_designer_id_idx on public.projects (assigned_designer_id);
create index projects_jurisdiction_id_idx on public.projects (jurisdiction_id);
create index projects_stage_idx on public.projects (stage);

create trigger set_updated_at before update on public.projects
  for each row execute function app.tg_set_updated_at();

-- Stage history. Written automatically by app.tg_project_stage_change()
-- (000400) whenever projects.stage changes; manual inserts allowed for staff.
create table public.project_stage_events (
  id         bigint generated always as identity primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  from_stage public.project_stage,
  to_stage   public.project_stage not null,
  changed_by uuid references public.profiles (id),
  changed_at timestamptz not null default now(),
  notes      text
);

create index project_stage_events_project_id_idx on public.project_stage_events (project_id, changed_at desc);

-- Designer scheduling. AI-era table (automated survey/review booking) —
-- created now so phase two needs no migration. Open slots are readable by all
-- authenticated users so booking flows can offer them.
create table public.availability_slots (
  id          uuid primary key default gen_random_uuid(),
  designer_id uuid not null references public.designers (id) on delete cascade,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  status      public.slot_status not null default 'open',
  slot_type   text not null default 'design_review',
  project_id  uuid references public.projects (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index availability_slots_designer_id_idx on public.availability_slots (designer_id, starts_at);
create index availability_slots_status_idx on public.availability_slots (status) where status = 'open';

create trigger set_updated_at before update on public.availability_slots
  for each row execute function app.tg_set_updated_at();

-- -----------------------------------------------------------------------------
-- Files
-- -----------------------------------------------------------------------------

-- Registry row for every object in the storage buckets (000700). The object
-- itself lives in storage; this row carries project scoping and the
-- customer_visible flag that storage policies and the UI both key off.
create table public.documents (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id) on delete cascade,
  bucket           text not null,
  object_path      text not null,
  kind             public.document_kind not null default 'other',
  title            text,
  customer_visible boolean not null default false,
  mime_type        text,
  size_bytes       bigint,
  uploaded_by      uuid references public.profiles (id),
  created_at       timestamptz not null default now(),
  unique (bucket, object_path)
);

create index documents_project_id_idx on public.documents (project_id);

-- -----------------------------------------------------------------------------
-- Design
-- -----------------------------------------------------------------------------

create table public.designs (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id) on delete cascade,
  version        integer not null default 1,
  status         public.design_status not null default 'draft',
  designer_id    uuid references public.designers (id),
  layout         jsonb not null default '{}'::jsonb,
  system_size_kw numeric(8,3),
  panel_count    integer,
  inverter_model text,
  notes          text,
  submitted_at   timestamptz,
  approved_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (project_id, version)
);

create index designs_project_id_idx on public.designs (project_id);

create trigger set_updated_at before update on public.designs
  for each row execute function app.tg_set_updated_at();

-- Links a design version to its files (DWG, stamped PDF, ...).
create table public.design_assets (
  id          uuid primary key default gen_random_uuid(),
  design_id   uuid not null references public.designs (id) on delete cascade,
  document_id uuid not null references public.documents (id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (design_id, document_id)
);

create index design_assets_design_id_idx on public.design_assets (design_id);

create table public.site_surveys (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  slot_id      uuid references public.availability_slots (id) on delete set null,
  scheduled_at timestamptz,
  completed_at timestamptz,
  surveyor     text,
  findings     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index site_surveys_project_id_idx on public.site_surveys (project_id);

create trigger set_updated_at before update on public.site_surveys
  for each row execute function app.tg_set_updated_at();

-- -----------------------------------------------------------------------------
-- Pricing & procurement
-- -----------------------------------------------------------------------------

-- Adders applied to a specific project (from a rule, a human, or — phase
-- two — the AI). Snapshot name/amount so rule edits don't rewrite history.
create table public.project_adders (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  adder_rule_id uuid references public.adder_rules (id),
  name          text not null,
  amount        numeric(12,2) not null,
  amount_type   text not null default 'flat' check (amount_type in ('flat', 'per_watt', 'percent')),
  source        text not null default 'manual' check (source in ('rule', 'manual', 'ai')),
  approved      boolean not null default false,
  created_by    uuid references public.profiles (id),
  created_at    timestamptz not null default now()
);

create index project_adders_project_id_idx on public.project_adders (project_id);

create table public.change_orders (
  id                          uuid primary key default gen_random_uuid(),
  project_id                  uuid not null references public.projects (id) on delete cascade,
  number                      integer not null,
  status                      public.change_order_status not null default 'draft',
  reason                      text,
  description                 text,
  amount_delta                numeric(12,2) not null default 0,
  requires_customer_signature boolean not null default true,
  document_id                 uuid references public.documents (id),
  requested_by                uuid references public.profiles (id),
  approved_by                 uuid references public.profiles (id),
  approved_at                 timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (project_id, number)
);

create index change_orders_project_id_idx on public.change_orders (project_id);

create trigger set_updated_at before update on public.change_orders
  for each row execute function app.tg_set_updated_at();

-- Vendor pricing. AI-era table (automated quote solicitation) — created now.
create table public.vendor_quotes (
  id           uuid primary key default gen_random_uuid(),
  vendor_id    uuid not null references public.vendors (id),
  project_id   uuid references public.projects (id) on delete set null,
  status       public.vendor_quote_status not null default 'requested',
  quote_number text,
  line_items   jsonb not null default '[]'::jsonb,
  total        numeric(12,2),
  valid_until  date,
  document_id  uuid references public.documents (id),
  requested_by uuid references public.profiles (id),
  received_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index vendor_quotes_vendor_id_idx on public.vendor_quotes (vendor_id);
create index vendor_quotes_project_id_idx on public.vendor_quotes (project_id);

create trigger set_updated_at before update on public.vendor_quotes
  for each row execute function app.tg_set_updated_at();

-- Bill of materials per design. project_id is denormalized from the design on
-- purpose: RLS and common queries filter by project without a join.
create table public.bom_items (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id) on delete cascade,
  design_id       uuid not null references public.designs (id) on delete cascade,
  price_book_id   uuid references public.price_book (id),
  vendor_quote_id uuid references public.vendor_quotes (id),
  sku             text,
  description     text not null,
  quantity        numeric(12,3) not null default 1 check (quantity > 0),
  unit_cost       numeric(12,2),
  unit_price      numeric(12,2),
  source          text not null default 'manual' check (source in ('manual', 'rule', 'ai')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index bom_items_project_id_idx on public.bom_items (project_id);
create index bom_items_design_id_idx on public.bom_items (design_id);

create trigger set_updated_at before update on public.bom_items
  for each row execute function app.tg_set_updated_at();

-- -----------------------------------------------------------------------------
-- Permitting
-- -----------------------------------------------------------------------------

create table public.permits (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id) on delete cascade,
  jurisdiction_id uuid not null references public.jurisdictions (id),
  permit_type     text not null default 'building',
  status          public.permit_status not null default 'not_started',
  permit_number   text,
  fees            numeric(12,2),
  submitted_at    timestamptz,
  approved_at     timestamptz,
  expires_at      timestamptz,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index permits_project_id_idx on public.permits (project_id);
create index permits_jurisdiction_id_idx on public.permits (jurisdiction_id);

create trigger set_updated_at before update on public.permits
  for each row execute function app.tg_set_updated_at();

create table public.permit_events (
  id          bigint generated always as identity primary key,
  permit_id   uuid not null references public.permits (id) on delete cascade,
  from_status public.permit_status,
  to_status   public.permit_status not null,
  actor_id    uuid references public.profiles (id),
  occurred_at timestamptz not null default now(),
  notes       text
);

create index permit_events_permit_id_idx on public.permit_events (permit_id, occurred_at desc);

-- -----------------------------------------------------------------------------
-- AI-era feedback & exception queue (created now, mostly unused in phase one)
-- -----------------------------------------------------------------------------

-- Per-stage feedback from any participant (and later, AI self-critique).
create table public.stage_feedback (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  stage      public.project_stage not null,
  rating     integer check (rating between 1 and 5),
  feedback   text,
  source     text not null default 'customer' check (source in ('customer', 'dealer', 'designer', 'ai')),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

create index stage_feedback_project_id_idx on public.stage_feedback (project_id);

-- Work queue of things a human must look at (rule conflicts, AI low
-- confidence, SLA breaches, ...).
create table public.exceptions (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid references public.projects (id) on delete cascade,
  entity_type      text,
  entity_id        text,
  severity         public.exception_severity not null default 'medium',
  status           public.exception_status not null default 'open',
  summary          text not null,
  details          jsonb not null default '{}'::jsonb,
  raised_by        text not null default 'system',
  assigned_to      uuid references public.profiles (id),
  resolved_by      uuid references public.profiles (id),
  resolved_at      timestamptz,
  resolution_notes text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index exceptions_project_id_idx on public.exceptions (project_id);
create index exceptions_status_idx on public.exceptions (status) where status in ('open', 'acknowledged', 'in_progress');
create index exceptions_assigned_to_idx on public.exceptions (assigned_to);

create trigger set_updated_at before update on public.exceptions
  for each row execute function app.tg_set_updated_at();

-- -----------------------------------------------------------------------------
-- Audit log (writer utilities in 000500)
-- -----------------------------------------------------------------------------

-- Append-only. Rows are written only through app.write_audit() (SECURITY
-- DEFINER); direct DML is revoked and update/delete is blocked by trigger.
create table public.audit_log (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id    uuid,
  actor_role  public.user_role,
  action      text not null,
  entity_type text not null,
  entity_id   text,
  project_id  uuid,
  old_data    jsonb,
  new_data    jsonb,
  context     jsonb not null default '{}'::jsonb
);

create index audit_log_project_id_idx on public.audit_log (project_id, occurred_at desc);
create index audit_log_entity_idx on public.audit_log (entity_type, entity_id);
create index audit_log_actor_id_idx on public.audit_log (actor_id, occurred_at desc);



-- >>> 20260803000300_access_helpers.sql

-- =============================================================================
-- 000300 — Access helpers used by every RLS policy (000600, 000700)
-- =============================================================================
-- All are SECURITY DEFINER with an empty search_path: they read the tables
-- they need as the owner, which keeps policy evaluation free of RLS recursion
-- (e.g. the clients policy can reference projects without re-entering the
-- projects policy).

-- Resolve the caller's §2 role. Prefers the `user_role` request claim (set by
-- the app session layer per request); falls back to profiles for
-- sessions minted before the hook ran.
create or replace function app.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when (select auth.jwt() ->> 'user_role')
         in ('admin', 'designer', 'customer', 'dealer', 'finance')
      then ((select auth.jwt() ->> 'user_role'))::public.user_role
    else (select p.role from public.profiles p where p.id = (select auth.uid()))
  end;
$$;

create or replace function app.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.current_user_role() = 'admin';
$$;

-- The designers.id of the calling user, if any.
create or replace function app.current_designer_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.id from public.designers d where d.user_id = (select auth.uid());
$$;

-- Every dealer org the calling user belongs to.
create or replace function app.current_dealer_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select du.dealer_id from public.dealer_users du where du.user_id = (select auth.uid());
$$;

-- Every client record linked to the calling user's login.
create or replace function app.current_client_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id from public.clients c where c.user_id = (select auth.uid());
$$;

-- §2 project visibility: admin → all; designer → their queue; dealer → their
-- book; customer → their own project. Finance is deliberately absent — it
-- reads the whitelisted columns via public.project_financials (000400), never
-- project rows directly.
create or replace function app.can_access_project(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.projects p
    where p.id = pid
      and (
        app.current_user_role() = 'admin'
        or p.assigned_designer_id = app.current_designer_id()
        or p.dealer_id in (select app.current_dealer_ids())
        or p.client_id in (select app.current_client_ids())
      )
  );
$$;

-- Staff on a project = admin or its assigned designer. Gate for internal
-- tables (BOM, vendor quotes, exceptions) and for writes.
create or replace function app.is_project_staff(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.current_user_role() = 'admin'
      or exists (
           select 1
           from public.projects p
           where p.id = pid
             and p.assigned_designer_id = app.current_designer_id()
         );
$$;

-- Storage objects are keyed as '<project_id>/...'; extract the project id
-- from an object name, null when the prefix isn't a UUID.
create or replace function app.storage_object_project(object_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when object_name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
      then left(object_name, 36)::uuid
  end;
$$;

grant execute on all functions in schema app to authenticated;



-- >>> 20260803000400_hooks_and_views.sql

-- =============================================================================
-- 000400 — User lifecycle, JWT claim hook, stage-history trigger, finance view
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Profile bootstrap: every auth user gets a profiles row. Role can be
-- pre-assigned by an admin/service via raw_app_meta_data.user_role (app
-- metadata is not user-editable); everyone else starts as 'customer'.
-- -----------------------------------------------------------------------------

create or replace function app.tg_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.user_role;
begin
  v_role := case
    when new.raw_app_meta_data ->> 'user_role'
         in ('admin', 'designer', 'customer', 'dealer', 'finance')
      then (new.raw_app_meta_data ->> 'user_role')::public.user_role
    else 'customer'::public.user_role
  end;

  insert into public.profiles (id, role, email, full_name)
  values (new.id, v_role, new.email, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.tg_handle_new_user();

-- Only admins (or service-role / server-side SQL) may change a profile's role.
create or replace function app.tg_guard_profile_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role is distinct from old.role
     and (select auth.uid()) is not null                          -- SQL / migration context is exempt
     and coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
     and not app.is_admin()
  then
    raise exception 'only admins may change a profile role'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger guard_profile_role
  before update on public.profiles
  for each row execute function app.tg_guard_profile_role();

-- -----------------------------------------------------------------------------
-- Stage history: any change to projects.stage writes a project_stage_events
-- row, no matter which module made the change.
-- -----------------------------------------------------------------------------

create or replace function app.tg_project_stage_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.stage is distinct from old.stage then
    insert into public.project_stage_events (project_id, from_stage, to_stage, changed_by)
    values (new.id, old.stage, new.stage, (select auth.uid()));
  end if;
  return new;
end;
$$;

create trigger on_project_stage_change
  after update on public.projects
  for each row execute function app.tg_project_stage_change();

-- -----------------------------------------------------------------------------
-- Finance surface: the §2 whitelisted-columns view. The finance role has no
-- SELECT policy on public.projects at all — this view (owned by postgres, so
-- it bypasses the base table's RLS) is its only window, and its WHERE clause
-- restricts it to finance and admin callers. No PII / site / design columns.
-- -----------------------------------------------------------------------------

create view public.project_financials
with (security_barrier = true, security_invoker = false)
as
select
  p.id,
  p.code,
  p.name,
  p.stage,
  p.status,
  p.dealer_id,
  p.client_id,
  p.system_size_kw,
  p.contract_value,
  p.dealer_fee,
  p.amount_invoiced,
  p.amount_paid,
  p.target_install_date,
  p.created_at,
  p.updated_at
from public.projects p
where app.current_user_role() in ('finance', 'admin');

grant select on public.project_financials to authenticated;



-- >>> 20260803000500_audit.sql

-- =============================================================================
-- 000500 — Audit log writer (the shared utility every later module calls)
-- =============================================================================
-- Three entry points, one sink:
--   * app.write_audit(...)        — SQL-side writer, callable from any
--                                    function/trigger in later migrations.
--   * app.tg_audit_row()          — generic row trigger attached to the core
--                                    business tables below; captures OLD/NEW.
--   * public.log_audit_event(...) — RPC for application code
--                                    (src/lib/audit.ts wraps it).
-- audit_log itself is append-only: direct DML is revoked in 000600 and
-- update/delete raise even for definer code via tg_audit_log_immutable.

create or replace function app.write_audit(
  p_action      text,
  p_entity_type text,
  p_entity_id   text default null,
  p_project_id  uuid default null,
  p_old_data    jsonb default null,
  p_new_data    jsonb default null,
  p_context     jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if p_action is null or btrim(p_action) = '' then
    raise exception 'audit action must not be empty';
  end if;
  if p_entity_type is null or btrim(p_entity_type) = '' then
    raise exception 'audit entity_type must not be empty';
  end if;

  insert into public.audit_log
    (actor_id, actor_role, action, entity_type, entity_id, project_id, old_data, new_data, context)
  values
    ((select auth.uid()),
     app.current_user_role(),
     btrim(p_action),
     btrim(p_entity_type),
     p_entity_id,
     p_project_id,
     p_old_data,
     p_new_data,
     coalesce(p_context, '{}'::jsonb))
  returning id into v_id;

  return v_id;
end;
$$;

-- Generic row auditor. Derives the project id from the row itself so one
-- trigger fits every table: projects use their own id, everything else its
-- project_id column (null when the table has none).
create or replace function app.tg_audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_project_id uuid;
begin
  if tg_table_name = 'projects' then
    v_project_id := (v_row ->> 'id')::uuid;
  else
    v_project_id := (v_row ->> 'project_id')::uuid;
  end if;

  perform app.write_audit(
    lower(tg_op),
    tg_table_name,
    v_row ->> 'id',
    v_project_id,
    v_old,
    v_new
  );

  return coalesce(new, old);
end;
$$;

-- Attach to the tables whose history matters for compliance/debugging.
-- (project_stage_events / permit_events are themselves history tables, and
-- audit_log auditing itself would recurse — leave those out.)
create trigger audit_row after insert or update or delete on public.projects
  for each row execute function app.tg_audit_row();
create trigger audit_row after insert or update or delete on public.clients
  for each row execute function app.tg_audit_row();
create trigger audit_row after insert or update or delete on public.designs
  for each row execute function app.tg_audit_row();
create trigger audit_row after insert or update or delete on public.change_orders
  for each row execute function app.tg_audit_row();
create trigger audit_row after insert or update or delete on public.permits
  for each row execute function app.tg_audit_row();
create trigger audit_row after insert or update or delete on public.project_adders
  for each row execute function app.tg_audit_row();
create trigger audit_row after insert or update or delete on public.bom_items
  for each row execute function app.tg_audit_row();
create trigger audit_row after insert or update or delete on public.vendor_quotes
  for each row execute function app.tg_audit_row();
create trigger audit_row after insert or update or delete on public.exceptions
  for each row execute function app.tg_audit_row();
create trigger audit_row after insert or update or delete on public.documents
  for each row execute function app.tg_audit_row();
create trigger audit_row after insert or update or delete on public.price_book
  for each row execute function app.tg_audit_row();
create trigger audit_row after insert or update or delete on public.adder_rules
  for each row execute function app.tg_audit_row();
create trigger audit_row after insert or update or delete on public.profiles
  for each row execute function app.tg_audit_row();

-- RPC for application-level events that aren't row DML ("permit packet
-- downloaded", "design shared with customer", ...). Actor identity comes from
-- the JWT inside write_audit, so callers can't spoof who did it.
create or replace function public.log_audit_event(
  p_action      text,
  p_entity_type text,
  p_entity_id   text default null,
  p_project_id  uuid default null,
  p_context     jsonb default '{}'::jsonb
)
returns bigint
language sql
security definer
set search_path = ''
as $$
  select app.write_audit(p_action, p_entity_type, p_entity_id, p_project_id, null, null, p_context);
$$;

grant execute on function public.log_audit_event(text, text, text, uuid, jsonb) to authenticated;
grant execute on function app.write_audit(text, text, text, uuid, jsonb, jsonb, jsonb) to authenticated;

-- Append-only enforcement, even for superuser-adjacent code paths.
create or replace function app.tg_audit_log_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_log is append-only'
    using errcode = '42501';
end;
$$;

create trigger audit_log_immutable
  before update or delete on public.audit_log
  for each row execute function app.tg_audit_log_immutable();



-- >>> 20260803000600_rls_policies.sql

-- =============================================================================
-- 000600 — Grants + Row-Level Security for every §2 role
-- =============================================================================
-- The §2 contract this file implements (see docs/rls-matrix.md for the full
-- table-by-table matrix):
--   admin    → everything
--   designer → their queue (projects where they are the assigned designer)
--              plus internal tables for those projects
--   dealer   → their book (projects/clients of their dealer orgs)
--   customer → their own project, customer-facing rows only
--   finance  → the whitelisted columns via public.project_financials plus
--              financial tables (price_book, change_orders, vendor_quotes,
--              project_adders); NO direct project/client row access
-- service_role (BYPASSRLS) is reserved for trusted jobs; anon gets nothing.

-- -----------------------------------------------------------------------------
-- Grants: RLS is the authorization layer, so table grants are broad for
-- authenticated and zero for anon. audit_log is the exception (read-only).
-- -----------------------------------------------------------------------------

revoke all on all tables    in schema public from anon;
revoke all on all functions in schema public from anon;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Append-only audit log: rows arrive via app.write_audit() only.
revoke insert, update, delete on public.audit_log from authenticated;

-- project_financials is a read-only reporting surface. Its security_barrier
-- flag already prevents auto-updatable-view DML from reaching projects with
-- the view owner's privileges; the revoke is belt-and-braces.
revoke insert, update, delete on public.project_financials from authenticated;

-- -----------------------------------------------------------------------------
-- Enable RLS everywhere (deny-by-default until a policy grants access).
-- -----------------------------------------------------------------------------

alter table public.profiles             enable row level security;
alter table public.dealers              enable row level security;
alter table public.dealer_users         enable row level security;
alter table public.designers            enable row level security;
alter table public.clients              enable row level security;
alter table public.jurisdictions        enable row level security;
alter table public.utilities            enable row level security;
alter table public.price_book           enable row level security;
alter table public.adder_rules          enable row level security;
alter table public.vendors              enable row level security;
alter table public.projects             enable row level security;
alter table public.project_stage_events enable row level security;
alter table public.availability_slots   enable row level security;
alter table public.documents            enable row level security;
alter table public.designs              enable row level security;
alter table public.design_assets        enable row level security;
alter table public.site_surveys         enable row level security;
alter table public.project_adders       enable row level security;
alter table public.change_orders        enable row level security;
alter table public.vendor_quotes        enable row level security;
alter table public.bom_items            enable row level security;
alter table public.permits              enable row level security;
alter table public.permit_events        enable row level security;
alter table public.stage_feedback       enable row level security;
alter table public.exceptions           enable row level security;
alter table public.audit_log            enable row level security;

-- -----------------------------------------------------------------------------
-- profiles
-- -----------------------------------------------------------------------------

create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select app.is_admin()));

create policy profiles_insert_admin on public.profiles
  for insert to authenticated
  with check ((select app.is_admin()));

-- Users may edit their own row; role changes are blocked for non-admins by
-- app.tg_guard_profile_role (000400).
create policy profiles_update on public.profiles
  for update to authenticated
  using (id = (select auth.uid()) or (select app.is_admin()))
  with check (id = (select auth.uid()) or (select app.is_admin()));

create policy profiles_delete_admin on public.profiles
  for delete to authenticated
  using ((select app.is_admin()));

-- -----------------------------------------------------------------------------
-- dealers / dealer_users / designers / clients
-- -----------------------------------------------------------------------------

create policy dealers_select on public.dealers
  for select to authenticated
  using (
    (select app.is_admin())
    or id in (select app.current_dealer_ids())
    or (select app.current_user_role()) = 'finance'   -- names only; needed to read project_financials.dealer_id
  );

create policy dealers_write_admin on public.dealers
  for all to authenticated
  using ((select app.is_admin()))
  with check ((select app.is_admin()));

create policy dealer_users_select on public.dealer_users
  for select to authenticated
  using (
    (select app.is_admin())
    or user_id = (select auth.uid())
    or dealer_id in (select app.current_dealer_ids())
  );

create policy dealer_users_write_admin on public.dealer_users
  for all to authenticated
  using ((select app.is_admin()))
  with check ((select app.is_admin()));

create policy designers_select on public.designers
  for select to authenticated
  using ((select app.is_admin()) or user_id = (select auth.uid()));

create policy designers_update_own on public.designers
  for update to authenticated
  using ((select app.is_admin()) or user_id = (select auth.uid()))
  with check ((select app.is_admin()) or user_id = (select auth.uid()));

create policy designers_insert_admin on public.designers
  for insert to authenticated
  with check ((select app.is_admin()));

create policy designers_delete_admin on public.designers
  for delete to authenticated
  using ((select app.is_admin()));

create policy clients_select on public.clients
  for select to authenticated
  using (
    (select app.is_admin())
    or dealer_id in (select app.current_dealer_ids())          -- dealer: their book
    or user_id = (select auth.uid())                           -- customer: themselves
    or exists (                                                -- designer: clients on their queue
         select 1 from public.projects p
         where p.client_id = clients.id
           and p.assigned_designer_id = (select app.current_designer_id())
       )
  );

create policy clients_insert on public.clients
  for insert to authenticated
  with check (
    (select app.is_admin())
    or dealer_id in (select app.current_dealer_ids())
  );

create policy clients_update on public.clients
  for update to authenticated
  using ((select app.is_admin()) or dealer_id in (select app.current_dealer_ids()))
  with check ((select app.is_admin()) or dealer_id in (select app.current_dealer_ids()));

create policy clients_delete_admin on public.clients
  for delete to authenticated
  using ((select app.is_admin()));

-- -----------------------------------------------------------------------------
-- Reference data
-- -----------------------------------------------------------------------------

create policy jurisdictions_select on public.jurisdictions
  for select to authenticated
  using (true);

create policy jurisdictions_write_admin on public.jurisdictions
  for all to authenticated
  using ((select app.is_admin()))
  with check ((select app.is_admin()));

create policy utilities_select on public.utilities
  for select to authenticated
  using (true);

create policy utilities_write_admin on public.utilities
  for all to authenticated
  using ((select app.is_admin()))
  with check ((select app.is_admin()));

-- Costs live here → internal + finance only (no dealer/customer).
create policy price_book_select on public.price_book
  for select to authenticated
  using ((select app.current_user_role()) in ('admin', 'designer', 'finance'));

create policy price_book_write_admin on public.price_book
  for all to authenticated
  using ((select app.is_admin()))
  with check ((select app.is_admin()));

-- Dealers see adder rules so pricing to their book is explainable.
create policy adder_rules_select on public.adder_rules
  for select to authenticated
  using ((select app.current_user_role()) in ('admin', 'designer', 'finance', 'dealer'));

create policy adder_rules_write_admin on public.adder_rules
  for all to authenticated
  using ((select app.is_admin()))
  with check ((select app.is_admin()));

create policy vendors_select on public.vendors
  for select to authenticated
  using ((select app.current_user_role()) in ('admin', 'designer', 'finance'));

create policy vendors_write_admin on public.vendors
  for all to authenticated
  using ((select app.is_admin()))
  with check ((select app.is_admin()));

-- -----------------------------------------------------------------------------
-- projects — the §2 core matrix. Finance intentionally has no policy here.
-- -----------------------------------------------------------------------------

create policy projects_select on public.projects
  for select to authenticated
  using (app.can_access_project(id));

create policy projects_insert on public.projects
  for insert to authenticated
  with check (
    (select app.is_admin())
    or (
      -- dealers create projects in their own book, for their own clients
      dealer_id in (select app.current_dealer_ids())
      and exists (
        select 1 from public.clients c
        where c.id = client_id and c.dealer_id = projects.dealer_id
      )
    )
  );

create policy projects_update on public.projects
  for update to authenticated
  using (
    (select app.is_admin())
    or assigned_designer_id = (select app.current_designer_id())
    or dealer_id in (select app.current_dealer_ids())
  )
  with check (
    (select app.is_admin())
    or assigned_designer_id = (select app.current_designer_id())
    or dealer_id in (select app.current_dealer_ids())   -- a dealer can't move a project out of their book
  );

create policy projects_delete_admin on public.projects
  for delete to authenticated
  using ((select app.is_admin()));

-- -----------------------------------------------------------------------------
-- project_stage_events
-- -----------------------------------------------------------------------------

create policy project_stage_events_select on public.project_stage_events
  for select to authenticated
  using (app.can_access_project(project_id));

create policy project_stage_events_insert_staff on public.project_stage_events
  for insert to authenticated
  with check (app.is_project_staff(project_id));

create policy project_stage_events_write_admin_u on public.project_stage_events
  for update to authenticated
  using ((select app.is_admin()))
  with check ((select app.is_admin()));

create policy project_stage_events_write_admin_d on public.project_stage_events
  for delete to authenticated
  using ((select app.is_admin()));

-- -----------------------------------------------------------------------------
-- availability_slots — designers own their calendar; open slots are visible
-- to any authenticated user so booking flows can offer them; a booked slot is
-- visible to that project's participants.
-- -----------------------------------------------------------------------------

create policy availability_slots_select on public.availability_slots
  for select to authenticated
  using (
    status = 'open'
    or (select app.is_admin())
    or designer_id = (select app.current_designer_id())
    or (project_id is not null and app.can_access_project(project_id))
  );

create policy availability_slots_insert on public.availability_slots
  for insert to authenticated
  with check ((select app.is_admin()) or designer_id = (select app.current_designer_id()));

create policy availability_slots_update on public.availability_slots
  for update to authenticated
  using ((select app.is_admin()) or designer_id = (select app.current_designer_id()))
  with check ((select app.is_admin()) or designer_id = (select app.current_designer_id()));

create policy availability_slots_delete on public.availability_slots
  for delete to authenticated
  using ((select app.is_admin()) or designer_id = (select app.current_designer_id()));

-- -----------------------------------------------------------------------------
-- documents — project participants; customers only see rows flagged
-- customer_visible, and may upload their own photos.
-- -----------------------------------------------------------------------------

create policy documents_select on public.documents
  for select to authenticated
  using (
    app.can_access_project(project_id)
    and ((select app.current_user_role()) <> 'customer' or customer_visible)
  );

create policy documents_insert on public.documents
  for insert to authenticated
  with check (
    app.can_access_project(project_id)
    and (
      (select app.current_user_role()) in ('admin', 'designer', 'dealer')
      or ((select app.current_user_role()) = 'customer' and kind = 'photo' and customer_visible)
    )
    and uploaded_by = (select auth.uid())
  );

create policy documents_update on public.documents
  for update to authenticated
  using (app.is_project_staff(project_id) or uploaded_by = (select auth.uid()))
  with check (app.is_project_staff(project_id) or uploaded_by = (select auth.uid()));

create policy documents_delete on public.documents
  for delete to authenticated
  using ((select app.is_admin()) or uploaded_by = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- designs / design_assets — customers only see approved versions.
-- -----------------------------------------------------------------------------

create policy designs_select on public.designs
  for select to authenticated
  using (
    app.can_access_project(project_id)
    and ((select app.current_user_role()) <> 'customer' or status = 'approved')
  );

create policy designs_insert_staff on public.designs
  for insert to authenticated
  with check (app.is_project_staff(project_id));

create policy designs_update_staff on public.designs
  for update to authenticated
  using (app.is_project_staff(project_id))
  with check (app.is_project_staff(project_id));

create policy designs_delete_admin on public.designs
  for delete to authenticated
  using ((select app.is_admin()));

create policy design_assets_select on public.design_assets
  for select to authenticated
  using (
    exists (
      select 1 from public.designs d
      where d.id = design_id
        and app.can_access_project(d.project_id)
        and ((select app.current_user_role()) <> 'customer' or d.status = 'approved')
    )
  );

create policy design_assets_write_staff on public.design_assets
  for all to authenticated
  using (
    exists (select 1 from public.designs d
            where d.id = design_id and app.is_project_staff(d.project_id))
  )
  with check (
    exists (select 1 from public.designs d
            where d.id = design_id and app.is_project_staff(d.project_id))
  );

-- -----------------------------------------------------------------------------
-- site_surveys — staff and the dealer coordinate surveys.
-- -----------------------------------------------------------------------------

create policy site_surveys_select on public.site_surveys
  for select to authenticated
  using (app.can_access_project(project_id));

create policy site_surveys_insert on public.site_surveys
  for insert to authenticated
  with check (
    app.can_access_project(project_id)
    and (select app.current_user_role()) in ('admin', 'designer', 'dealer')
  );

create policy site_surveys_update on public.site_surveys
  for update to authenticated
  using (
    app.can_access_project(project_id)
    and (select app.current_user_role()) in ('admin', 'designer', 'dealer')
  )
  with check (
    app.can_access_project(project_id)
    and (select app.current_user_role()) in ('admin', 'designer', 'dealer')
  );

create policy site_surveys_delete_admin on public.site_surveys
  for delete to authenticated
  using ((select app.is_admin()));

-- -----------------------------------------------------------------------------
-- project_adders — pricing internals: staff + dealer (their book) + finance.
-- Customers see contract impacts through change_orders, not raw adders.
-- -----------------------------------------------------------------------------

create policy project_adders_select on public.project_adders
  for select to authenticated
  using (
    (select app.current_user_role()) = 'finance'
    or (
      app.can_access_project(project_id)
      and (select app.current_user_role()) in ('admin', 'designer', 'dealer')
    )
  );

create policy project_adders_insert_staff on public.project_adders
  for insert to authenticated
  with check (app.is_project_staff(project_id));

create policy project_adders_update_staff on public.project_adders
  for update to authenticated
  using (app.is_project_staff(project_id))
  with check (app.is_project_staff(project_id));

create policy project_adders_delete_staff on public.project_adders
  for delete to authenticated
  using (app.is_project_staff(project_id));

-- -----------------------------------------------------------------------------
-- change_orders — customers sign them, so project participants see them;
-- finance reads all of them.
-- -----------------------------------------------------------------------------

create policy change_orders_select on public.change_orders
  for select to authenticated
  using (
    (select app.current_user_role()) = 'finance'
    or app.can_access_project(project_id)
  );

create policy change_orders_insert on public.change_orders
  for insert to authenticated
  with check (
    app.is_project_staff(project_id)
    or (
      app.can_access_project(project_id)
      and (select app.current_user_role()) = 'dealer'
    )
  );

create policy change_orders_update on public.change_orders
  for update to authenticated
  using (
    app.is_project_staff(project_id)
    or (app.can_access_project(project_id) and (select app.current_user_role()) = 'dealer')
  )
  with check (
    app.is_project_staff(project_id)
    or (app.can_access_project(project_id) and (select app.current_user_role()) = 'dealer')
  );

create policy change_orders_delete_admin on public.change_orders
  for delete to authenticated
  using ((select app.is_admin()));

-- -----------------------------------------------------------------------------
-- vendor_quotes — procurement internals: staff of the project + finance.
-- Quotes not tied to a project are admin/finance only.
-- -----------------------------------------------------------------------------

create policy vendor_quotes_select on public.vendor_quotes
  for select to authenticated
  using (
    (select app.current_user_role()) in ('admin', 'finance')
    or (project_id is not null and app.is_project_staff(project_id))
  );

create policy vendor_quotes_write_staff_i on public.vendor_quotes
  for insert to authenticated
  with check ((select app.is_admin()) or (project_id is not null and app.is_project_staff(project_id)));

create policy vendor_quotes_write_staff_u on public.vendor_quotes
  for update to authenticated
  using ((select app.is_admin()) or (project_id is not null and app.is_project_staff(project_id)))
  with check ((select app.is_admin()) or (project_id is not null and app.is_project_staff(project_id)));

create policy vendor_quotes_delete_admin on public.vendor_quotes
  for delete to authenticated
  using ((select app.is_admin()));

-- -----------------------------------------------------------------------------
-- bom_items — unit costs: staff + finance only.
-- -----------------------------------------------------------------------------

create policy bom_items_select on public.bom_items
  for select to authenticated
  using (
    (select app.current_user_role()) = 'finance'
    or app.is_project_staff(project_id)
  );

create policy bom_items_write_staff_i on public.bom_items
  for insert to authenticated
  with check (app.is_project_staff(project_id));

create policy bom_items_write_staff_u on public.bom_items
  for update to authenticated
  using (app.is_project_staff(project_id))
  with check (app.is_project_staff(project_id));

create policy bom_items_write_staff_d on public.bom_items
  for delete to authenticated
  using (app.is_project_staff(project_id));

-- -----------------------------------------------------------------------------
-- permits / permit_events — status visible to all project participants,
-- writes by staff.
-- -----------------------------------------------------------------------------

create policy permits_select on public.permits
  for select to authenticated
  using (app.can_access_project(project_id));

create policy permits_write_staff_i on public.permits
  for insert to authenticated
  with check (app.is_project_staff(project_id));

create policy permits_write_staff_u on public.permits
  for update to authenticated
  using (app.is_project_staff(project_id))
  with check (app.is_project_staff(project_id));

create policy permits_delete_admin on public.permits
  for delete to authenticated
  using ((select app.is_admin()));

create policy permit_events_select on public.permit_events
  for select to authenticated
  using (
    exists (select 1 from public.permits pm
            where pm.id = permit_id and app.can_access_project(pm.project_id))
  );

create policy permit_events_insert_staff on public.permit_events
  for insert to authenticated
  with check (
    exists (select 1 from public.permits pm
            where pm.id = permit_id and app.is_project_staff(pm.project_id))
  );

create policy permit_events_write_admin_u on public.permit_events
  for update to authenticated
  using ((select app.is_admin()))
  with check ((select app.is_admin()));

create policy permit_events_write_admin_d on public.permit_events
  for delete to authenticated
  using ((select app.is_admin()));

-- -----------------------------------------------------------------------------
-- stage_feedback — any project participant may leave feedback on their own
-- behalf; staff and the author can read it.
-- -----------------------------------------------------------------------------

create policy stage_feedback_select on public.stage_feedback
  for select to authenticated
  using (
    app.is_project_staff(project_id)
    or created_by = (select auth.uid())
  );

create policy stage_feedback_insert on public.stage_feedback
  for insert to authenticated
  with check (
    app.can_access_project(project_id)
    and created_by = (select auth.uid())
  );

create policy stage_feedback_write_admin_u on public.stage_feedback
  for update to authenticated
  using ((select app.is_admin()))
  with check ((select app.is_admin()));

create policy stage_feedback_write_admin_d on public.stage_feedback
  for delete to authenticated
  using ((select app.is_admin()));

-- -----------------------------------------------------------------------------
-- exceptions — internal work queue: admins, the project's designer, and
-- whoever the exception is assigned to.
-- -----------------------------------------------------------------------------

create policy exceptions_select on public.exceptions
  for select to authenticated
  using (
    (select app.is_admin())
    or assigned_to = (select auth.uid())
    or (project_id is not null and app.is_project_staff(project_id))
  );

create policy exceptions_insert_staff on public.exceptions
  for insert to authenticated
  with check (
    (select app.is_admin())
    or (project_id is not null and app.is_project_staff(project_id))
  );

create policy exceptions_update on public.exceptions
  for update to authenticated
  using (
    (select app.is_admin())
    or assigned_to = (select auth.uid())
    or (project_id is not null and app.is_project_staff(project_id))
  )
  with check (
    (select app.is_admin())
    or assigned_to = (select auth.uid())
    or (project_id is not null and app.is_project_staff(project_id))
  );

create policy exceptions_delete_admin on public.exceptions
  for delete to authenticated
  using ((select app.is_admin()));

-- -----------------------------------------------------------------------------
-- audit_log — admins read; nobody writes directly (see 000500).
-- -----------------------------------------------------------------------------

create policy audit_log_select_admin on public.audit_log
  for select to authenticated
  using ((select app.is_admin()));



-- >>> 20260803000700_storage.sql

-- =============================================================================
-- 000700 — Storage: private buckets for DWG / PDF deliverables / photos
-- =============================================================================
-- All three buckets are PRIVATE (public = false): every download goes through
-- a signed URL (src/lib/storage.ts) or an authenticated storage request that
-- these storage.objects policies authorize.
--
-- Object naming convention (enforced by the policies via
-- app.storage_object_project): '<project_id>/<...anything...>'. Uploads whose
-- key doesn't start with a project UUID the caller can access are rejected.
--
--   project-dwg          — CAD sources; staff-only (internal work product)
--   project-deliverables — customer-facing PDFs (plan sets, contracts)
--   project-photos       — site/survey photos; customers may upload their own

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('project-dwg', 'project-dwg', false, 104857600, null),
  ('project-deliverables', 'project-deliverables', false, 52428800,
   array['application/pdf']),
  ('project-photos', 'project-photos', false, 26214400,
   array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- project-dwg — staff only, read and write.
-- -----------------------------------------------------------------------------

create policy dwg_select_staff on storage.objects
  for select to authenticated
  using (
    bucket_id = 'project-dwg'
    and app.is_project_staff(app.storage_object_project(name))
  );

create policy dwg_insert_staff on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'project-dwg'
    and app.is_project_staff(app.storage_object_project(name))
  );

create policy dwg_update_staff on storage.objects
  for update to authenticated
  using (
    bucket_id = 'project-dwg'
    and app.is_project_staff(app.storage_object_project(name))
  );

create policy dwg_delete_staff on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'project-dwg'
    and app.is_project_staff(app.storage_object_project(name))
  );

-- -----------------------------------------------------------------------------
-- project-deliverables — staff write; every project participant (incl. the
-- customer) can read.
-- -----------------------------------------------------------------------------

create policy deliverables_select_participants on storage.objects
  for select to authenticated
  using (
    bucket_id = 'project-deliverables'
    and app.can_access_project(app.storage_object_project(name))
  );

create policy deliverables_insert_staff on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'project-deliverables'
    and app.is_project_staff(app.storage_object_project(name))
  );

create policy deliverables_update_staff on storage.objects
  for update to authenticated
  using (
    bucket_id = 'project-deliverables'
    and app.is_project_staff(app.storage_object_project(name))
  );

create policy deliverables_delete_staff on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'project-deliverables'
    and app.is_project_staff(app.storage_object_project(name))
  );

-- -----------------------------------------------------------------------------
-- project-photos — any project participant can read and upload; deletes by
-- staff or the uploader.
-- -----------------------------------------------------------------------------

create policy photos_select_participants on storage.objects
  for select to authenticated
  using (
    bucket_id = 'project-photos'
    and app.can_access_project(app.storage_object_project(name))
  );

create policy photos_insert_participants on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'project-photos'
    and app.can_access_project(app.storage_object_project(name))
  );

create policy photos_update_staff_or_owner on storage.objects
  for update to authenticated
  using (
    bucket_id = 'project-photos'
    and (app.is_project_staff(app.storage_object_project(name))
         or owner = (select auth.uid()))
  );

create policy photos_delete_staff_or_owner on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'project-photos'
    and (app.is_project_staff(app.storage_object_project(name))
         or owner = (select auth.uid()))
  );



-- >>> 20260803000800_add_ops_role.sql

-- =============================================================================
-- 000800 — Add the Ops/PM role (§2 addendum, auth module)
-- =============================================================================
-- Ops runs the whole pipeline: project visibility like admin, but no admin
-- panel and no audit-log access. Kept in its own migration because a new enum
-- value cannot be referenced in the transaction that adds it — 000900 updates
-- the helpers and policies.

alter type public.user_role add value if not exists 'ops' after 'admin';


