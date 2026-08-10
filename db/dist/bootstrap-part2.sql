-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
-- Bootstrap part 2 of 3 for a fresh database via a SQL console (e.g. Neon SQL Editor).
-- Run the parts in order, each as its own execution.
-- Includes: 20260803000900_auth_module.sql, 20260803001000_auth_engine.sql, 20260803001100_file_storage.sql, 20260803001200_manual_version.sql, 20260803001300_admin_panel.sql, 20260803001400_stage_fields.sql, 20260803001500_complete_hold_cancel.sql
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



-- >>> 20260803001200_manual_version.sql

-- =============================================================================
-- 001200 — Manual version (SolarFlow PM): six stages, stage data model,
--          reference tables, PM-centric permissions
-- =============================================================================
-- Implements the "Manual Version Breakdown" spec: the pipeline is exactly six
-- stages (Survey · Design · Permits · Procurement · Install · Inspection &
-- PTO); every stage form's fields get typed columns now so Module 2 (the
-- forms) and later automation need no further schema work. The PM (ops) runs
-- everything; dealers/customers become read-only on projects.

-- -----------------------------------------------------------------------------
-- 1. Six-stage enum, replacing the 11-phase one (values mapped, not dropped)
-- -----------------------------------------------------------------------------

create type public.project_stage_v2 as enum (
  'survey',
  'design',
  'permits',
  'procurement',
  'install',
  'inspection_pto'
);

-- project_financials selects projects.stage — recreate around the type swap.
drop view public.project_financials;

alter table public.projects alter column stage drop default;

alter table public.projects
  alter column stage type public.project_stage_v2
  using (case stage::text
    when 'intake'          then 'survey'
    when 'site_survey'     then 'survey'
    when 'design'          then 'design'
    when 'design_review'   then 'design'
    when 'engineering'     then 'design'
    when 'permitting'      then 'permits'
    when 'permit_approved' then 'permits'
    when 'installation'    then 'install'
    when 'inspection'      then 'inspection_pto'
    when 'pto'             then 'inspection_pto'
    when 'complete'        then 'inspection_pto'
  end)::public.project_stage_v2;

alter table public.projects alter column stage set default 'survey';

alter table public.project_stage_events
  alter column from_stage type public.project_stage_v2
  using (case from_stage::text
    when 'intake' then 'survey' when 'site_survey' then 'survey'
    when 'design' then 'design' when 'design_review' then 'design' when 'engineering' then 'design'
    when 'permitting' then 'permits' when 'permit_approved' then 'permits'
    when 'installation' then 'install'
    when 'inspection' then 'inspection_pto' when 'pto' then 'inspection_pto' when 'complete' then 'inspection_pto'
  end)::public.project_stage_v2;

alter table public.project_stage_events
  alter column to_stage type public.project_stage_v2
  using (case to_stage::text
    when 'intake' then 'survey' when 'site_survey' then 'survey'
    when 'design' then 'design' when 'design_review' then 'design' when 'engineering' then 'design'
    when 'permitting' then 'permits' when 'permit_approved' then 'permits'
    when 'installation' then 'install'
    when 'inspection' then 'inspection_pto' when 'pto' then 'inspection_pto' when 'complete' then 'inspection_pto'
  end)::public.project_stage_v2;

alter table public.stage_feedback
  alter column stage type public.project_stage_v2
  using (case stage::text
    when 'intake' then 'survey' when 'site_survey' then 'survey'
    when 'design' then 'design' when 'design_review' then 'design' when 'engineering' then 'design'
    when 'permitting' then 'permits' when 'permit_approved' then 'permits'
    when 'installation' then 'install'
    when 'inspection' then 'inspection_pto' when 'pto' then 'inspection_pto' when 'complete' then 'inspection_pto'
  end)::public.project_stage_v2;

drop type public.project_stage;
alter type public.project_stage_v2 rename to project_stage;

create view public.project_financials
with (security_barrier = true, security_invoker = false)
as
select
  p.id, p.code, p.name, p.stage, p.status, p.dealer_id, p.client_id,
  p.system_size_kw, p.contract_value, p.dealer_fee, p.amount_invoiced,
  p.amount_paid, p.target_install_date, p.created_at, p.updated_at
from public.projects p
where app.current_user_role() in ('finance', 'admin');

grant select on public.project_financials to authenticated;
revoke insert, update, delete on public.project_financials from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. Reference tables the stage forms draw dropdowns from
-- -----------------------------------------------------------------------------

