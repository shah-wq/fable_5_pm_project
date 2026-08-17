-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · newest module only · 20260803002700_invite_customers_with_tokens.sql
--
-- For a database that is already up to date apart from this module. Paste the
-- whole file into a SQL console (e.g. the Neon SQL Editor) and run it once.
-- Safe to run again: every statement skips work already done, so 'already
-- exists' errors cannot happen. NOTICE lines saying 'does not exist, skipping'
-- are normal. The bookkeeping row at the end is included.
--
-- Behind by more than this module? Run catch-up-1.sql then catch-up-2.sql
-- instead — they cover everything from 001400 onwards.
-- ============================================================================

-- >>> 20260803002700_invite_customers_with_tokens.sql
-- =============================================================================
-- 002700 — Auto-invited homeowners get a set-password link
-- =============================================================================
-- Fallout from 002600, found while auditing the password surfaces.
--
-- auth.create_invited_user() skipped the invite token when the role was
-- 'customer', because in the original design homeowners had no password to set.
-- Project creation and lead conversion both call it to auto-invite the
-- homeowner — so after 002600 removed the code door, every automatically
-- invited customer got a login with no password and no way to obtain one. Locked
-- out, silently.
--
-- Now every role gets the same 7-day, single-use link.
--
-- (The one deliberate remaining path without a token is an admin setting a
-- password directly — public.customer_portal_set_initial_password — where the
-- password itself is the way in.)

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
  v_id    uuid;
  v_token text;
begin
  -- The original guard, kept exactly: when a user context exists only admins
  -- may invite, but a call with no context is a trusted server-side bootstrap
  -- (scripts/create-admin.mjs, and the SQL test suite). require_admin() would
  -- reject those, which is not the same rule.
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

  -- Every role, homeowners included (002600).
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into auth.one_time_tokens (user_id, purpose, token_hash, expires_at)
  values (v_id, 'invite', auth.hash_token(v_token), now() + interval '7 days');

  return query select v_id, v_token;
end;
$$;

-- Same omission in the admin panel's creation function: with no password and a
-- customer role it produced a login nobody could ever use.
create or replace function auth.admin_create_user(
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

  -- No password means an invitation is the only way in — for every role.
  if p_password is null then
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

-- -----------------------------------------------------------------------------
-- Close the emailed-code door in the database too
-- -----------------------------------------------------------------------------
-- 002600 removed the one-time-code login from the app and deleted its routes.
-- The engine functions were left in place, still granted to the app role — a
-- login path nothing exposes, nobody maintains, and which can mint tokens and
-- send nothing. Revoking execute makes 'homeowners use passwords' true at every
-- layer instead of only in the UI.
--
-- The functions themselves are kept, not dropped: they are referenced by the
-- 001000 grant block, and a future release that genuinely wants a code login
-- should re-grant deliberately rather than rediscover them by accident.

revoke execute on function auth.request_otp(text) from authenticated, anon, public;
revoke execute on function auth.verify_otp(text, text) from authenticated, anon, public;


-- >>> migration bookkeeping
create table if not exists public.schema_migrations (
  name       text primary key,
  applied_at timestamptz not null default now()
);
insert into public.schema_migrations (name) values ('20260803002700_invite_customers_with_tokens.sql')
on conflict (name) do nothing;
