-- =============================================================================
-- 002500 — Customer mobile app (installable portal, push, PM asks)
-- =============================================================================
-- Implements the "Customer mobile app" spec. Its section 0 is the whole
-- architecture: ONE database, ONE API, ONE set of RLS policies. There is no
-- mobile database, no mobile-specific table for project data, and nothing is
-- copied or synced. Everything added here is a shared concept the web portal
-- uses too:
--
--   * push_subscriptions / notification_preferences / push_deliveries — where a
--     device is reachable, what the customer agreed to receive, and what was
--     actually sent (so "under ten pushes per project" is measurable rather
--     than aspirational).
--   * customer_asks — the PM asking the customer for something. The portal's
--     "Needs your attention" card and the app's Photos upload prompt are two
--     renderings of the same rows.
--   * app_settings gains the store URLs, the minimum supported app version and
--     the public legal URLs both stores require.
--
-- Offline caching lives on the device as a read cache with a visible
-- 'last updated' stamp. The server stays the only authoritative copy.

-- -----------------------------------------------------------------------------
-- 1. Push subscriptions — one row per device, owned by the person using it
-- -----------------------------------------------------------------------------

create table if not exists public.push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  /** The push service URL. Unique: re-subscribing the same device updates. */
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,
  /** 'web' | 'ios' | 'android' — which shell registered it. */
  platform      text not null default 'web',
  user_agent    text,
  /** Consecutive send failures; a gone endpoint is pruned, not retried forever. */
  failure_count integer not null default 0,
  disabled_at   timestamptz,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id) where disabled_at is null;

alter table public.push_subscriptions enable row level security;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- Your own devices, nobody else's. Admins may look for support purposes.
drop policy if exists push_subscriptions_select on public.push_subscriptions;
create policy push_subscriptions_select on public.push_subscriptions
  for select to authenticated
  using (user_id = (select auth.uid()) or (select app.is_admin()));

drop policy if exists push_subscriptions_insert on public.push_subscriptions;
create policy push_subscriptions_insert on public.push_subscriptions
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists push_subscriptions_update on public.push_subscriptions;
create policy push_subscriptions_update on public.push_subscriptions
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists push_subscriptions_delete on public.push_subscriptions;
create policy push_subscriptions_delete on public.push_subscriptions
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- 2. Notification preferences — per category, matching the portal (spec §3.5)
-- -----------------------------------------------------------------------------

create table if not exists public.notification_preferences (
  user_id  uuid not null references public.profiles (id) on delete cascade,
  category text not null check (category in
    ('stage_advanced', 'appointment', 'action_needed', 'on_hold', 'power_on')),
  push     boolean not null default true,
  email    boolean not null default true,
  primary key (user_id, category)
);

alter table public.notification_preferences enable row level security;
grant select, insert, update, delete on public.notification_preferences to authenticated;

drop policy if exists notification_preferences_select on public.notification_preferences;
create policy notification_preferences_select on public.notification_preferences
  for select to authenticated
  using (user_id = (select auth.uid()) or (select app.is_admin()));

drop policy if exists notification_preferences_insert on public.notification_preferences;
create policy notification_preferences_insert on public.notification_preferences
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists notification_preferences_update on public.notification_preferences;
create policy notification_preferences_update on public.notification_preferences
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists notification_preferences_delete on public.notification_preferences;
create policy notification_preferences_delete on public.notification_preferences
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- 3. Delivery log — restraint you can audit, and duplicate suppression
-- -----------------------------------------------------------------------------

create table if not exists public.push_deliveries (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  project_id uuid references public.projects (id) on delete cascade,
  category   text not null,
  /** 'stage_advanced:permits' — sent at most once per project per person. */
  dedupe_key text,
  title      text not null,
  body       text not null,
  url        text not null,
  devices    integer not null default 0,
  failures   integer not null default 0,
  sent_at    timestamptz not null default now()
);

create unique index if not exists push_deliveries_dedupe_key
  on public.push_deliveries (user_id, project_id, dedupe_key)
  where dedupe_key is not null;

create index if not exists push_deliveries_project_idx
  on public.push_deliveries (project_id, sent_at desc);

alter table public.push_deliveries enable row level security;
grant select on public.push_deliveries to authenticated;

drop policy if exists push_deliveries_select on public.push_deliveries;
create policy push_deliveries_select on public.push_deliveries
  for select to authenticated
  using (user_id = (select auth.uid())
         or (select app.current_user_role()) in ('admin', 'ops'));

-- -----------------------------------------------------------------------------
-- 4. What the PM has asked the customer for
-- -----------------------------------------------------------------------------
-- The portal's 'Anything needed from you' card and the app's upload prompt are
-- the same rows. Fulfilment is recorded, so the card empties itself when the
-- photo arrives rather than nagging a customer who has already done it.

