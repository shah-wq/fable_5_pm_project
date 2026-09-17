-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with:
--   node scripts/split-migration.mjs 20260803003400_crm_foundation.sql 12
--
--   20260803003400_crm_foundation.sql · part 1 of 12
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

-- Recorded so the next part can tell that this one finished.
insert into public.sf_migration_parts (part) values ('20260803003400-crm-foundation-part1')
  on conflict (part) do nothing;
