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
    create role service_role nologin bypassrls;
  end if;
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