create table if not exists public.customer_asks (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  kind         text not null default 'photo'
                 check (kind in ('photo', 'document', 'information')),
  /** Customer-facing wording: 'A photo of your electricity meter'. */
  label        text not null,
  detail       text,
  requested_by uuid references public.profiles (id),
  created_at   timestamptz not null default now(),
  fulfilled_at timestamptz,
  fulfilled_document_id uuid references public.documents (id) on delete set null,
  cancelled_at timestamptz
);

create index if not exists customer_asks_open_idx
  on public.customer_asks (project_id)
  where fulfilled_at is null and cancelled_at is null;

alter table public.customer_asks enable row level security;
grant select, insert, update, delete on public.customer_asks to authenticated;

drop policy if exists customer_asks_select on public.customer_asks;
create policy customer_asks_select on public.customer_asks
  for select to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops')
         or app.can_access_project(project_id));

drop policy if exists customer_asks_insert on public.customer_asks;
create policy customer_asks_insert on public.customer_asks
  for insert to authenticated
  with check ((select app.current_user_role()) in ('admin', 'ops'));

drop policy if exists customer_asks_update on public.customer_asks;
create policy customer_asks_update on public.customer_asks
  for update to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops'))
  with check ((select app.current_user_role()) in ('admin', 'ops'));

drop policy if exists customer_asks_delete on public.customer_asks;
create policy customer_asks_delete on public.customer_asks
  for delete to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops'));

drop trigger if exists audit_row on public.customer_asks;
create trigger audit_row after insert or update or delete on public.customer_asks
  for each row execute function app.tg_audit_row();

-- -----------------------------------------------------------------------------
-- 5. Account deletion requests (spec §7 — both stores require an in-app route)
-- -----------------------------------------------------------------------------
-- Wired to the anonymise flow in the customer-management module: the customer
-- asks from the app, an admin carries it out, and the permit/install/payment
-- record the business must retain survives.

alter table public.customer_requests drop constraint if exists customer_requests_kind_check;
alter table public.customer_requests add constraint customer_requests_kind_check
  check (kind in ('availability', 'question', 'contact_update', 'document', 'account_deletion'));

-- -----------------------------------------------------------------------------
-- 6. App settings: store URLs, forced-update floor, public legal URLs
-- -----------------------------------------------------------------------------

alter table public.app_settings
  /** Below this version the shell shows a blocking update prompt (spec §8). */
  add column if not exists min_app_version   text,
  add column if not exists latest_app_version text,
  add column if not exists app_store_url     text,
  add column if not exists play_store_url    text,
  add column if not exists privacy_policy_url text,
  add column if not exists terms_url         text,
  add column if not exists support_email     text,
  add column if not exists support_phone     text;

