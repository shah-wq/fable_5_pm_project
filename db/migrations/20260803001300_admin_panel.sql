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
