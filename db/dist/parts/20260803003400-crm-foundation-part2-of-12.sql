-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with:
--   node scripts/split-migration.mjs 20260803003400_crm_foundation.sql 12
--
--   20260803003400_crm_foundation.sql · part 2 of 12
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
  if not exists (select 1 from public.sf_migration_parts where part = '20260803003400-crm-foundation-part1') then
    raise exception 'Part 1 has not been applied to this database — run 20260803003400-crm-foundation-part1-of-12.sql first.'
      using hint = 'If you believe you did run it, it did not finish: nothing it created is here. Run it again and read what the console says about it, because that message is the thing that has been missing all along.';
  end if;
end
$$;


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

-- Recorded so the next part can tell that this one finished.
insert into public.sf_migration_parts (part) values ('20260803003400-crm-foundation-part2')
  on conflict (part) do nothing;
