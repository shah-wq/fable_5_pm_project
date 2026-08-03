-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
-- Bootstrap part 2 of 2 for a fresh database via a SQL console (e.g. Neon SQL Editor).
-- Run part 1 first, then part 2, each as its own execution.
-- Includes: 20260803000900_auth_module.sql, 20260803001000_auth_engine.sql, 20260803001100_file_storage.sql, migration bookkeeping
-- ============================================================================

-- >>> 20260803000900_auth_module.sql

-- =============================================================================
-- 000900 — Auth module: ops access rules, upload grants (REQ-SEC-01),
--          function-privilege hardening
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

-- New functions should never be callable just because they exist: strip the
-- implicit PUBLIC execute default for everything created from here on, and
-- from the sensitive writers that predate this migration.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema app revoke execute on functions from public;

revoke execute on function public.log_audit_event(text, text, text, uuid, jsonb) from public, anon;
revoke execute on function app.write_audit(text, text, text, uuid, jsonb, jsonb, jsonb) from public, anon;

-- -----------------------------------------------------------------------------
-- Ops/PM joins the access model: like admin for project data (they run the
-- pipeline and, at launch, enter designer/finance data themselves), but not
-- an admin — no user management, no audit log, no finance view.
-- -----------------------------------------------------------------------------

create or replace function app.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when (select auth.jwt() ->> 'user_role')
         in ('admin', 'ops', 'designer', 'customer', 'dealer', 'finance')
      then ((select auth.jwt() ->> 'user_role'))::public.user_role
    else (select p.role from public.profiles p where p.id = (select auth.uid()))
  end;
$$;

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
        app.current_user_role() in ('admin', 'ops')
        or p.assigned_designer_id = app.current_designer_id()
        or p.dealer_id in (select app.current_dealer_ids())
        or p.client_id in (select app.current_client_ids())
      )
  );
$$;

