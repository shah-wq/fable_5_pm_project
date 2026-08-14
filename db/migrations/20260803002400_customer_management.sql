-- =============================================================================
-- 002400 — Managing customers (identity, merge, archive, anonymise)
-- =============================================================================
-- Implements the "Managing customers" spec. The customer is a person and the
-- project is a job: one client row can carry several projects, so this module
-- is about finding, correcting, merging and controlling portal access for
-- records that already exist — not primarily about adding them.
--
-- Two rules are enforced in the database rather than the UI: a customer with
-- projects or leads cannot be deleted (the foreign keys are NO ACTION), and
-- destructive operations run through definer functions that check the caller
-- is an admin.

alter table public.clients
  add column if not exists alternate_phone   text,
  add column if not exists preferred_language text,
  add column if not exists mailing_address   text,
  /** Admin/PM only — never crosses to the customer portal. */
  add column if not exists internal_notes    text,
  /** Archived customers drop out of default search; projects are untouched. */
  add column if not exists is_archived       boolean not null default false,
  add column if not exists anonymised_at     timestamptz;

-- Email is the portal login identity, so it must be unique — case-insensitively
-- and trimmed, because the commonest mess is the same address stored twice with
-- different capitalisation or a trailing space.
update public.clients set email = nullif(btrim(email), '') where email is not null;

create unique index if not exists clients_email_ci_key
  on public.clients (lower(btrim(email))) where email is not null;

create index if not exists clients_phone_idx on public.clients (phone) where phone is not null;
create index if not exists clients_archived_idx on public.clients (is_archived);

-- PMs may edit contact details and internal notes; only admins reach the
-- destructive functions below (RLS keeps deletes admin-only already).
drop policy if exists clients_update on public.clients;
create policy clients_update on public.clients
  for update to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops'))
  with check ((select app.current_user_role()) in ('admin', 'ops'));

drop trigger if exists audit_row on public.clients;
create trigger audit_row after insert or update or delete on public.clients
  for each row execute function app.tg_audit_row();

-- Likely duplicates: same email, same phone, or the same site address with a
-- similar name. Surfaced proactively in the admin list so they get merged
-- before they multiply.
create or replace view public.customer_duplicate_candidates as
select
  least(a.id, b.id)  as customer_a,
  greatest(a.id, b.id) as customer_b,
  case
    when lower(btrim(a.email)) = lower(btrim(b.email)) then 'same email'
    when a.phone is not null and a.phone = b.phone then 'same phone'
    else 'same site address'
  end as reason
from public.clients a
join public.clients b
  on b.id <> a.id
 and (
   (a.email is not null and b.email is not null
    and lower(btrim(a.email)) = lower(btrim(b.email)))
   or (a.phone is not null and b.phone is not null and a.phone = b.phone)
   or exists (
     select 1
     from public.projects pa
     join public.projects pb on lower(btrim(pb.address)) = lower(btrim(pa.address))
     where pa.client_id = a.id and pb.client_id = b.id
       and pa.address is not null
       and lower(a.last_name) = lower(b.last_name)
   )
 )
where not a.is_archived and not b.is_archived
group by 1, 2, 3;

grant select on public.customer_duplicate_candidates to authenticated;

-- -----------------------------------------------------------------------------
-- Portal access for customers. The staff auth panel is admin-only by design,
-- but inviting a homeowner to watch their own job is everyday PM work — and
-- auth.admin_create_user deliberately issues no invite token for the customer
-- role, which predates the portal. So customer logins get their own three
-- functions here: read the state, invite, resend. Setting a password,
-- disabling access and forcing a logout stay on the admin-only auth engine.
-- -----------------------------------------------------------------------------

