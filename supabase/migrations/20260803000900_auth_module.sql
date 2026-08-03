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
-- (never a Supabase session).
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

-- Hosted Supabase default-privileges hand new tables broad grants; make the
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
