-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with:
--   node scripts/split-migration.mjs 20260803003400_crm_foundation.sql 12
--
--   20260803003400_crm_foundation.sql · part 3 of 12
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
  if not exists (select 1 from public.sf_migration_parts where part = '20260803003400-crm-foundation-part2') then
    raise exception 'Part 2 has not been applied to this database — run 20260803003400-crm-foundation-part2-of-12.sql first.'
      using hint = 'If you believe you did run it, it did not finish: nothing it created is here. Run it again and read what the console says about it, because that message is the thing that has been missing all along.';
  end if;
end
$$;


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

-- Recorded so the next part can tell that this one finished.
insert into public.sf_migration_parts (part) values ('20260803003400-crm-foundation-part3')
  on conflict (part) do nothing;