-- app_settings is admin/ops-only, and rightly so. The handful of fields a
-- customer's device legitimately needs — the legal URLs both stores require,
-- and the version floor the shell checks before showing anything — come
-- through this definer function instead of widening that policy.
create or replace function public.app_public_settings()
returns table (
  company_name       text,
  min_app_version    text,
  latest_app_version text,
  app_store_url      text,
  play_store_url     text,
  privacy_policy_url text,
  terms_url          text,
  support_email      text,
  support_phone      text
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.company_name, s.min_app_version, s.latest_app_version,
         s.app_store_url, s.play_store_url, s.privacy_policy_url, s.terms_url,
         s.support_email, s.support_phone
  from public.app_settings s
  where s.id;
$$;

grant execute on function public.app_public_settings() to authenticated, anon;

-- -----------------------------------------------------------------------------
-- 7. Recording a push send — one place, so the log cannot be bypassed
-- -----------------------------------------------------------------------------
-- Returns false when this exact notification has already gone out for this
-- project, which is how 'stage advanced to permits' stays one push even if the
-- PM moves the project back and forth while correcting a mistake.

create or replace function public.claim_push_delivery(
  p_user_id    uuid,
  p_project_id uuid,
  p_category   text,
  p_dedupe_key text,
  p_title      text,
  p_body       text,
  p_url        text,
  p_devices    integer default 0
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'only staff may send notifications' using errcode = '42501';
  end if;

  insert into public.push_deliveries
    (user_id, project_id, category, dedupe_key, title, body, url, devices)
  values (p_user_id, p_project_id, p_category, p_dedupe_key, p_title, p_body, p_url, p_devices)
  on conflict (user_id, project_id, dedupe_key) where dedupe_key is not null
  do nothing
  returning id into v_id;

  return v_id;  -- null when it was already sent
end;
$$;

revoke execute on function
  public.claim_push_delivery(uuid, uuid, text, text, text, text, text, integer) from public, anon;
grant execute on function
  public.claim_push_delivery(uuid, uuid, text, text, text, text, text, integer) to authenticated;

-- Who to notify about a project, with their per-category choice already
-- applied. Definer because sending happens on the server on behalf of the
-- customer, and push_subscriptions is deliberately self-only for everyone else.
create or replace function public.push_targets_for_project(
  p_project_id uuid,
  p_category   text
)
returns table (
  user_id  uuid,
  endpoint text,
  p256dh   text,
  auth     text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'only staff may send notifications' using errcode = '42501';
  end if;
  return query
    select s.user_id, s.endpoint, s.p256dh, s.auth
    from public.push_subscriptions s
    join public.clients c on c.user_id = s.user_id
    join public.profiles pr on pr.id = s.user_id
    left join public.notification_preferences np
      on np.user_id = s.user_id and np.category = p_category
    where s.disabled_at is null
      and pr.is_active
      and c.id = (select p.client_id from public.projects p where p.id = p_project_id)
      -- No row means not yet chosen, and the default is on.
      and coalesce(np.push, true);
end;
$$;

revoke execute on function public.push_targets_for_project(uuid, text) from public, anon;
grant execute on function public.push_targets_for_project(uuid, text) to authenticated;

-- A dead endpoint (the push service answered 404/410) is retired rather than
-- retried forever. Definer for the same reason as above.
create or replace function public.retire_push_endpoint(p_endpoint text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'only staff may retire endpoints' using errcode = '42501';
  end if;
  update public.push_subscriptions
  set disabled_at = now(), failure_count = failure_count + 1
  where endpoint = p_endpoint;
end;
$$;

revoke execute on function public.retire_push_endpoint(text) from public, anon;
grant execute on function public.retire_push_endpoint(text) to authenticated;

-- -----------------------------------------------------------------------------
-- 8. Fulfilling an ask from the customer's upload
-- -----------------------------------------------------------------------------
-- The customer taps 'Take photo' against a specific ask; the upload closes it.
-- Definer, because customer_asks is staff-writable only — the homeowner may
-- satisfy an ask, not invent or reword one.

create or replace function public.fulfil_customer_ask(
  p_ask_id      uuid,
  p_document_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
begin
  select a.project_id into v_project
  from public.customer_asks a
  where a.id = p_ask_id and a.fulfilled_at is null and a.cancelled_at is null;
  if v_project is null then
    return;  -- already done, cancelled, or gone: nothing to close
  end if;

  if app.current_user_role() = 'customer'
     and v_project not in (select p.id from public.projects p
                           where p.client_id in (select app.current_client_ids())) then
    raise exception 'not your project' using errcode = '42501';
  end if;

  update public.customer_asks
  set fulfilled_at = now(), fulfilled_document_id = p_document_id
  where id = p_ask_id;
end;
$$;

revoke execute on function public.fulfil_customer_ask(uuid, uuid) from public, anon;
grant execute on function public.fulfil_customer_ask(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 9. Who to call — the most-used control on the Home screen (spec §3.1)
-- -----------------------------------------------------------------------------
-- profiles is self-or-admin by RLS, quite rightly: a customer has no business
-- reading the staff directory. But that also meant the portal could never show
-- the assigned PM's name or number, so 'Call my project manager' rendered as
-- 'being assigned' for everyone. This returns exactly three fields, for one
-- project the caller can already see, and nothing else about that person.

create or replace function public.project_contact(p_project_id uuid)
returns table (
  pm_name  text,
  pm_phone text,
  pm_email text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not app.can_access_project(p_project_id) then
    raise exception 'not your project' using errcode = '42501';
  end if;
  return query
    select coalesce(pr.full_name, pr.email), pr.phone, pr.email
    from public.projects p
    join public.profiles pr on pr.id = p.assigned_pm
    where p.id = p_project_id and pr.is_active and pr.deleted_at is null;
end;
$$;

revoke execute on function public.project_contact(uuid) from public, anon;
grant execute on function public.project_contact(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 10. Customer-facing wording for the new surfaces
-- -----------------------------------------------------------------------------

insert into public.customer_phrases (domain, value, phrase) values
  ('push_title', 'stage_advanced', 'Your project has moved forward'),
  ('push_title', 'appointment',    'Your appointment is confirmed'),
  ('push_title', 'action_needed',  'Something is needed from you'),
  ('push_title', 'on_hold',        'Your project is temporarily paused'),
  ('push_title', 'power_on',       'Your system is switched on'),
  ('notify_label', 'stage_advanced', 'When my project moves to a new stage'),
  ('notify_label', 'appointment',    'Survey and installation dates, plus reminders'),
  ('notify_label', 'action_needed',  'When you need something from me'),
  ('notify_label', 'on_hold',        'If my project is paused'),
  ('notify_label', 'power_on',       'When my system is switched on')
on conflict (domain, value) do nothing;