create table public.hoas (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  contact    jsonb not null default '{}'::jsonb,
  notes      text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.surveyors (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  phone      text,
  email      text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.crews (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  contact    jsonb not null default '{}'::jsonb,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.finance_partners (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  contact    jsonb not null default '{}'::jsonb,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at before update on public.hoas
  for each row execute function app.tg_set_updated_at();
create trigger set_updated_at before update on public.surveyors
  for each row execute function app.tg_set_updated_at();
create trigger set_updated_at before update on public.crews
  for each row execute function app.tg_set_updated_at();
create trigger set_updated_at before update on public.finance_partners
  for each row execute function app.tg_set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. Project columns the create-form and Projects tab need
-- -----------------------------------------------------------------------------

alter table public.projects
  add column address            text,
  add column finance_partner_id uuid references public.finance_partners (id),
  add column assigned_pm        uuid references public.profiles (id);

create index projects_assigned_pm_idx on public.projects (assigned_pm);

-- Documents gain a category: photo slots (roof, attic, main_panel, meter,
-- wire_path, obstructions, delivery, completion, ...) and document types
-- (plan_set_dwg, plan_set_pdf, stamped_set, signed_co, permit_letter,
-- signature_docs, work_order, inspection_signoff, pto_letter, ...). The
-- stage-requirements engine checks these slots.
alter table public.documents add column category text;
create index documents_project_category_idx on public.documents (project_id, category);

-- -----------------------------------------------------------------------------
-- 4. Stage data tables — one row per project per stage (Module 2's forms
--    write here; requirements validate against them)
-- -----------------------------------------------------------------------------

-- Stage 1 · Site Survey (jurisdiction/utility live on projects)
create table public.stage_survey (
  project_id           uuid primary key references public.projects (id) on delete cascade,
  hoa_applies          boolean,
  hoa_id               uuid references public.hoas (id),
  survey_date          date,
  time_window          text,
  surveyor_id          uuid references public.surveyors (id),
  survey_status        text check (survey_status in ('scheduled', 'completed', 'no_show', 'rescheduled')),
  roof_type            text check (roof_type in ('shingle', 's_tile', 'flat_tile', 'metal')),
  roof_pitch           text,
  main_panel_adequate  boolean,
  main_panel_notes     text,
  wire_run_ft          numeric(8,1),
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Stage 2 · Design & Engineering (plan set versions live in designs/documents;
-- adders in project_adders; the CO in change_orders)
create table public.stage_design (
  project_id           uuid primary key references public.projects (id) on delete cascade,
  designer_id          uuid references public.designers (id),
  assigned_date        date,
  due_date             date,
  adder_approval_date  date,
  new_contract_total   numeric(12,2),
  finance_notified_date date,
  finance_acked_date   date,
  production_kwh       numeric(12,1),
  client_approval_date date,
  pe_stamp_date        date,
  revision_notes       text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Stage 4 · Procurement (BOM lines live in bom_items, extended below)
create table public.stage_procurement (
  project_id           uuid primary key references public.projects (id) on delete cascade,
  total_equipment_cost numeric(12,2),
  delivery_date        date,
  delivery_ok          boolean,
  delivery_issue_notes text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Stage 5 · Installation
create table public.stage_install (
  project_id              uuid primary key references public.projects (id) on delete cascade,
  crew_id                 uuid references public.crews (id),
  start_date              date,
  end_date                date,
  customer_confirmed      boolean,
  customer_confirmed_date date,
  work_order_date         date,
  install_status          text check (install_status in ('scheduled', 'in_progress', 'completed', 'issue')),
  completion_date         date,
  punch_list              text,
  punch_resolved_date     date,
  mid_install_adder       boolean,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- Stage 6 · Inspection & PTO
create table public.stage_inspection (
  project_id          uuid primary key references public.projects (id) on delete cascade,
  inspection_date     date,
  time_window         text,
  crew_confirmed      boolean,
  result              text check (result in ('pass', 'fail')),
  correction_items    text,
  fix_date            date,
  reinspection_date   date,
  pto_submitted_date  date,
  pto_reference       text,
  pto_issued_date     date,
  handoff_done        boolean,
  handoff_date        date,
  commission_payable  boolean,
  commission_amount   numeric(12,2),
  final_notes         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Stage 3 · Permits: per-track columns on the existing permits table
-- (permit_type: 'city_county' | 'hoa' | 'utility')
alter table public.permits
  add column submission_method text check (submission_method in ('solarapp', 'portal', 'email', 'in_person', 'mail')),
  add column reference_no      text,
  add column corrections_notes text,
  add column resubmitted_date  date,
  add column fees_paid_date    date,
  add column followup_date     date;

-- Stage 4 · Procurement: per-line ordering/tracking on BOM lines
alter table public.bom_items
  add column vendor_id   uuid references public.vendors (id),
  add column po_number   text,
  add column order_date  date,
  add column tracking_no text,
  add column carrier     text,
  add column eta         date,
  add column line_status text not null default 'pending'
    check (line_status in ('pending', 'ordered', 'shipped', 'delivered'));

-- -----------------------------------------------------------------------------
-- 5. RLS + audit + updated_at for the new tables
-- -----------------------------------------------------------------------------

do $$
declare
  t text;
begin
  -- Stage data: participants read their project's rows; staff write.
  foreach t in array array['stage_survey', 'stage_design', 'stage_procurement',
                           'stage_install', 'stage_inspection']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format($p$
      create policy %1$I_select on public.%1$I
        for select to authenticated
        using (app.can_access_project(project_id))
    $p$, t);
    execute format($p$
      create policy %1$I_write_i on public.%1$I
        for insert to authenticated
        with check (app.is_project_staff(project_id))
    $p$, t);
    execute format($p$
      create policy %1$I_write_u on public.%1$I
        for update to authenticated
        using (app.is_project_staff(project_id))
        with check (app.is_project_staff(project_id))
    $p$, t);
    execute format($p$
      create policy %1$I_delete_admin on public.%1$I
        for delete to authenticated
        using ((select app.is_admin()))
    $p$, t);
    execute format('create trigger set_updated_at before update on public.%I
                    for each row execute function app.tg_set_updated_at()', t);
    execute format('create trigger audit_row after insert or update or delete on public.%I
                    for each row execute function app.tg_audit_row()', t);
  end loop;

  -- Reference data: staff read; admin+ops manage (the PM can 'add new' from
  -- stage forms); deletes stay admin-only.
  foreach t in array array['hoas', 'surveyors', 'crews', 'finance_partners']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format($p$
      create policy %1$I_select on public.%1$I
        for select to authenticated
        using ((select app.current_user_role()) in ('admin', 'ops', 'designer', 'finance'))
    $p$, t);
    execute format($p$
      create policy %1$I_write_i on public.%1$I
        for insert to authenticated
        with check ((select app.current_user_role()) in ('admin', 'ops'))
    $p$, t);
    execute format($p$
      create policy %1$I_write_u on public.%1$I
        for update to authenticated
        using ((select app.current_user_role()) in ('admin', 'ops'))
        with check ((select app.current_user_role()) in ('admin', 'ops'))
    $p$, t);
    execute format($p$
      create policy %1$I_delete_admin on public.%1$I
        for delete to authenticated
        using ((select app.is_admin()))
    $p$, t);
    execute format('create trigger audit_row after insert or update or delete on public.%I
                    for each row execute function app.tg_audit_row()', t);
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- 6. PM-centric permission adjustments
-- -----------------------------------------------------------------------------

-- The PM (ops) creates projects and clients; dealers keep their own-book
-- intake. Dealers become read-only on existing projects (manual version:
-- portals are read-only; the PM is the single operator).
-- Evaluate project visibility on the row's own columns (not via
-- can_access_project's self-lookup): INSERT … RETURNING must pass the SELECT
-- policy, and a self-lookup can't see the row inside the inserting
-- statement's snapshot. Also one query cheaper on every scan.
drop policy projects_select on public.projects;
create policy projects_select on public.projects
  for select to authenticated
  using (
    (select app.current_user_role()) in ('admin', 'ops')
    or assigned_designer_id = (select app.current_designer_id())
    or dealer_id in (select app.current_dealer_ids())
    or client_id in (select app.current_client_ids())
  );

-- SECURITY DEFINER so the projects policy below doesn't expand the clients
-- policy inline (clients' policy references projects — a direct subquery here
-- would be detected as policy recursion now that projects_select reads its
-- own columns instead of going through a function).
create or replace function app.client_belongs_to_dealer(p_client uuid, p_dealer uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.clients c
    where c.id = p_client and c.dealer_id = p_dealer
  );
$$;

grant execute on function app.client_belongs_to_dealer(uuid, uuid) to authenticated;

drop policy projects_insert on public.projects;
create policy projects_insert on public.projects
  for insert to authenticated
  with check (
    (select app.current_user_role()) in ('admin', 'ops')
    or (
      dealer_id in (select app.current_dealer_ids())
      and app.client_belongs_to_dealer(client_id, dealer_id)
    )
  );

drop policy projects_update on public.projects;
create policy projects_update on public.projects
  for update to authenticated
  using (app.is_project_staff(id))
  with check (app.is_project_staff(id));

drop policy clients_insert on public.clients;
create policy clients_insert on public.clients
  for insert to authenticated
  with check (
    (select app.current_user_role()) in ('admin', 'ops')
    or dealer_id in (select app.current_dealer_ids())
  );

-- 'Add new' from stage forms: jurisdictions/utilities become admin+ops managed.
drop policy jurisdictions_write_admin on public.jurisdictions;
create policy jurisdictions_write on public.jurisdictions
  for all to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops'))
  with check ((select app.current_user_role()) in ('admin', 'ops'));

drop policy utilities_write_admin on public.utilities;
create policy utilities_write on public.utilities
  for all to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops'))
  with check ((select app.current_user_role()) in ('admin', 'ops'));

-- The per-project activity log is the PM's working record: ops reads
-- project-scoped audit rows (global/system rows stay admin-only).
drop policy audit_log_select_admin on public.audit_log;
create policy audit_log_select on public.audit_log
  for select to authenticated
  using (
    (select app.is_admin())
    or ((select app.current_user_role()) = 'ops' and project_id is not null)
  );

-- The PM assigns people: admin+ops can list profiles (PM dropdown), and see
-- designers/surveyors/crews via their own tables.
drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or (select app.current_user_role()) in ('admin', 'ops')
  );



-- >>> 20260803001300_admin_panel.sql

-- =============================================================================
-- 001300 — Admin panel: user management engine, reference-record fields,
--          company settings
-- =============================================================================
-- Implements the Admin Panel spec: admin-set passwords with
-- force-change-on-first-login, invitation resend/cancel, guarded deletion
-- that never breaks history, self-service password change for every role,
-- richer surveyor/designer/crew/vendor records, and the app_settings
-- singleton. Every action is audited; password values never are.

-- -----------------------------------------------------------------------------
-- 1. Reference-record fields the panel edits
-- -----------------------------------------------------------------------------

alter table public.surveyors
  add column service_area text,
  add column rating       integer check (rating between 1 and 5),
  add column notes        text;

alter table public.designers
  add column email                    text,
  add column phone                    text,
  add column default_turnaround_hours integer not null default 48,
  add column notes                    text;

alter table public.crews
  add column contact_person text,
  add column phone          text,
  add column email          text,
  add column crew_size      integer,
  add column service_area   text,
  add column rating         integer check (rating between 1 and 5),
  add column notes          text;

alter table public.vendors
  add column contact_person text,
  add column email          text,
  add column phone          text,
  add column lead_time_days integer,
  add column account_number text,
  add column notes          text;

-- -----------------------------------------------------------------------------
-- 2. Company settings (singleton row)
-- -----------------------------------------------------------------------------

create table public.app_settings (
  id                              boolean primary key default true check (id),
  company_name                    text,
  company_address                 text,
  company_license                 text,
  signer_user_id                  uuid references public.profiles (id),
  default_design_turnaround_hours integer not null default 48,
  co_prefix                       text not null default 'CO-',
  co_next_number                  integer not null default 1,
  updated_at                      timestamptz not null default now()
);

insert into public.app_settings (id) values (true);

alter table public.app_settings enable row level security;
grant select, update on public.app_settings to authenticated;

create policy app_settings_select on public.app_settings
  for select to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops'));

create policy app_settings_update on public.app_settings
  for update to authenticated
  using ((select app.is_admin()))
  with check ((select app.is_admin()));

create trigger set_updated_at before update on public.app_settings
  for each row execute function app.tg_set_updated_at();
create trigger audit_row after update on public.app_settings
  for each row execute function app.tg_audit_row();

-- -----------------------------------------------------------------------------
-- 3. User management engine (auth schema)
-- -----------------------------------------------------------------------------

alter table auth.users add column force_password_change boolean not null default false;
alter table public.profiles add column deleted_at timestamptz;

-- Login now reports whether the user must set a new password first.
drop function auth.login_with_password(text, text);
create function auth.login_with_password(p_email text, p_password text)
returns table (
  user_id               uuid,
  session_token         text,
  user_role             public.user_role,
  is_active             boolean,
  full_name             text,
  force_password_change boolean
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
  if not found or v_profile.deleted_at is not null then
    return;
  end if;

  update auth.users u
  set failed_attempts = 0, locked_until = null,
      last_sign_in_at = now(), updated_at = now()
  where u.id = v_user.id;

  return query select
    v_user.id,
    case when v_profile.is_active then auth.new_session(v_user.id) end,
    v_profile.role,
    v_profile.is_active,
    v_profile.full_name,
    v_user.force_password_change;
end;
$$;

-- Sessions carry the must-change flag so the app can hold the user on the
-- change-password screen.
drop function auth.validate_session(text);
create function auth.validate_session(p_token text)
returns table (
  user_id               uuid,
  email                 text,
  user_role             public.user_role,
  is_active             boolean,
  full_name             text,
  must_change_password  boolean
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

  if v_session.last_used_at is null or v_session.last_used_at < now() - interval '1 minute' then
    update auth.sessions s set last_used_at = now() where s.id = v_session.id;
  end if;

  return query
    select u.id, u.email, p.role,
           p.is_active and p.deleted_at is null,
           p.full_name, u.force_password_change
    from auth.users u
    join public.profiles p on p.id = u.id
    where u.id = v_session.user_id;
end;
$$;

-- Any signed-in user changes their own password: current + new, keeps the
-- calling session, revokes every other one.
create function auth.change_password(p_current text, p_new text, p_keep_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_user auth.users%rowtype;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if length(coalesce(p_new, '')) < 8 then
    raise exception 'password must be at least 8 characters';
  end if;

  select u.* into v_user from auth.users u where u.id = v_uid;
  if v_user.encrypted_password is null
     or v_user.encrypted_password
        is distinct from extensions.crypt(p_current, v_user.encrypted_password) then
    raise exception 'current password is incorrect';
  end if;

  update auth.users u
  set encrypted_password = extensions.crypt(p_new, extensions.gen_salt('bf', 12)),
      force_password_change = false, updated_at = now()
  where u.id = v_uid;

  update auth.sessions s
  set revoked_at = coalesce(s.revoked_at, now())
  where s.user_id = v_uid and s.token_hash <> auth.hash_token(p_keep_token);

  perform app.write_audit('auth.password_changed', 'profiles', v_uid::text);
end;
$$;

-- Internal guard for the admin_* functions below.
create function auth.require_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or app.current_user_role() is distinct from 'admin' then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

-- Panel row source: profile + credential state in one call.
create function auth.admin_list_users()
returns table (
  user_id               uuid,
  email                 text,
  full_name             text,
  phone                 text,
  role                  public.user_role,
  is_active             boolean,
  deleted_at            timestamptz,
  has_password          boolean,
  invite_pending        boolean,
  force_password_change boolean,
  last_sign_in_at       timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform auth.require_admin();
  return query
    select u.id, u.email, p.full_name, p.phone, p.role, p.is_active, p.deleted_at,
           u.encrypted_password is not null,
           exists (select 1 from auth.one_time_tokens t
                   where t.user_id = u.id and t.purpose = 'invite'
                     and t.consumed_at is null and t.expires_at > now()),
           u.force_password_change,
           u.last_sign_in_at
    from auth.users u
    join public.profiles p on p.id = u.id
    order by p.deleted_at nulls first, u.created_at;
end;
$$;

-- Create a user either with an admin-set password (account works
-- immediately; force-change defaults on) or as an invitation (token
-- returned for the email). Customers never get passwords or invite tokens.
create function auth.admin_create_user(
  p_email        text,
  p_role         text,
  p_full_name    text default null,
  p_phone        text default null,
  p_password     text default null,
  p_force_change boolean default true
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
  perform auth.require_admin();
  if p_role not in ('admin', 'ops', 'designer', 'finance', 'dealer', 'customer') then
    raise exception 'invalid role %', p_role;
  end if;
  if p_password is not null and length(p_password) < 8 then
    raise exception 'password must be at least 8 characters';
  end if;

  insert into auth.users (email, raw_app_meta_data, raw_user_meta_data,
                          encrypted_password, email_confirmed_at, force_password_change)
  values (
    lower(p_email),
    jsonb_build_object('user_role', p_role),
    case when p_full_name is null then '{}'::jsonb
         else jsonb_build_object('full_name', p_full_name) end,
    case when p_password is null then null
         else extensions.crypt(p_password, extensions.gen_salt('bf', 12)) end,
    case when p_password is null then null else now() end,
    p_password is not null and p_force_change
  )
  returning id into v_id;

  if p_phone is not null then
    update public.profiles set phone = p_phone where id = v_id;
  end if;

  if p_password is null and p_role <> 'customer' then
    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    insert into auth.one_time_tokens (user_id, purpose, token_hash, expires_at)
    values (v_id, 'invite', auth.hash_token(v_token), now() + interval '7 days');
  end if;

  perform app.write_audit('user.created', 'profiles', v_id::text, null, null, null,
    jsonb_build_object('role', p_role, 'method',
      case when p_password is null then 'invite' else 'password_set_by_admin' end));

  return query select v_id, v_token;
end;
$$;

-- Admin sets another user's password directly. Existing sessions die; the
-- password value is never logged.
create function auth.admin_set_password(
  p_user_id      uuid,
  p_password     text,
  p_force_change boolean default true
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform auth.require_admin();
  if length(coalesce(p_password, '')) < 8 then
    raise exception 'password must be at least 8 characters';
  end if;
  update auth.users u
  set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 12)),
      email_confirmed_at = coalesce(u.email_confirmed_at, now()),
      force_password_change = p_force_change,
      failed_attempts = 0, locked_until = null, updated_at = now()
  where u.id = p_user_id;
  if not found then
    raise exception 'user not found';
  end if;
  update auth.one_time_tokens t set consumed_at = now()
  where t.user_id = p_user_id and t.purpose = 'invite' and t.consumed_at is null;
  perform auth.revoke_all_sessions(p_user_id);
  perform app.write_audit('user.password_set_by_admin', 'profiles', p_user_id::text);
end;
$$;

create function auth.admin_force_logout(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform auth.require_admin();
  perform auth.revoke_all_sessions(p_user_id);
  perform app.write_audit('user.sessions_revoked', 'profiles', p_user_id::text);
end;
$$;

create function auth.admin_resend_invite(p_user_id uuid)
returns table (invite_token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  perform auth.require_admin();
  if (select u.encrypted_password from auth.users u where u.id = p_user_id) is not null then
    raise exception 'user already has a password';
  end if;
  update auth.one_time_tokens t set consumed_at = now()
  where t.user_id = p_user_id and t.purpose = 'invite' and t.consumed_at is null;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into auth.one_time_tokens (user_id, purpose, token_hash, expires_at)
  values (p_user_id, 'invite', auth.hash_token(v_token), now() + interval '7 days');
  perform app.write_audit('user.invite_resent', 'profiles', p_user_id::text);
  return query select v_token;
end;
$$;

create function auth.admin_cancel_invite(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform auth.require_admin();
  update auth.one_time_tokens t set consumed_at = now()
  where t.user_id = p_user_id and t.purpose = 'invite' and t.consumed_at is null;
  perform app.write_audit('user.invite_cancelled', 'profiles', p_user_id::text);
end;
$$;

-- Deletion that never breaks history: credentials and PII are scrubbed, the
-- profile row (and every FK pointing at it) survives with a deleted marker.
-- Blocked when the target is the only remaining active admin.
create function auth.admin_delete_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_role public.user_role;
begin
  perform auth.require_admin();
  select p.role into v_role from public.profiles p where p.id = p_user_id and p.deleted_at is null;
  if v_role is null then
    raise exception 'user not found';
  end if;
  if v_role = 'admin' and not exists (
    select 1 from public.profiles p
    where p.role = 'admin' and p.is_active and p.deleted_at is null and p.id <> p_user_id
  ) then
    raise exception 'cannot delete the only remaining admin' using errcode = '42501';
  end if;

  select u.email into v_email from auth.users u where u.id = p_user_id;

  perform auth.revoke_all_sessions(p_user_id);
  delete from auth.one_time_tokens t where t.user_id = p_user_id;
  update auth.users u
  set encrypted_password = null,
      email = 'deleted+' || p_user_id || '@users.deleted',
      raw_app_meta_data = '{}'::jsonb, raw_user_meta_data = '{}'::jsonb,
      force_password_change = false, updated_at = now()
  where u.id = p_user_id;
  update public.profiles p
  set is_active = false, deleted_at = now(), email = null, phone = null
  where p.id = p_user_id;

  perform app.write_audit('user.deleted', 'profiles', p_user_id::text, null, null, null,
    jsonb_build_object('email', v_email));
end;
$$;

-- Token acceptance also clears any force-change flag.
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
  if length(coalesce(p_password, '')) < 8 then
    raise exception 'password must be at least 8 characters';
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
      force_password_change = false,
      failed_attempts = 0, locked_until = null, updated_at = now()
  where u.id = v_token.user_id;

  perform auth.revoke_all_sessions(v_token.user_id);

  return query
    select v_token.user_id, auth.new_session(v_token.user_id), p.role, p.full_name
    from public.profiles p
    where p.id = v_token.user_id and p.is_active;
end;
$$;

-- Grants (guards live inside the functions).
revoke execute on function
  auth.login_with_password(text, text),
  auth.validate_session(text),
  auth.change_password(text, text, text),
  auth.require_admin(),
  auth.admin_list_users(),
  auth.admin_create_user(text, text, text, text, text, boolean),
  auth.admin_set_password(uuid, text, boolean),
  auth.admin_force_logout(uuid),
  auth.admin_resend_invite(uuid),
  auth.admin_cancel_invite(uuid),
  auth.admin_delete_user(uuid)
from public, anon;

grant execute on function
  auth.login_with_password(text, text),
  auth.validate_session(text),
  auth.change_password(text, text, text),
  auth.admin_list_users(),
  auth.admin_create_user(text, text, text, text, text, boolean),
  auth.admin_set_password(uuid, text, boolean),
  auth.admin_force_logout(uuid),
  auth.admin_resend_invite(uuid),
  auth.admin_cancel_invite(uuid),
  auth.admin_delete_user(uuid)
to authenticated;



-- >>> 20260803001400_stage_fields.sql

-- =============================================================================
-- 001400 — Stage field specification (data-entry forms)
-- =============================================================================
-- Implements the "Stage Field Specification" PDF, which supersedes the earlier
-- breakdown's stage field tables: payment milestones (Down Payment, Cash
-- M1–M3), the five Permit tracks (Permit · ICA · HOA · Cash M2 · HDM NTP),
-- partner-labelled Finance M1/M2 milestones stored ONCE per project, and the
-- Drive Updated gate closing every stage. 'Days' fields are computed from
-- dates at read time — never stored. The old stage tables (built from the
-- earlier draft, empty in every deployment) are replaced.

drop table if exists public.stage_survey;
drop table if exists public.stage_design;
drop table if exists public.stage_procurement;
drop table if exists public.stage_install;
drop table if exists public.stage_inspection;

-- Stage 1 · Site Survey ------------------------------------------------------
create table public.stage1_survey (
  project_id uuid primary key references public.projects (id) on delete cascade,
  down_payment_status text not null default 'not_requested'
    check (down_payment_status in ('not_requested', 'requested', 'initiated', 'received')),
  down_payment_requested_date date,
  down_payment_initiated_date date,
  down_payment_received_date  date,
  cash_m1_status text not null default 'not_requested'
    check (cash_m1_status in ('not_requested', 'requested', 'initiated', 'received', 'na')),
  cash_m1_requested_date date,
  cash_m1_initiated_date date,
  cash_m1_received_date  date,
  survey_status text not null default 'not_scheduled'
    check (survey_status in ('not_scheduled', 'scheduled', 'completed', 'rescheduled', 'cancelled')),
  survey_completed_date date,
  adders_details text,
  drive_updated boolean not null default false,
  drive_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Stage 2 · Design -----------------------------------------------------------
create table public.stage2_design (
  project_id uuid primary key references public.projects (id) on delete cascade,
  designer_id uuid references public.designers (id),
  design_status text not null default 'not_requested'
    check (design_status in ('not_requested', 'requested', 'in_progress', 'received', 'revision_requested')),
  design_requested_date date,
  design_received_date  date,
  shading_report_date   date,
  pm_notes text,
  stamps_status text not null default 'not_requested'
    check (stamps_status in ('not_requested', 'requested', 'received', 'na')),
  stamps_requested_date date,
  stamps_received_date  date,
  drive_updated boolean not null default false,
  drive_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Stage 3 · Permit (five tracks, flat columns) --------------------------------
create table public.stage3_permit (
  project_id uuid primary key references public.projects (id) on delete cascade,
  required_permits text[] not null default '{}',
  permit_status text not null default 'not_applied'
    check (permit_status in ('not_applied', 'applied', 'in_review', 'revision_requested', 'approved', 'rejected')),
  permit_pm_notes       text,
  permit_revision_notes text,
  permit_applied_date   date,
  permit_received_date  date,
  ica_status text not null default 'not_applied'
    check (ica_status in ('not_applied', 'applied', 'in_review', 'revision_requested', 'approved', 'rejected')),
  ica_pm_notes       text,
  ica_revision_notes text,
  ica_applied_date   date,
  ica_received_date  date,
  hoa_status text not null default 'not_applied'
    check (hoa_status in ('na', 'not_applied', 'applied', 'in_review', 'revision_requested', 'approved', 'rejected')),
  hoa_revision_notes text,
  hoa_applied_date   date,
  hoa_received_date  date,
  cash_m2_status text not null default 'not_requested'
    check (cash_m2_status in ('not_requested', 'requested', 'initiated', 'received', 'na')),
  cash_m2_requested_date date,
  cash_m2_initiated_date date,
  cash_m2_received_date  date,
  hdm_ntp_status text not null default 'not_submitted'
    check (hdm_ntp_status in ('not_submitted', 'submitted', 'approved', 'rejected', 'na')),
  hdm_ntp_submitted_date date,
  hdm_ntp_approved_date  date,
  drive_updated boolean not null default false,
  drive_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Stage 4 · Procurement --------------------------------------------------------
create table public.stage4_procurement (
  project_id uuid primary key references public.projects (id) on delete cascade,
  procurement_manager uuid references public.profiles (id),
  material_status text not null default 'not_requested'
    check (material_status in ('not_requested', 'requested', 'ordered', 'in_transit', 'delivered', 'backordered')),
  material_requested_date date,
  material_delivered_date date,
  pm_notes text,
  drive_updated boolean not null default false,
  drive_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Stage 5 · Installation --------------------------------------------------------
create table public.stage5_install (
  project_id uuid primary key references public.projects (id) on delete cascade,
  install_manager uuid references public.profiles (id),
  install_status text not null default 'not_scheduled'
    check (install_status in ('not_scheduled', 'requested', 'scheduled', 'in_progress', 'completed', 'on_hold')),
  install_requested_date date,
  install_scheduled_date date,
  install_completed_date date,
  cash_m3_status text not null default 'not_requested'
    check (cash_m3_status in ('not_requested', 'requested', 'initiated', 'received', 'na')),
  cash_m3_requested_date date,
  cash_m3_initiated_date date,
  cash_m3_received_date  date,
  drive_updated boolean not null default false,
  drive_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Stage 6 · Inspection & PTO -----------------------------------------------------
create table public.stage6_inspection (
  project_id uuid primary key references public.projects (id) on delete cascade,
  inspection_status text not null default 'not_requested'
    check (inspection_status in ('not_requested', 'requested', 'scheduled', 'passed', 'failed', 'reinspection_scheduled')),
  inspection_failed_notes text,
  inspection_requested_date date,
  inspection_completed_date date,
  pm_notes text,
  pto_status text not null default 'not_applied'
    check (pto_status in ('not_applied', 'applied', 'in_review', 'received', 'rejected')),
  pto_applied_date  date,
  pto_received_date date,
  energization_status text not null default 'not_started'
    check (energization_status in ('not_started', 'in_progress', 'energized', 'issue')),
  energization_date date,
  drive_updated boolean not null default false,
  drive_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Finance M1/M2 — ONE field set per project (the label follows the project's
-- finance partner), rendered on the Install and Inspection forms.
create table public.finance_milestones (
  project_id uuid primary key references public.projects (id) on delete cascade,
  m1_status text not null default 'not_submitted'
    check (m1_status in ('not_submitted', 'submitted', 'approved', 'rejected', 'na')),
  m1_submitted_date date,
  m1_approved_date  date,
  m2_status text not null default 'not_submitted'
    check (m2_status in ('not_submitted', 'submitted', 'approved', 'rejected', 'na')),
  m2_submitted_date date,
  m2_approved_date  date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS + audit + updated_at for all seven, same shape as before: participants
-- read their project's rows, staff (admin/ops) write, deletes admin-only.
do $$
declare
  t text;
begin
  foreach t in array array['stage1_survey', 'stage2_design', 'stage3_permit',
                           'stage4_procurement', 'stage5_install',
                           'stage6_inspection', 'finance_milestones']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format($p$
      create policy %1$I_select on public.%1$I
        for select to authenticated
        using (app.can_access_project(project_id))
    $p$, t);
    execute format($p$
      create policy %1$I_write_i on public.%1$I
        for insert to authenticated
        with check (app.is_project_staff(project_id))
    $p$, t);
    execute format($p$
      create policy %1$I_write_u on public.%1$I
        for update to authenticated
        using (app.is_project_staff(project_id))
        with check (app.is_project_staff(project_id))
    $p$, t);
    execute format($p$
      create policy %1$I_delete_admin on public.%1$I
        for delete to authenticated
        using ((select app.is_admin()))
    $p$, t);
    execute format('create trigger set_updated_at before update on public.%I
                    for each row execute function app.tg_set_updated_at()', t);
    execute format('create trigger audit_row after insert or update or delete on public.%I
                    for each row execute function app.tg_audit_row()', t);
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- Staff uploads (shading reports, install pictures) and deletes — governed,
-- audited, byte storage beside the metadata like the grant path.
-- -----------------------------------------------------------------------------

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
     case when p_mime = 'application/pdf' then 'pdf' else 'photo' end,
     btrim(p_category), p_filename, p_mime, octet_length(p_data), false, auth.uid())
  returning id into v_document_id;

  perform app.write_audit('document.uploaded', 'documents', v_document_id::text, p_project_id,
    null, null, jsonb_build_object('category', p_category, 'filename', p_filename));

  return v_document_id;
end;
$$;

create or replace function public.delete_document(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents%rowtype;
begin
  select d.* into v_doc from public.documents d where d.id = p_document_id;
  if not found then
    raise exception 'document not found';
  end if;
  if not app.is_project_staff(v_doc.project_id) then
    raise exception 'only project staff may delete documents' using errcode = '42501';
  end if;

  delete from storage.objects o where o.bucket_id = v_doc.bucket and o.name = v_doc.object_path;
  delete from public.documents d where d.id = p_document_id;

  perform app.write_audit('document.deleted', 'documents', p_document_id::text, v_doc.project_id,
    null, null, jsonb_build_object('category', v_doc.category, 'filename', v_doc.title));
end;
$$;

revoke execute on function public.record_staff_upload(uuid, text, text, text, bytea) from public, anon;
grant execute on function public.record_staff_upload(uuid, text, text, text, bytea) to authenticated;
revoke execute on function public.delete_document(uuid) from public, anon;
grant execute on function public.delete_document(uuid) to authenticated;



-- >>> 20260803001500_complete_hold_cancel.sql

-- =============================================================================
-- 001500 — Stage 7 (Complete) + Hold & Cancelled side stages
-- =============================================================================
-- Adds the terminal Complete stage and the two side stages that any project
-- can enter from any stage, bypassing validation (a customer pulls out or a
-- site fails mid-stage — these moves must never be blocked). Origin stage is
-- stored on both side records so resume/reinstate restore the project exactly.
-- Held/cancelled projects are excluded from active counts but never deleted.

alter type public.project_stage add value if not exists 'complete' after 'inspection_pto';

-- Stage 7 · Complete (terminal; filled once the project lands here) ----------
create table public.stage7_complete (
  project_id uuid primary key references public.projects (id) on delete cascade,
  completion_status text not null default 'complete'
    check (completion_status in ('complete', 'complete_with_open_items')),
  completion_date date,
  completion_notes text,
  final_drive_updated boolean not null default false,
  final_drive_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Hold — re-entrant: one row per hold, current hold = the row with no
-- resume_date. Days-excluding-hold is derivable by summing resolved holds.
create table public.project_holds (
  id                  bigint generated always as identity primary key,
  project_id          uuid not null references public.projects (id) on delete cascade,
  reason              text not null,
  notes               text not null,
  hold_start_date     date not null default current_date,
  expected_resume_date date,
  stage_held_from     public.project_stage not null,
  resume_date         date,
  created_by          uuid references public.profiles (id),
  created_at          timestamptz not null default now()
);

create index project_holds_open_idx on public.project_holds (project_id) where resume_date is null;

-- Cancelled — one record per project (reinstatable). stage_cancelled_from is
-- the single most useful figure for where projects are lost.
create table public.project_cancellation (
  project_id               uuid primary key references public.projects (id) on delete cascade,
  reason                   text not null,
  notes                    text not null,
  cancellation_date        date not null default current_date,
  stage_cancelled_from     public.project_stage not null,
  refund_required          boolean not null default false,
  refund_status            text check (refund_status in ('not_required', 'pending', 'processed')),
  refund_amount            numeric(12,2),
  equipment_return_required boolean not null default false,
  drive_updated            boolean not null default false,
  reinstated_at            timestamptz,
  created_by               uuid references public.profiles (id),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- RLS + audit + updated_at.
alter table public.stage7_complete enable row level security;
grant select, insert, update, delete on public.stage7_complete to authenticated;
create policy stage7_complete_select on public.stage7_complete
  for select to authenticated using (app.can_access_project(project_id));
create policy stage7_complete_write_i on public.stage7_complete
  for insert to authenticated with check (app.is_project_staff(project_id));
create policy stage7_complete_write_u on public.stage7_complete
  for update to authenticated using (app.is_project_staff(project_id)) with check (app.is_project_staff(project_id));
create policy stage7_complete_delete on public.stage7_complete
  for delete to authenticated using ((select app.is_admin()));
create trigger set_updated_at before update on public.stage7_complete
  for each row execute function app.tg_set_updated_at();
create trigger audit_row after insert or update or delete on public.stage7_complete
  for each row execute function app.tg_audit_row();

alter table public.project_holds enable row level security;
grant select, insert, update, delete on public.project_holds to authenticated;
create policy project_holds_select on public.project_holds
  for select to authenticated using (app.can_access_project(project_id));
create policy project_holds_write_i on public.project_holds
  for insert to authenticated with check (app.is_project_staff(project_id));
create policy project_holds_write_u on public.project_holds
  for update to authenticated using (app.is_project_staff(project_id)) with check (app.is_project_staff(project_id));
create policy project_holds_delete on public.project_holds
  for delete to authenticated using ((select app.is_admin()));
create trigger audit_row after insert or update or delete on public.project_holds
  for each row execute function app.tg_audit_row();

alter table public.project_cancellation enable row level security;
grant select, insert, update, delete on public.project_cancellation to authenticated;
create policy project_cancellation_select on public.project_cancellation
  for select to authenticated using (app.can_access_project(project_id));
create policy project_cancellation_write_i on public.project_cancellation
  for insert to authenticated with check (app.is_project_staff(project_id));
create policy project_cancellation_write_u on public.project_cancellation
  for update to authenticated using (app.is_project_staff(project_id)) with check (app.is_project_staff(project_id));
create policy project_cancellation_delete on public.project_cancellation
  for delete to authenticated using ((select app.is_admin()));
create trigger set_updated_at before update on public.project_cancellation
  for each row execute function app.tg_set_updated_at();
create trigger audit_row after insert or update or delete on public.project_cancellation
  for each row execute function app.tg_audit_row();