create or replace function app.is_project_staff(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.current_user_role() in ('admin', 'ops')
      or exists (
           select 1
           from public.projects p
           where p.id = pid
             and p.assigned_designer_id = app.current_designer_id()
         );
$$;

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
         in ('admin', 'ops', 'designer', 'customer', 'dealer', 'finance')
      then (new.raw_app_meta_data ->> 'user_role')::public.user_role
    else 'customer'::public.user_role
  end;

  insert into public.profiles (id, role, email, full_name)
  values (new.id, v_role, new.email, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;

  return new;
end;
$$;

-- Policies with explicit role lists (everything driven by can_access_project /
-- is_project_staff picked ops up through the helper changes above).

drop policy projects_update on public.projects;
create policy projects_update on public.projects
  for update to authenticated
  using (
    app.is_project_staff(id)
    or dealer_id in (select app.current_dealer_ids())
  )
  with check (
    app.is_project_staff(id)
    or dealer_id in (select app.current_dealer_ids())   -- a dealer can't move a project out of their book
  );

drop policy dealers_select on public.dealers;
create policy dealers_select on public.dealers
  for select to authenticated
  using (
    (select app.current_user_role()) in ('admin', 'ops', 'finance')
    or id in (select app.current_dealer_ids())
  );

drop policy clients_select on public.clients;
create policy clients_select on public.clients
  for select to authenticated
  using (
    (select app.current_user_role()) in ('admin', 'ops')
    or dealer_id in (select app.current_dealer_ids())
    or user_id = (select auth.uid())
    or exists (
         select 1 from public.projects p
         where p.client_id = clients.id
           and p.assigned_designer_id = (select app.current_designer_id())
       )
  );

drop policy designers_select on public.designers;
create policy designers_select on public.designers
  for select to authenticated
  using (
    (select app.current_user_role()) in ('admin', 'ops')
    or user_id = (select auth.uid())
  );

drop policy price_book_select on public.price_book;
create policy price_book_select on public.price_book
  for select to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops', 'designer', 'finance'));

drop policy adder_rules_select on public.adder_rules;
create policy adder_rules_select on public.adder_rules
  for select to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops', 'designer', 'finance', 'dealer'));

drop policy vendors_select on public.vendors;
create policy vendors_select on public.vendors
  for select to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops', 'designer', 'finance'));

drop policy documents_insert on public.documents;
create policy documents_insert on public.documents
  for insert to authenticated
  with check (
    app.can_access_project(project_id)
    and (
      (select app.current_user_role()) in ('admin', 'ops', 'designer', 'dealer')
      or ((select app.current_user_role()) = 'customer' and kind = 'photo' and customer_visible)
    )
    and uploaded_by = (select auth.uid())
  );

drop policy site_surveys_insert on public.site_surveys;
create policy site_surveys_insert on public.site_surveys
  for insert to authenticated
  with check (
    app.can_access_project(project_id)
    and (select app.current_user_role()) in ('admin', 'ops', 'designer', 'dealer')
  );

drop policy site_surveys_update on public.site_surveys;
create policy site_surveys_update on public.site_surveys
  for update to authenticated
  using (
    app.can_access_project(project_id)
    and (select app.current_user_role()) in ('admin', 'ops', 'designer', 'dealer')
  )
  with check (
    app.can_access_project(project_id)
    and (select app.current_user_role()) in ('admin', 'ops', 'designer', 'dealer')
  );

drop policy project_adders_select on public.project_adders;
create policy project_adders_select on public.project_adders
  for select to authenticated
  using (
    (select app.current_user_role()) = 'finance'
    or (
      app.can_access_project(project_id)
      and (select app.current_user_role()) in ('admin', 'ops', 'designer', 'dealer')
    )
  );

-- -----------------------------------------------------------------------------
-- Upload grants (REQ-SEC-01): single-project, no-login links for surveyor
-- photo upload, crew work-orders, and customer delivery uploads. The URL
-- token is the credential; only its sha-256 lands in the database, expiry is
-- capped at 7 days, and a grant unlocks exactly one project's upload surface
-- (never an app session).
-- -----------------------------------------------------------------------------

create type public.upload_grant_purpose as enum (
  'survey_photos',
  'crew_workorder',
  'customer_delivery'
);

create table public.upload_grants (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  purpose      public.upload_grant_purpose not null,
  token_hash   text not null unique,
  created_by   uuid references public.profiles (id),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  use_count    integer not null default 0,
  created_at   timestamptz not null default now()
);

create index upload_grants_project_id_idx on public.upload_grants (project_id);

alter table public.upload_grants enable row level security;

-- Default privileges could hand new tables broad grants; make the
-- surface explicit: staff read their project's grants, all writes go through
-- the SECURITY DEFINER functions below.
revoke all on public.upload_grants from anon, authenticated;
grant select on public.upload_grants to authenticated;

create policy upload_grants_select_staff on public.upload_grants
  for select to authenticated
  using (app.is_project_staff(project_id));

-- Mint a grant. Staff-of-project only; TTL clamped to the 7-day REQ-SEC-01
-- ceiling. Returns the raw token exactly once — it is never stored.
create or replace function public.create_upload_grant(
  p_project_id uuid,
  p_purpose    public.upload_grant_purpose,
  p_ttl        interval default interval '7 days'
)
returns table (grant_id uuid, token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token   text;
  v_ttl     interval;
  v_grant   public.upload_grants%rowtype;
begin
  if not app.is_project_staff(p_project_id) then
    raise exception 'only project staff may create upload links'
      using errcode = '42501';
  end if;

  v_ttl := least(coalesce(p_ttl, interval '7 days'), interval '7 days');
  if v_ttl <= interval '0' then
    raise exception 'upload link ttl must be positive';
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.upload_grants (project_id, purpose, token_hash, created_by, expires_at)
  values (
    p_project_id,
    p_purpose,
    encode(extensions.digest(v_token, 'sha256'), 'hex'),
    (select auth.uid()),
    now() + v_ttl
  )
  returning * into v_grant;

  perform app.write_audit(
    'upload_grant.created', 'upload_grants', v_grant.id::text, p_project_id,
    null, null,
    jsonb_build_object('purpose', p_purpose, 'expires_at', v_grant.expires_at)
  );

  return query select v_grant.id, v_token, v_grant.expires_at;
end;
$$;

-- Resolve a token to its project. Returns zero rows for unknown, revoked, or
-- expired tokens — the caller can't distinguish which (no oracle). Callable
-- without a session: knowing the token IS the credential.
create or replace function public.validate_upload_grant(p_token text)
returns table (
  grant_id     uuid,
  project_id   uuid,
  purpose      public.upload_grant_purpose,
  project_name text,
  expires_at   timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_grant public.upload_grants%rowtype;
begin
  select g.* into v_grant
  from public.upload_grants g
  where g.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and g.revoked_at is null
    and g.expires_at > now();

  if not found then
    return;
  end if;

  update public.upload_grants g
  set last_used_at = now(), use_count = g.use_count + 1
  where g.id = v_grant.id;

  return query
    select v_grant.id, v_grant.project_id, v_grant.purpose, p.name, v_grant.expires_at
    from public.projects p
    where p.id = v_grant.project_id;
end;
$$;

create or replace function public.revoke_upload_grant(p_grant_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
begin
  select g.project_id into v_project from public.upload_grants g where g.id = p_grant_id;
  if v_project is null or not app.is_project_staff(v_project) then
    raise exception 'only project staff may revoke upload links'
      using errcode = '42501';
  end if;

  update public.upload_grants g
  set revoked_at = coalesce(g.revoked_at, now())
  where g.id = p_grant_id;

  perform app.write_audit(
    'upload_grant.revoked', 'upload_grants', p_grant_id::text, v_project);
end;
$$;

revoke execute on function public.create_upload_grant(uuid, public.upload_grant_purpose, interval) from public, anon;
grant execute on function public.create_upload_grant(uuid, public.upload_grant_purpose, interval) to authenticated;

revoke execute on function public.revoke_upload_grant(uuid) from public, anon;
grant execute on function public.revoke_upload_grant(uuid) to authenticated;

revoke execute on function public.validate_upload_grant(text) from public;
grant execute on function public.validate_upload_grant(text) to anon, authenticated;



-- >>> 20260803001000_auth_engine.sql

-- =============================================================================
-- 001000 — Auth engine (replaces Supabase Auth)
-- =============================================================================
-- Credentials, sessions, and one-time tokens live in the auth schema and are
-- reachable ONLY through the SECURITY DEFINER functions below — the app role
-- has no direct grants on the tables. Design notes:
--
--   * Passwords: bcrypt via pgcrypto (crypt/gen_salt('bf', 12)).
--   * Sessions: opaque 256-bit tokens in an httpOnly cookie; only the sha-256
--     lands in the database. 7-day lifetime, revocable server-side, so
--     deactivating a profile kills access on the next request.
--   * OTP: customers sign in with a 6-digit emailed code (10-minute expiry,
--     5 attempts). Staff/dealers use passwords; customers never do.
--   * Lockout: 10 consecutive password failures → 10-minute lock.
--   * Invites/recovery: single-use tokens (7 days / 1 hour), consumed on use;
--     a password reset revokes every other session for that user.
--   * No-oracle: bad email, bad password, locked, and deactivated all return
--     zero rows from login — routes emit one generic message.

create table auth.sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create index sessions_user_id_idx on auth.sessions (user_id);

create table auth.one_time_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  purpose     text not null check (purpose in ('invite', 'recovery', 'otp')),
  token_hash  text not null unique,
  attempts    integer not null default 0,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);

create index one_time_tokens_user_purpose_idx on auth.one_time_tokens (user_id, purpose);

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------

create or replace function auth.hash_token(p_token text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
$$;

create or replace function auth.new_session(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  insert into auth.sessions (user_id, token_hash, expires_at)
  values (p_user_id, auth.hash_token(v_token), now() + interval '7 days');
  return v_token;
end;
$$;

-- ---------------------------------------------------------------------------
-- Password login (staff + dealer doors)
-- ---------------------------------------------------------------------------

create or replace function auth.login_with_password(p_email text, p_password text)
returns table (
  user_id       uuid,
  session_token text,
  user_role     public.user_role,
  is_active     boolean,
  full_name     text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user auth.users%rowtype;
  v_profile public.profiles%rowtype;
begin
  select u.* into v_user from auth.users u where lower(u.email) = lower(p_email);
  if not found or v_user.encrypted_password is null then
    return;
  end if;
  if v_user.locked_until is not null and v_user.locked_until > now() then
    return;
  end if;

  if v_user.encrypted_password
     is distinct from extensions.crypt(p_password, v_user.encrypted_password) then
    update auth.users u
    set failed_attempts = u.failed_attempts + 1,
        locked_until = case when u.failed_attempts + 1 >= 10
                            then now() + interval '10 minutes' end,
        updated_at = now()
    where u.id = v_user.id;
    return;
  end if;

  select p.* into v_profile from public.profiles p where p.id = v_user.id;
  if not found then
    return;
  end if;

  update auth.users u
  set failed_attempts = 0, locked_until = null,
      last_sign_in_at = now(), updated_at = now()
  where u.id = v_user.id;

  -- Deactivated accounts get no session; the row tells the route which
  -- message to show.
  return query select
    v_user.id,
    case when v_profile.is_active then auth.new_session(v_user.id) end,
    v_profile.role,
    v_profile.is_active,
    v_profile.full_name;
end;
$$;

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------

-- Called on every authenticated request. Role and is_active come from
-- profiles at call time — role changes and deactivations bite immediately.
create or replace function auth.validate_session(p_token text)
returns table (
  user_id   uuid,
  email     text,
  user_role public.user_role,
  is_active boolean,
  full_name text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session auth.sessions%rowtype;
begin
  select s.* into v_session
  from auth.sessions s
  where s.token_hash = auth.hash_token(p_token)
    and s.revoked_at is null
    and s.expires_at > now();

  if not found then
    return;
  end if;

  -- Touch at most once a minute to keep the hot path cheap.
  if v_session.last_used_at is null or v_session.last_used_at < now() - interval '1 minute' then
    update auth.sessions s set last_used_at = now() where s.id = v_session.id;
  end if;

  return query
    select u.id, u.email, p.role, p.is_active, p.full_name
    from auth.users u
    join public.profiles p on p.id = u.id
    where u.id = v_session.user_id;
end;
$$;

create or replace function auth.logout(p_token text)
returns void
language sql
security definer
set search_path = ''
as $$
  update auth.sessions s
  set revoked_at = coalesce(s.revoked_at, now())
  where s.token_hash = auth.hash_token(p_token);
$$;

create or replace function auth.revoke_all_sessions(p_user_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update auth.sessions s
  set revoked_at = coalesce(s.revoked_at, now())
  where s.user_id = p_user_id;
$$;

-- ---------------------------------------------------------------------------
-- Customer OTP (6-digit emailed code; customers never have passwords)
-- ---------------------------------------------------------------------------

create or replace function auth.request_otp(p_email text)
returns table (code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user auth.users%rowtype;
  v_role public.user_role;
  v_active boolean;
  v_code text;
begin
  select u.* into v_user from auth.users u where lower(u.email) = lower(p_email);
  if not found then
    return;
  end if;
  select p.role, p.is_active into v_role, v_active
  from public.profiles p where p.id = v_user.id;
  if v_role is distinct from 'customer' or not coalesce(v_active, false) then
    return;
  end if;

  -- One live code at a time.
  update auth.one_time_tokens t
  set consumed_at = now()
  where t.user_id = v_user.id and t.purpose = 'otp' and t.consumed_at is null;

  v_code := lpad(
    (abs(('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::int) % 1000000)::text,
    6, '0');

  insert into auth.one_time_tokens (user_id, purpose, token_hash, expires_at)
  values (v_user.id, 'otp',
          auth.hash_token(lower(v_user.email) || ':' || v_code),
          now() + interval '10 minutes');

  return query select v_code;
end;
$$;

create or replace function auth.verify_otp(p_email text, p_code text)
returns table (
  user_id       uuid,
  session_token text,
  user_role     public.user_role,
  full_name     text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user auth.users%rowtype;
  v_token auth.one_time_tokens%rowtype;
begin
  select u.* into v_user from auth.users u where lower(u.email) = lower(p_email);
  if not found then
    return;
  end if;

  select t.* into v_token
  from auth.one_time_tokens t
  where t.user_id = v_user.id and t.purpose = 'otp'
    and t.consumed_at is null and t.expires_at > now()
  order by t.created_at desc
  limit 1;
  if not found then
    return;
  end if;

  update auth.one_time_tokens t
  set attempts = t.attempts + 1,
      consumed_at = case when t.attempts + 1 >= 5 then now() end
  where t.id = v_token.id;

  if v_token.attempts + 1 >= 5
     or v_token.token_hash
        is distinct from auth.hash_token(lower(v_user.email) || ':' || p_code) then
    return;
  end if;

  update auth.one_time_tokens t set consumed_at = now() where t.id = v_token.id;
  update auth.users u
  set last_sign_in_at = now(), email_confirmed_at = coalesce(u.email_confirmed_at, now()),
      updated_at = now()
  where u.id = v_user.id;

  return query
    select v_user.id, auth.new_session(v_user.id), p.role, p.full_name
    from public.profiles p
    where p.id = v_user.id and p.is_active;
end;
$$;

-- ---------------------------------------------------------------------------
-- Invitations & password recovery
-- ---------------------------------------------------------------------------

-- Creates the auth user (the existing on_auth_user_created trigger builds the
-- profile from raw_app_meta_data.user_role). Staff/dealer invitees get a
-- 7-day set-password token; customers get none — they sign in with OTP.
-- Duplicate email raises unique_violation for the route to map to 409.
create or replace function auth.create_invited_user(
  p_email     text,
  p_role      text,
  p_full_name text default null
)
returns table (user_id uuid, invite_token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_token text;
begin
  -- Route-level checks aside: when a user context exists, only admins invite.
  -- (No context = trusted server-side bootstrap, e.g. scripts/create-admin.)
  if auth.uid() is not null and app.current_user_role() is distinct from 'admin' then
    raise exception 'only admins may invite users' using errcode = '42501';
  end if;

  if p_role not in ('admin', 'ops', 'designer', 'finance', 'dealer', 'customer') then
    raise exception 'invalid role %', p_role;
  end if;

  insert into auth.users (email, raw_app_meta_data, raw_user_meta_data)
  values (
    lower(p_email),
    jsonb_build_object('user_role', p_role),
    case when p_full_name is null then '{}'::jsonb
         else jsonb_build_object('full_name', p_full_name) end
  )
  returning id into v_id;

  if p_role <> 'customer' then
    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    insert into auth.one_time_tokens (user_id, purpose, token_hash, expires_at)
    values (v_id, 'invite', auth.hash_token(v_token), now() + interval '7 days');
  end if;

  return query select v_id, v_token;
end;
$$;

create or replace function auth.request_recovery(p_email text)
returns table (recovery_token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user auth.users%rowtype;
  v_role public.user_role;
  v_active boolean;
  v_token text;
begin
  select u.* into v_user from auth.users u where lower(u.email) = lower(p_email);
  if not found then
    return;
  end if;
  select p.role, p.is_active into v_role, v_active
  from public.profiles p where p.id = v_user.id;
  -- Customers have no password to recover; they use OTP.
  if v_role = 'customer' or not coalesce(v_active, false) then
    return;
  end if;

  update auth.one_time_tokens t
  set consumed_at = now()
  where t.user_id = v_user.id and t.purpose = 'recovery' and t.consumed_at is null;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into auth.one_time_tokens (user_id, purpose, token_hash, expires_at)
  values (v_user.id, 'recovery', auth.hash_token(v_token), now() + interval '1 hour');

  return query select v_token;
end;
$$;

-- Accepts both invite and recovery tokens: sets the password, consumes the
-- token, revokes every other session, and signs the user in.
create or replace function auth.set_password_with_token(p_token text, p_password text)
returns table (
  user_id       uuid,
  session_token text,
  user_role     public.user_role,
  full_name     text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token auth.one_time_tokens%rowtype;
begin
  if length(coalesce(p_password, '')) < 10 then
    raise exception 'password must be at least 10 characters';
  end if;

  select t.* into v_token
  from auth.one_time_tokens t
  where t.token_hash = auth.hash_token(p_token)
    and t.purpose in ('invite', 'recovery')
    and t.consumed_at is null
    and t.expires_at > now();
  if not found then
    return;
  end if;

  update auth.one_time_tokens t set consumed_at = now() where t.id = v_token.id;

  update auth.users u
  set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 12)),
      email_confirmed_at = coalesce(u.email_confirmed_at, now()),
      failed_attempts = 0, locked_until = null, updated_at = now()
  where u.id = v_token.user_id;

  perform auth.revoke_all_sessions(v_token.user_id);

  return query
    select v_token.user_id, auth.new_session(v_token.user_id), p.role, p.full_name
    from public.profiles p
    where p.id = v_token.user_id and p.is_active;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: the app (running as `authenticated`) may call the flows; nothing
-- touches the tables directly.
-- ---------------------------------------------------------------------------

revoke execute on function
  auth.hash_token(text),
  auth.new_session(uuid),
  auth.login_with_password(text, text),
  auth.validate_session(text),
  auth.logout(text),
  auth.revoke_all_sessions(uuid),
  auth.request_otp(text),
  auth.verify_otp(text, text),
  auth.create_invited_user(text, text, text),
  auth.request_recovery(text),
  auth.set_password_with_token(text, text)
from public, anon;

grant execute on function
  auth.login_with_password(text, text),
  auth.validate_session(text),
  auth.logout(text),
  auth.request_otp(text),
  auth.verify_otp(text, text),
  auth.create_invited_user(text, text, text),
  auth.request_recovery(text),
  auth.set_password_with_token(text, text)
to authenticated;



-- >>> 20260803001100_file_storage.sql

-- =============================================================================
-- 001100 — File bytes in Postgres (replaces Supabase Storage)
-- =============================================================================
-- Object metadata stays in storage.objects (the 000700 bucket policies keep
-- governing it); the bytes live beside it in storage.object_data. The app
-- never touches the blob table directly — uploads and downloads go through
-- the two definer functions below, which enforce the same §2 access rules as
-- the storage policies. Blob-in-database is the right call at this product's
-- volume (site photos, plan PDFs); if that ever changes, the metadata layer
-- is already shaped for an S3-style backend.

create table storage.object_data (
  object_id  uuid primary key references storage.objects (id) on delete cascade,
  data       bytea not null,
  created_at timestamptz not null default now()
);

-- No grants: SECURITY DEFINER access only.

-- ---------------------------------------------------------------------------
-- No-login grant uploads (REQ-SEC-01). Validates the token (expiry,
-- revocation), stores the photo, registers the documents row, audits.
-- Returns the document id, or null when the link is dead (route → 410).
-- ---------------------------------------------------------------------------

create or replace function public.record_grant_upload(
  p_token    text,
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
  v_grant record;
  v_name text;
  v_path text;
  v_object_id uuid;
  v_document_id uuid;
begin
  select * into v_grant from public.validate_upload_grant(p_token) limit 1;
  if v_grant.grant_id is null then
    return null;
  end if;

  if p_mime not in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif') then
    raise exception 'only photos are accepted on this link';
  end if;
  if p_data is null or octet_length(p_data) = 0 or octet_length(p_data) > 26214400 then
    raise exception 'file must be between 1 byte and 25 MB';
  end if;

  v_name := coalesce(nullif(regexp_replace(coalesce(p_filename, ''), '[^\w.\-]+', '_', 'g'), ''), 'photo');
  v_name := right(v_name, 100);
  v_path := v_grant.project_id || '/grant-uploads/' || v_grant.grant_id || '/'
            || floor(extract(epoch from clock_timestamp()) * 1000)::bigint || '-' || v_name;

  insert into storage.objects (bucket_id, name)
  values ('project-photos', v_path)
  returning id into v_object_id;

  insert into storage.object_data (object_id, data) values (v_object_id, p_data);

  insert into public.documents
    (project_id, bucket, object_path, kind, title, mime_type, size_bytes,
     customer_visible, uploaded_by)
  values
    (v_grant.project_id, 'project-photos', v_path, 'photo', p_filename, p_mime,
     octet_length(p_data),
     v_grant.purpose = 'customer_delivery',   -- delivery photos surface on the portal
     null)
  returning id into v_document_id;

  perform app.write_audit(
    'document.uploaded_via_grant', 'documents', v_document_id::text, v_grant.project_id,
    null, null,
    jsonb_build_object(
      'grant_id', v_grant.grant_id,
      'purpose', v_grant.purpose,
      'filename', p_filename,
      'size_bytes', octet_length(p_data)));

  return v_document_id;
end;
$$;

revoke execute on function public.record_grant_upload(text, text, text, bytea) from public;
grant execute on function public.record_grant_upload(text, text, text, bytea) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Authenticated downloads. Mirrors the documents/storage read rules:
-- project participants only, customers only see customer_visible rows, and
-- DWG bytes stay staff-only. Empty result = not found OR not allowed.
-- ---------------------------------------------------------------------------

create or replace function public.read_document(p_document_id uuid)
returns table (
  title      text,
  mime_type  text,
  size_bytes bigint,
  data       bytea
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents%rowtype;
begin
  select d.* into v_doc from public.documents d where d.id = p_document_id;
  if not found then
    return;
  end if;

  if not app.can_access_project(v_doc.project_id) then
    return;
  end if;
  if app.current_user_role() = 'customer' and not v_doc.customer_visible then
    return;
  end if;
  if v_doc.bucket = 'project-dwg' and not app.is_project_staff(v_doc.project_id) then
    return;
  end if;

  return query
    select v_doc.title, v_doc.mime_type, v_doc.size_bytes, od.data
    from storage.objects o
    join storage.object_data od on od.object_id = o.id
    where o.bucket_id = v_doc.bucket and o.name = v_doc.object_path;
end;
$$;

revoke execute on function public.read_document(uuid) from public, anon;
grant execute on function public.read_document(uuid) to authenticated;



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
  ('20260803001100_file_storage.sql')
on conflict (name) do nothing;
