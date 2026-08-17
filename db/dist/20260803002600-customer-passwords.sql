-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · newest module only · 20260803002600_customer_passwords.sql
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

-- >>> 20260803002600_customer_passwords.sql
-- =============================================================================
-- 002600 — Homeowners sign in with a password
-- =============================================================================
-- The original design gave customers a one-time email code instead of a
-- password: nothing to remember, nothing to reset. In practice a homeowner
-- opening an app once a week does not want to fetch a code from their inbox
-- every time — they want the password their phone's keychain already filled in.
--
-- The auth engine already accepts a customer password (auth.login_with_password
-- has never cared about role) and 002400 gave admins the tools to set one. Two
-- things still encoded the old assumption:
--
--   1. auth.request_recovery returned nothing for a customer, so 'forgot my
--      password' was impossible for them — and the 'Send reset link' button in
--      Admin → Customers silently did nothing.
--   2. The homeowner door offered only the code form.
--
-- This migration fixes (1). The door is fixed in the app.

create or replace function auth.request_recovery(p_email text)
returns table (recovery_token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user auth.users%rowtype;
  v_active boolean;
  v_token text;
begin
  select u.* into v_user from auth.users u where lower(u.email) = lower(p_email);
  if not found then
    return;   -- no account oracle: the caller always sees the same answer
  end if;

  select p.is_active into v_active from public.profiles p where p.id = v_user.id;

  -- Every active account may reset a password, homeowners included. A customer
  -- who has never set one (mid-invitation) is deliberately allowed too: the
  -- token lets them finish, which is exactly what someone who lost the
  -- invitation email needs.
  if not coalesce(v_active, false) then
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

-- -----------------------------------------------------------------------------
-- Creating a homeowner's login with a password directly
-- -----------------------------------------------------------------------------
-- 002400 gave PMs an invite path (public.customer_portal_invite) where the
-- customer sets their own password from an emailed link. This is the other half,
-- for the customer who says 'just tell me a password on the phone': the admin
-- sets one now, and the customer is asked to change it on first sign-in.
--
-- Admin-only, because it hands out a working credential.

create or replace function public.customer_portal_set_initial_password(
  p_customer uuid,
  p_password text,
  /** Ask them to choose their own on first sign-in. Default yes. */
  p_force_change boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_name  text;
  v_user  uuid;
begin
  if not app.is_admin() then
    raise exception 'only an admin may set a customer password' using errcode = '42501';
  end if;
  if length(coalesce(p_password, '')) < 10 then
    raise exception 'password must be at least 10 characters' using errcode = '22023';
  end if;

  select nullif(btrim(c.email), ''), c.first_name || ' ' || c.last_name, c.user_id
  into v_email, v_name, v_user
  from public.clients c where c.id = p_customer;

  if not found then
    raise exception 'customer not found';
  end if;
  if v_email is null then
    raise exception 'customer has no email address' using errcode = '22023';
  end if;

  if v_user is null then
    -- No login yet: create one that works immediately.
    insert into auth.users (email, encrypted_password, email_confirmed_at,
                            force_password_change, raw_app_meta_data, raw_user_meta_data)
    values (lower(v_email),
            extensions.crypt(p_password, extensions.gen_salt('bf', 12)),
            now(),
            p_force_change,
            jsonb_build_object('user_role', 'customer'),
            jsonb_build_object('full_name', v_name))
    returning id into v_user;

    update public.clients set user_id = v_user where id = p_customer;
  else
    update auth.users u
    set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 12)),
        email_confirmed_at = coalesce(u.email_confirmed_at, now()),
        force_password_change = p_force_change,
        failed_attempts = 0, locked_until = null, updated_at = now()
    where u.id = v_user;

    -- Any outstanding invitation is spent: the password just set is the way in.
    update auth.one_time_tokens t set consumed_at = now()
    where t.user_id = v_user and t.purpose = 'invite' and t.consumed_at is null;

    -- Existing sessions die, exactly as they do for a staff password change.
    perform auth.revoke_all_sessions(v_user);
  end if;

  -- The profile must exist and be active for the login to be usable; the
  -- on_auth_user_created trigger creates it, this makes the role explicit.
  update public.profiles set role = 'customer', is_active = true where id = v_user;

  perform app.write_audit('customer.portal_password_set', 'clients', p_customer::text,
    null, null, null, jsonb_build_object('login', v_user, 'force_change', p_force_change));

  return v_user;
end;
$$;

revoke execute on function
  public.customer_portal_set_initial_password(uuid, text, boolean) from public, anon;
grant execute on function
  public.customer_portal_set_initial_password(uuid, text, boolean) to authenticated;


-- >>> migration bookkeeping
create table if not exists public.schema_migrations (
  name       text primary key,
  applied_at timestamptz not null default now()
);
insert into public.schema_migrations (name) values ('20260803002600_customer_passwords.sql')
on conflict (name) do nothing;
