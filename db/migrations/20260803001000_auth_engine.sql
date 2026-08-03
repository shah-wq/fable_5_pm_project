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