-- The list needs each customer's login state, and auth.users is not readable
-- by the authenticated role. Definer, and admin/PM only.
create or replace function public.customer_login_state()
returns table (
  client_id       uuid,
  user_id         uuid,
  login_email     text,
  is_active       boolean,
  last_sign_in_at timestamptz,
  invite_pending  boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'admin or PM only' using errcode = '42501';
  end if;
  return query
    select c.id, u.id, u.email, p.is_active, u.last_sign_in_at,
           exists (select 1 from auth.one_time_tokens t
                   where t.user_id = u.id and t.purpose = 'invite'
                     and t.consumed_at is null and t.expires_at > now())
    from public.clients c
    join auth.users u on u.id = c.user_id
    left join public.profiles p on p.id = u.id;
end;
$$;

revoke execute on function public.customer_login_state() from public, anon;
grant execute on function public.customer_login_state() to authenticated;

/**
 * Create the customer's portal login and return a one-time invite token. The
 * customer record and the login stay separate facts — the login points at the
 * customer — so this links them and leaves everything else alone.
 */
create or replace function public.customer_portal_invite(p_customer uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_name  text;
  v_user  uuid;
  v_token text;
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'admin or PM only' using errcode = '42501';
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
  if v_user is not null then
    raise exception 'customer already has a login' using errcode = '23505';
  end if;

  insert into auth.users (email, raw_app_meta_data, raw_user_meta_data)
  values (lower(v_email), jsonb_build_object('user_role', 'customer'),
          jsonb_build_object('full_name', v_name))
  returning id into v_user;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into auth.one_time_tokens (user_id, purpose, token_hash, expires_at)
  values (v_user, 'invite', auth.hash_token(v_token), now() + interval '7 days');

  update public.clients set user_id = v_user where id = p_customer;

  perform app.write_audit('customer.portal_invited', 'clients', p_customer::text,
    null, null, null, jsonb_build_object('login', v_user));
  return v_token;
end;
$$;

revoke execute on function public.customer_portal_invite(uuid) from public, anon;
grant execute on function public.customer_portal_invite(uuid) to authenticated;

/** A fresh invite token; any earlier one stops working. */
create or replace function public.customer_portal_resend(p_customer uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user  uuid;
  v_token text;
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'admin or PM only' using errcode = '42501';
  end if;

  select c.user_id into v_user from public.clients c where c.id = p_customer;
  if v_user is null then
    raise exception 'customer has no login' using errcode = '22023';
  end if;
  if (select u.encrypted_password from auth.users u where u.id = v_user) is not null then
    raise exception 'customer has already set a password' using errcode = '22023';
  end if;

  update auth.one_time_tokens t set consumed_at = now()
  where t.user_id = v_user and t.purpose = 'invite' and t.consumed_at is null;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into auth.one_time_tokens (user_id, purpose, token_hash, expires_at)
  values (v_user, 'invite', auth.hash_token(v_token), now() + interval '7 days');

  perform app.write_audit('customer.portal_invite_resent', 'clients', p_customer::text);
  return v_token;
end;
$$;

revoke execute on function public.customer_portal_resend(uuid) from public, anon;
grant execute on function public.customer_portal_resend(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Merge. Everything that references the losing records is re-pointed to the
-- survivor; nothing is deleted. The caller has already chosen, field by field,
-- which values survive — they arrive as an explicit patch.
-- -----------------------------------------------------------------------------
create or replace function public.merge_customers(
  p_survivor uuid,
  p_merged   uuid[],
  /** Field values the admin chose to keep, as a jsonb object. */
  p_fields   jsonb default '{}'::jsonb,
  /** Which record's login remains (null = keep the survivor's). */
  p_keep_login uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_login    uuid;
  v_projects int;
  v_requests int;
  v_documents int;
  v_leads    int;
begin
  if not app.is_admin() then
    raise exception 'only an admin may merge customers' using errcode = '42501';
  end if;
  if p_survivor is null or coalesce(array_length(p_merged, 1), 0) = 0 then
    raise exception 'a survivor and at least one record to merge are required';
  end if;
  if p_survivor = any (p_merged) then
    raise exception 'the survivor cannot also be merged away';
  end if;
  if not exists (select 1 from public.clients where id = p_survivor) then
    raise exception 'surviving customer not found';
  end if;

  -- The login that remains: one carried across, or the survivor's own.
  v_login := coalesce(p_keep_login, (select user_id from public.clients where id = p_survivor));

  -- Clear the merged records' email and login FIRST, so the survivor can take
  -- either without tripping the case-insensitive unique email index.
  update public.clients
  set email = null,
      user_id = null,
      is_archived = true
  where id = any (p_merged);

  -- Apply the field-by-field choices, then the chosen email and login.
  update public.clients set
    first_name         = coalesce(p_fields ->> 'first_name', first_name),
    last_name          = coalesce(p_fields ->> 'last_name', last_name),
    email              = coalesce(p_fields ->> 'email', email),
    phone              = coalesce(p_fields ->> 'phone', phone),
    alternate_phone    = coalesce(p_fields ->> 'alternate_phone', alternate_phone),
    mailing_address    = coalesce(p_fields ->> 'mailing_address', mailing_address),
    preferred_contact  = coalesce(p_fields ->> 'preferred_contact', preferred_contact),
    preferred_language = coalesce(p_fields ->> 'preferred_language', preferred_language),
    internal_notes     = coalesce(p_fields ->> 'internal_notes', internal_notes),
    user_id            = v_login
  where id = p_survivor;

  -- Re-point everything the merged records own. Nothing is deleted.
  update public.projects set client_id = p_survivor where client_id = any (p_merged);
  update public.customer_requests set client_id = p_survivor where client_id = any (p_merged);

  -- Any customer login that no longer identifies a customer is disabled rather
  -- than deleted: a Customer login must never point at nothing.
  update public.profiles pr
  set is_active = false
  where pr.role = 'customer'
    and pr.id <> coalesce(v_login, '00000000-0000-0000-0000-000000000000'::uuid)
    and not exists (select 1 from public.clients c where c.user_id = pr.id);

  select count(*) into v_projects from public.projects where client_id = p_survivor;
  select count(*) into v_requests from public.customer_requests where client_id = p_survivor;
  select count(*) into v_documents
  from public.documents d
  join public.projects p on p.id = d.project_id
  where p.client_id = p_survivor;
  select count(*) into v_leads
  from public.leads l
  where l.converted_project_id in (select id from public.projects where client_id = p_survivor);

  return jsonb_build_object(
    'survivor', p_survivor,
    'merged', to_jsonb(p_merged),
    'projects', v_projects,
    'requests', v_requests,
    'documents', v_documents,
    'leads', v_leads,
    'login', v_login
  );
end;
$$;

revoke execute on function public.merge_customers(uuid, uuid[], jsonb, uuid) from public, anon;
grant execute on function public.merge_customers(uuid, uuid[], jsonb, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Anonymise. The right answer when a customer asks for their personal data to
-- be removed but projects exist: redact the person, keep the permit record,
-- the install date and the payment history the business must legally retain.
-- -----------------------------------------------------------------------------
create or replace function public.anonymise_customer(p_customer uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_login uuid;
begin
  if not app.is_admin() then
    raise exception 'only an admin may anonymise a customer' using errcode = '42501';
  end if;

  select user_id into v_login from public.clients where id = p_customer;

  update public.clients set
    first_name = 'Redacted',
    last_name  = 'Customer',
    email = null,
    phone = null,
    alternate_phone = null,
    mailing_address = null,
    internal_notes = null,
    address = '{}'::jsonb,
    user_id = null,
    is_archived = true,
    anonymised_at = now()
  where id = p_customer;

  -- The project keeps its site address and history; only the person's name is
  -- replaced where it was copied onto the project.
  update public.projects set name = 'Redacted Customer' where client_id = p_customer;

  -- The portal login is scrubbed through the auth engine's own path.
  if v_login is not null then
    perform auth.admin_delete_user(v_login);
  end if;
end;
$$;

revoke execute on function public.anonymise_customer(uuid) from public, anon;
grant execute on function public.anonymise_customer(uuid) to authenticated;
