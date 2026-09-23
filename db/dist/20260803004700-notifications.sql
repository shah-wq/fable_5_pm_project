-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · newest module · step 15 of 15 · 20260803004700_notifications.sql
--
-- For a database that is already up to date apart from this module. Paste the
-- whole file into a SQL console (e.g. the Neon SQL Editor) and run it once.
-- Safe to run again: every statement skips work already done, so 'already
-- exists' errors cannot happen. NOTICE lines saying 'does not exist, skipping'
-- are normal.
--
-- Run these in order, each as its own execution:
--   1. 20260803003300-add-sales-role.sql
--   2. 20260803003400-crm-foundation.sql
--   3. 20260803003500-deals.sql
--   4. 20260803003600-contact-intake.sql
--   5. 20260803003700-contact-create.sql
--   6. 20260803003800-contact-stages.sql
--   7. 20260803003900-contract-signed-system.sql
--   8. 20260803004000-project-holds-contact.sql
--   9. 20260803004100-signing-creates-project.sql
--   10. 20260803004200-sales-see-deal-projects.sql
--   11. 20260803004300-stage-upload-fix.sql
--   12. 20260803004400-esignature.sql
--   13. 20260803004500-sales-see-dealer-names.sql
--   14. 20260803004600-stage-fields-solar.sql
--   15. 20260803004700-notifications.sql
-- Each break is where one script adds something the next one uses, which
-- PostgreSQL will not allow inside a single pasted transaction.
--
-- Behind by more than this module? Run every db/dist/catch-up-*.sql in order
-- instead — they cover everything from 001400 onwards.
-- ============================================================================

-- >>> 20260803004700_notifications.sql
-- =============================================================================
-- Notifications: one catalogue, every audience, every channel
-- =============================================================================
-- Until now each notification was its own code: five customer pushes, chat
-- emails, a rating email, a digest. Nothing told the PM a permit was about to
-- expire, nothing told the dealer their project moved, nothing told a
-- homeowner their permit was approved unless they opened the app, and there
-- was no list anywhere of what had been sent to whom.
--
-- This file makes notifications a thing the database records:
--
--   notification_rules   the catalogue. One row per kind of notification, with
--                        who it is for and which channels it uses (in-app,
--                        email, push). Admins switch each one on or off.
--   notifications        one row per notification per person: the in-app feed
--                        for customers, staff and dealers, and the delivery
--                        record for email and push.
--
-- Triggers on the business tables raise notifications when things happen — a
-- stage moves, a permit is approved, a payment is requested, a document is
-- signed. Time-based ones (ageing, expiring permits, stale leads) are raised
-- by the scheduled job. Delivery (rendering the words, sending email and push,
-- honouring quiet hours) is the application's work, in src/lib/notify.
--
-- Dedupe is built in: a kind + key is raised once per recipient, so a project
-- moved back and forth, or a job run twice, sends nothing twice.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The catalogue
-- -----------------------------------------------------------------------------
create table if not exists public.notification_rules (
  kind        text primary key,
  audience    text not null check (audience in ('customer', 'pm', 'admin', 'sales', 'dealer', 'user')),
  label       text not null,
  description text,
  enabled     boolean not null default true,
  in_app      boolean not null default true,
  email       boolean not null default true,
  push        boolean not null default false,
  updated_at  timestamptz not null default now()
);

drop trigger if exists set_updated_at on public.notification_rules;
create trigger set_updated_at before update on public.notification_rules
  for each row execute function app.tg_set_updated_at();

alter table public.notification_rules enable row level security;
revoke all on public.notification_rules from public, anon;
grant select, update on public.notification_rules to authenticated;
drop policy if exists notification_rules_select on public.notification_rules;
create policy notification_rules_select on public.notification_rules
  for select to authenticated using (true);
drop policy if exists notification_rules_update on public.notification_rules;
create policy notification_rules_update on public.notification_rules
  for update to authenticated using ((select app.is_admin())) with check ((select app.is_admin()));

-- Seeded with sensible defaults. Push defaults on only where the existing
-- customer pushes do not already cover the same moment.
insert into public.notification_rules (kind, audience, label, description, in_app, email, push) values
  -- homeowner
  ('project_created',        'customer', 'Project started',              'Their project has been created after signing.', true, true, false),
  ('stage_advanced',         'customer', 'Stage advanced',               'Their project moved to the next stage.', true, true, false),
  ('survey_scheduled',       'customer', 'Survey scheduled',             'The site survey has a date.', true, true, true),
  ('survey_completed',       'customer', 'Survey completed',             'The site survey is done.', true, false, false),
  ('design_ready',           'customer', 'Design ready',                 'Their system design has been received.', true, true, true),
  ('permit_submitted',       'customer', 'Permit submitted',             'The building permit application went in.', true, true, false),
  ('permit_approved',        'customer', 'Permit approved',              'The building permit was approved.', true, true, true),
  ('ica_approved',           'customer', 'Utility interconnection approved', 'The utility approved the interconnection agreement.', true, true, false),
  ('hoa_approved',           'customer', 'HOA approved',                 'The HOA approved the installation.', true, true, false),
  ('material_ordered',       'customer', 'Equipment ordered',            'Their equipment has been ordered.', true, true, false),
  ('material_delivered',     'customer', 'Equipment delivered',          'Their equipment has arrived.', true, true, false),
  ('install_scheduled',      'customer', 'Installation scheduled',       'The installation has a date (the app already pushes this).', true, true, false),
  ('install_completed',      'customer', 'Installation completed',       'The crew has finished the installation.', true, true, true),
  ('inspection_scheduled',   'customer', 'Inspection scheduled',         'The city inspection has a date.', true, true, true),
  ('inspection_passed',      'customer', 'Inspection passed',            'The inspection was passed.', true, true, true),
  ('inspection_failed',      'customer', 'Inspection needs corrections', 'The inspection found items to fix; we are on it.', true, true, false),
  ('pto_applied',            'customer', 'Permission to operate requested', 'The utility has been asked for permission to operate.', true, true, false),
  ('pto_received',           'customer', 'Permission to operate granted', 'The utility granted permission to operate.', true, true, true),
  ('system_energized',       'customer', 'System switched on',           'Their system is producing (the app already pushes this).', true, true, false),
  ('project_complete',       'customer', 'Project complete',             'Everything is finished.', true, true, false),
  ('project_on_hold',        'customer', 'Project paused',               'Their project was put on hold (the app already pushes this).', true, true, false),
  ('project_resumed',        'customer', 'Project resumed',              'Their project is moving again.', true, true, true),
  ('payment_requested',      'customer', 'Payment requested',            'A payment milestone is due.', true, true, true),
  ('payment_received',       'customer', 'Payment received',             'A payment was received — a receipt.', true, true, false),
  ('action_needed',          'customer', 'Something needed from them',   'The PM asked for a photo, a document or information (the app already pushes this).', true, true, false),
  ('contract_signed',        'customer', 'Contract signed',              'Confirmation that their contract was signed.', true, true, false),
  ('change_order_confirmed', 'customer', 'Change order confirmed',       'A change order was signed or approved.', true, true, false),
  ('new_message',            'customer', 'New message',                  'Their project manager wrote (chat already pushes and emails this).', true, false, false),
  -- project manager
  ('project_assigned',       'pm', 'Project assigned to you',     'A project was assigned to this PM.', true, true, true),
  ('customer_message',       'pm', 'Customer wrote',              'A customer message arrived (the digest emails these).', true, false, true),
  ('customer_request',       'pm', 'Customer request',            'A homeowner asked for dates, a contact change or sent a document.', true, true, true),
  ('customer_uploaded',      'pm', 'Customer uploaded a file',    'A homeowner uploaded a photo or document.', true, false, false),
  ('stage_ageing',           'pm', 'Project ageing',              'A project has been in its stage longer than the threshold.', true, true, false),
  ('permit_expiring',        'pm', 'Permit expiring',             'A permit expires soon and the project is not installed.', true, true, true),
  ('permit_revision',        'pm', 'Permit correction requested', 'The AHJ or utility sent a permit back.', true, true, true),
  ('inspection_failed_pm',   'pm', 'Inspection failed',           'An inspection failed; correction items are on the form.', true, true, true),
  ('install_readiness',      'pm', 'Install tomorrow not ready',  'Tomorrow''s install is missing a permit, materials or a confirmation.', true, true, true),
  ('esign_completed',        'pm', 'Document signed',             'A contract or change order was signed.', true, true, false),
  ('esign_declined',         'pm', 'Document declined',           'The homeowner declined to sign.', true, true, true),
  ('esign_needs_attention',  'pm', 'Signed but not applied',      'A signed document could not be applied; press Finish.', true, true, true),
  ('change_order_approved',  'pm', 'Change order approved',       'A change order was signed or approved and the contract value updated.', true, false, false),
  ('low_rating',             'pm', 'Low customer rating',         'A homeowner rated a stage 1 or 2 (the follow-up email already goes out).', true, false, true),
  ('ai_exception',           'pm', 'AI needs a decision',         'The document reader was unsure about something.', true, false, false),
  ('daily_briefing',         'pm', 'Morning briefing',            'The day''s summary from Ask SolarFlow.', true, true, false),
  -- admin
  ('admin_project_created',  'admin', 'New project',              'A contract was signed and a project created.', true, false, false),
  ('deal_won',               'admin', 'Deal won',                 'A deal was marked won.', true, false, false),
  ('esign_failed',           'admin', 'E-signature failed',       'PandaDoc refused a document; the reason is on the record.', true, true, false),
  -- sales
  ('lead_assigned',          'sales', 'Lead assigned to you',     'A contact was assigned to this rep.', true, true, true),
  ('contact_stale',          'sales', 'Contact going quiet',      'A quoted or booked contact has not been contacted for a while.', true, true, false),
  ('deal_stale',             'sales', 'Deal going quiet',         'An open deal has not moved for a while.', true, true, false),
  -- dealer
  ('dealer_project_created', 'dealer', 'Your project started',   'A project was created for one of the dealer''s customers.', true, true, false),
  ('dealer_stage_advanced',  'dealer', 'Your project moved',     'One of the dealer''s projects changed stage.', true, false, false),
  ('dealer_project_complete','dealer', 'Your project completed', 'One of the dealer''s projects is complete.', true, true, false),
  ('dealer_project_on_hold', 'dealer', 'Your project paused',    'One of the dealer''s projects is on hold.', true, true, false),
  ('commission_payable',     'dealer', 'Commission payable',     'A commission became payable.', true, true, false)
on conflict (kind) do nothing;

-- -----------------------------------------------------------------------------
-- 2. The feed and delivery record
-- -----------------------------------------------------------------------------
create table if not exists public.notifications (
  id              bigint generated always as identity primary key,
  kind            text not null references public.notification_rules (kind) on delete cascade,
  -- Who: a login, or (a homeowner without one) an email address.
  user_id         uuid references public.profiles (id) on delete cascade,
  recipient_email text,
  project_id      uuid references public.projects (id) on delete cascade,
  deal_id         uuid references public.deals (id) on delete set null,
  client_id       uuid references public.clients (id) on delete set null,
  -- What happened, for the words: stage, date, amount, reason…
  payload         jsonb not null default '{}'::jsonb,
  dedupe_key      text,
  deliver_after   timestamptz not null default now(),
  claimed_at      timestamptz,
  delivered_at    timestamptz,
  emailed_at      timestamptz,
  pushed_at       timestamptz,
  delivery_error  text,
  read_at         timestamptz,
  created_at      timestamptz not null default now(),
  constraint notifications_recipient check (user_id is not null or recipient_email is not null)
);

create unique index if not exists notifications_dedupe_idx
  on public.notifications (kind, coalesce(user_id::text, recipient_email), dedupe_key)
  where dedupe_key is not null;
create index if not exists notifications_feed_idx
  on public.notifications (user_id, created_at desc) where user_id is not null;
create index if not exists notifications_unread_idx
  on public.notifications (user_id) where read_at is null and user_id is not null;
create index if not exists notifications_undelivered_idx
  on public.notifications (deliver_after) where delivered_at is null;
create index if not exists notifications_project_idx on public.notifications (project_id);

alter table public.notifications enable row level security;
revoke all on public.notifications from public, anon;
grant select on public.notifications to authenticated;
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated
  using (user_id = (select auth.uid()) or (select app.is_admin()));

alter table public.app_settings
  add column if not exists contact_stale_days         integer not null default 7,
  add column if not exists deal_stale_days            integer not null default 14,
  add column if not exists permit_expiry_warning_days integer not null default 14,
  add column if not exists briefing_hour              integer not null default 7;

-- -----------------------------------------------------------------------------
-- 3. Raising one
-- -----------------------------------------------------------------------------
/**
 * Raise a notification for one recipient. Silent when the kind is unknown or
 * switched off, when there is nobody to send it to, or when the same kind and
 * key was already raised for them. Returns the id, or null when nothing was
 * raised. Internal: the triggers and the helpers below call it.
 */
create or replace function app.notify(
  p_kind       text,
  p_user       uuid,
  p_email      text,
  p_project    uuid,
  p_deal       uuid,
  p_client     uuid,
  p_payload    jsonb,
  p_dedupe     text,
  p_after      timestamptz default now()
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if p_user is null and nullif(btrim(coalesce(p_email, '')), '') is null then
    return null;
  end if;
  if not exists (select 1 from public.notification_rules r where r.kind = p_kind and r.enabled) then
    return null;
  end if;
  if p_user is not null and not exists (
       select 1 from public.profiles pr where pr.id = p_user and pr.is_active and pr.deleted_at is null) then
    return null;
  end if;
  insert into public.notifications
    (kind, user_id, recipient_email, project_id, deal_id, client_id, payload, dedupe_key, deliver_after)
  values
    (p_kind, p_user, case when p_user is null then lower(btrim(p_email)) end,
     p_project, p_deal, p_client, coalesce(p_payload, '{}'::jsonb), p_dedupe, coalesce(p_after, now()))
  on conflict do nothing
  returning id into v_id;
  return v_id;
end;
$$;

/** The homeowner of a project: their login when they have one, else their email. */
create or replace function app.notify_customer(p_project uuid, p_kind text, p_payload jsonb, p_dedupe text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client public.clients%rowtype;
begin
  select c.* into v_client
    from public.projects p join public.clients c on c.id = p.client_id
   where p.id = p_project;
  if not found then return; end if;
  if coalesce(v_client.email_opt_out, false) and v_client.user_id is null then return; end if;
  -- Keys are scoped to the project: "permit_approved" once per project, not once per person.
  perform app.notify(p_kind, v_client.user_id, v_client.email, p_project, null, v_client.id,
                     p_payload, p_project::text || ':' || p_dedupe);
end;
$$;

/** The project's PM; with no PM assigned, every active admin. */
create or replace function app.notify_project_staff(p_project uuid, p_kind text, p_payload jsonb, p_dedupe text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pm uuid;
  v_admin uuid;
begin
  select p.assigned_pm into v_pm from public.projects p where p.id = p_project;
  if v_pm is not null then
    perform app.notify(p_kind, v_pm, null, p_project, null, null, p_payload, p_project::text || ':' || p_dedupe);
    return;
  end if;
  for v_admin in select pr.id from public.profiles pr
                  where pr.role = 'admin' and pr.is_active and pr.deleted_at is null loop
    perform app.notify(p_kind, v_admin, null, p_project, null, null, p_payload, p_project::text || ':' || p_dedupe);
  end loop;
end;
$$;

create or replace function app.notify_admins(p_kind text, p_project uuid, p_deal uuid, p_client uuid,
                                             p_payload jsonb, p_dedupe text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid;
begin
  for v_admin in select pr.id from public.profiles pr
                  where pr.role = 'admin' and pr.is_active and pr.deleted_at is null loop
    perform app.notify(p_kind, v_admin, null, p_project, p_deal, p_client, p_payload,
                       coalesce(p_project::text, p_deal::text, p_client::text, '') || ':' || p_dedupe);
  end loop;
end;
$$;

/** Every login at the project's dealer. */
create or replace function app.notify_dealer(p_project uuid, p_kind text, p_payload jsonb, p_dedupe text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  for v_user in select du.user_id from public.dealer_users du
                 join public.projects p on p.dealer_id = du.dealer_id
                where p.id = p_project loop
    perform app.notify(p_kind, v_user, null, p_project, null, null, p_payload, p_project::text || ':' || p_dedupe);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. What raises them
-- -----------------------------------------------------------------------------
-- Projects: created, moved, held, resumed, completed, cancelled, reassigned.
create or replace function app.tg_notify_project()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
begin
  if tg_op = 'INSERT' then
    perform app.notify_customer(new.id, 'project_created', jsonb_build_object('stage', new.stage), 'created');
    perform app.notify_dealer(new.id, 'dealer_project_created', '{}'::jsonb, 'created');
    perform app.notify_admins('admin_project_created', new.id, new.deal_id, new.client_id, '{}'::jsonb, 'created');
    if new.assigned_pm is not null then
      perform app.notify('project_assigned', new.assigned_pm, null, new.id, null, null, '{}'::jsonb, new.id::text || ':assigned');
    end if;
    return new;
  end if;

  if new.assigned_pm is distinct from old.assigned_pm and new.assigned_pm is not null then
    perform app.notify('project_assigned', new.assigned_pm, null, new.id, null, null, '{}'::jsonb,
                       new.id::text || ':assigned:' || to_char(now(), 'YYYYMMDDHH24MI'));
  end if;

  if new.stage is distinct from old.stage and new.status = 'active' and new.stage <> 'complete' then
    perform app.notify_customer(new.id, 'stage_advanced', jsonb_build_object('stage', new.stage, 'from', old.stage),
                                'stage:' || new.stage);
    perform app.notify_dealer(new.id, 'dealer_stage_advanced', jsonb_build_object('stage', new.stage), 'stage:' || new.stage);
  end if;

  if new.status is distinct from old.status then
    if new.status = 'on_hold' then
      select h.reason into v_reason from public.project_holds h
       where h.project_id = new.id and h.resume_date is null order by h.created_at desc limit 1;
      perform app.notify_customer(new.id, 'project_on_hold', jsonb_build_object('reason', v_reason),
                                  'hold:' || to_char(now(), 'YYYYMMDDHH24MI'));
      perform app.notify_dealer(new.id, 'dealer_project_on_hold', jsonb_build_object('reason', v_reason),
                                'hold:' || to_char(now(), 'YYYYMMDDHH24MI'));
    elsif new.status = 'active' and old.status = 'on_hold' then
      perform app.notify_customer(new.id, 'project_resumed', jsonb_build_object('stage', new.stage),
                                  'resumed:' || to_char(now(), 'YYYYMMDDHH24MI'));
    elsif new.status = 'complete' then
      perform app.notify_customer(new.id, 'project_complete', '{}'::jsonb, 'complete');
      perform app.notify_dealer(new.id, 'dealer_project_complete', '{}'::jsonb, 'complete');
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists notify_project on public.projects;
create trigger notify_project after insert or update on public.projects
  for each row execute function app.tg_notify_project();

-- A payment milestone changing hands, shared by the four stage tables that hold one.
create or replace function app.notify_payment(p_project uuid, p_label text, p_old text, p_new text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_new is distinct from p_old and p_new = 'requested' then
    perform app.notify_customer(p_project, 'payment_requested', jsonb_build_object('milestone', p_label),
                                'payment_requested:' || p_label);
  elsif p_new is distinct from p_old and p_new = 'received' then
    perform app.notify_customer(p_project, 'payment_received', jsonb_build_object('milestone', p_label),
                                'payment_received:' || p_label);
  end if;
end;
$$;

create or replace function app.tg_notify_stage1()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.survey_status is distinct from old.survey_status and new.survey_status = 'scheduled' then
    perform app.notify_customer(new.project_id, 'survey_scheduled',
      jsonb_build_object('date', new.survey_scheduled_date), 'survey_scheduled:' || coalesce(new.survey_scheduled_date::text, 'tbd'));
  elsif new.survey_status is distinct from old.survey_status and new.survey_status = 'completed' then
    perform app.notify_customer(new.project_id, 'survey_completed', '{}'::jsonb, 'survey_completed');
  end if;
  perform app.notify_payment(new.project_id, 'Down payment', old.down_payment_status, new.down_payment_status);
  perform app.notify_payment(new.project_id, 'Milestone 1', old.cash_m1_status, new.cash_m1_status);
  return new;
end;
$$;
drop trigger if exists notify_stage on public.stage1_survey;
create trigger notify_stage after insert or update on public.stage1_survey
  for each row execute function app.tg_notify_stage1();

create or replace function app.tg_notify_stage2()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.design_status is distinct from old.design_status and new.design_status = 'received' then
    perform app.notify_customer(new.project_id, 'design_ready',
      jsonb_build_object('size_kw', new.final_system_size_kw, 'modules', new.final_module_count), 'design_ready');
  end if;
  return new;
end;
$$;
drop trigger if exists notify_stage on public.stage2_design;
create trigger notify_stage after insert or update on public.stage2_design
  for each row execute function app.tg_notify_stage2();

create or replace function app.tg_notify_stage3()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.permit_status is distinct from old.permit_status then
    if new.permit_status = 'applied' then
      perform app.notify_customer(new.project_id, 'permit_submitted', jsonb_build_object('date', new.permit_applied_date), 'permit_submitted');
    elsif new.permit_status = 'approved' then
      perform app.notify_customer(new.project_id, 'permit_approved',
        jsonb_build_object('permit_number', new.permit_number, 'date', new.permit_received_date), 'permit_approved');
    elsif new.permit_status in ('revision_requested', 'rejected') then
      perform app.notify_project_staff(new.project_id, 'permit_revision',
        jsonb_build_object('track', 'Building permit', 'status', new.permit_status, 'notes', new.permit_revision_notes),
        'permit_revision:' || new.permit_status || ':' || to_char(now(), 'YYYYMMDD'));
    end if;
  end if;
  if new.ica_status is distinct from old.ica_status then
    if new.ica_status = 'approved' then
      perform app.notify_customer(new.project_id, 'ica_approved', jsonb_build_object('date', new.ica_received_date), 'ica_approved');
    elsif new.ica_status in ('revision_requested', 'rejected') then
      perform app.notify_project_staff(new.project_id, 'permit_revision',
        jsonb_build_object('track', 'Interconnection', 'status', new.ica_status, 'notes', new.ica_revision_notes),
        'ica_revision:' || new.ica_status || ':' || to_char(now(), 'YYYYMMDD'));
    end if;
  end if;
  if new.hoa_status is distinct from old.hoa_status and new.hoa_status = 'approved' then
    perform app.notify_customer(new.project_id, 'hoa_approved', jsonb_build_object('date', new.hoa_received_date), 'hoa_approved');
  end if;
  perform app.notify_payment(new.project_id, 'Milestone 2', old.cash_m2_status, new.cash_m2_status);
  return new;
end;
$$;
drop trigger if exists notify_stage on public.stage3_permit;
create trigger notify_stage after insert or update on public.stage3_permit
  for each row execute function app.tg_notify_stage3();

create or replace function app.tg_notify_stage4()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.material_status is distinct from old.material_status then
    if new.material_status = 'ordered' then
      perform app.notify_customer(new.project_id, 'material_ordered',
        jsonb_build_object('expected', new.expected_delivery_date), 'material_ordered');
    elsif new.material_status = 'delivered' then
      perform app.notify_customer(new.project_id, 'material_delivered', jsonb_build_object('date', new.material_delivered_date), 'material_delivered');
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists notify_stage on public.stage4_procurement;
create trigger notify_stage after insert or update on public.stage4_procurement
  for each row execute function app.tg_notify_stage4();

create or replace function app.tg_notify_stage5()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.install_scheduled_date is distinct from old.install_scheduled_date and new.install_scheduled_date is not null then
    perform app.notify_customer(new.project_id, 'install_scheduled',
      jsonb_build_object('date', new.install_scheduled_date), 'install_scheduled:' || new.install_scheduled_date::text);
  end if;
  if new.install_status is distinct from old.install_status and new.install_status = 'completed' then
    perform app.notify_customer(new.project_id, 'install_completed', jsonb_build_object('date', new.install_completed_date), 'install_completed');
  end if;
  perform app.notify_payment(new.project_id, 'Milestone 3', old.cash_m3_status, new.cash_m3_status);
  return new;
end;
$$;
drop trigger if exists notify_stage on public.stage5_install;
create trigger notify_stage after insert or update on public.stage5_install
  for each row execute function app.tg_notify_stage5();

create or replace function app.tg_notify_stage6()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.inspection_status is distinct from old.inspection_status then
    if new.inspection_status in ('scheduled', 'reinspection_scheduled') then
      perform app.notify_customer(new.project_id, 'inspection_scheduled',
        jsonb_build_object('date', coalesce(new.reinspection_date, new.inspection_scheduled_date), 'again', new.inspection_status = 'reinspection_scheduled'),
        'inspection_scheduled:' || coalesce(coalesce(new.reinspection_date, new.inspection_scheduled_date)::text, 'tbd'));
    elsif new.inspection_status = 'passed' then
      perform app.notify_customer(new.project_id, 'inspection_passed', jsonb_build_object('date', new.inspection_completed_date), 'inspection_passed');
    elsif new.inspection_status = 'failed' then
      perform app.notify_customer(new.project_id, 'inspection_failed', '{}'::jsonb, 'inspection_failed:' || to_char(now(), 'YYYYMMDD'));
      perform app.notify_project_staff(new.project_id, 'inspection_failed_pm',
        jsonb_build_object('notes', new.inspection_failed_notes), 'inspection_failed:' || to_char(now(), 'YYYYMMDD'));
    end if;
  end if;
  if new.pto_status is distinct from old.pto_status then
    if new.pto_status = 'applied' then
      perform app.notify_customer(new.project_id, 'pto_applied', jsonb_build_object('date', new.pto_applied_date), 'pto_applied');
    elsif new.pto_status = 'received' then
      perform app.notify_customer(new.project_id, 'pto_received', jsonb_build_object('date', new.pto_received_date), 'pto_received');
    end if;
  end if;
  if new.energization_status is distinct from old.energization_status and new.energization_status = 'energized' then
    perform app.notify_customer(new.project_id, 'system_energized', jsonb_build_object('date', new.energization_date), 'energized');
  end if;
  return new;
end;
$$;
drop trigger if exists notify_stage on public.stage6_inspection;
create trigger notify_stage after insert or update on public.stage6_inspection
  for each row execute function app.tg_notify_stage6();

-- The homeowner asks or sends something → the PM.
create or replace function app.tg_notify_customer_request()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform app.notify_project_staff(new.project_id, 'customer_request',
    jsonb_build_object('kind', new.kind, 'message', left(coalesce(new.message, ''), 200)), 'request:' || new.id);
  return new;
end;
$$;
drop trigger if exists notify_request on public.customer_requests;
create trigger notify_request after insert on public.customer_requests
  for each row execute function app.tg_notify_customer_request();

create or replace function app.tg_notify_customer_ask()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform app.notify_customer(new.project_id, 'action_needed',
    jsonb_build_object('label', new.label, 'detail', new.detail), 'ask:' || new.id);
  return new;
end;
$$;
drop trigger if exists notify_ask on public.customer_asks;
create trigger notify_ask after insert on public.customer_asks
  for each row execute function app.tg_notify_customer_ask();

-- A homeowner's upload → the PM (staff uploads notify nobody).
create or replace function app.tg_notify_document()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.project_id is not null and new.uploaded_by is not null and exists (
       select 1 from public.projects p join public.clients c on c.id = p.client_id
        where p.id = new.project_id and c.user_id = new.uploaded_by) then
    perform app.notify_project_staff(new.project_id, 'customer_uploaded',
      jsonb_build_object('title', new.title, 'category', new.category), 'upload:' || new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists notify_document on public.documents;
create trigger notify_document after insert on public.documents
  for each row execute function app.tg_notify_document();

-- Chat: a line in each side's feed (push and email are the chat module's).
create or replace function app.tg_notify_message()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.is_internal then return new; end if;
  if new.sender_role = 'customer' then
    perform app.notify_project_staff(new.project_id, 'customer_message',
      jsonb_build_object('preview', left(new.body, 160)), 'message:' || new.id);
  elsif new.sender_role = 'staff' then
    perform app.notify_customer(new.project_id, 'new_message',
      jsonb_build_object('preview', left(new.body, 160)), 'message:' || new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists notify_message on public.project_messages;
create trigger notify_message after insert on public.project_messages
  for each row execute function app.tg_notify_message();

-- E-signature outcomes → the sender (and the homeowner, when signed).
create or replace function app.tg_notify_esign()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_payload jsonb := jsonb_build_object('purpose', new.purpose, 'signer', new.signer_email);
begin
  if new.status is distinct from old.status then
    if new.status = 'completed' then
      perform app.notify('esign_completed', new.created_by, null, new.project_id, new.deal_id, new.client_id, v_payload, 'esign:' || new.id);
      if new.purpose = 'contract' then
        perform app.notify('contract_signed', (select c.user_id from public.clients c where c.id = new.client_id),
                           (select c.email from public.clients c where c.id = new.client_id),
                           new.project_id, new.deal_id, new.client_id, v_payload, 'contract_signed:' || new.id);
      end if;
    elsif new.status = 'declined' then
      perform app.notify('esign_declined', new.created_by, null, new.project_id, new.deal_id, new.client_id, v_payload, 'esign:' || new.id);
    elsif new.status = 'failed' then
      perform app.notify_admins('esign_failed', new.project_id, new.deal_id, new.client_id,
        v_payload || jsonb_build_object('error', new.last_error), 'esign:' || new.id);
    end if;
  end if;
  if new.status = 'completed' and new.applied_at is null and new.last_error is not null
     and (old.last_error is distinct from new.last_error) then
    perform app.notify('esign_needs_attention', new.created_by, null, new.project_id, new.deal_id, new.client_id,
                       v_payload || jsonb_build_object('error', new.last_error), 'esign_attention:' || new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists notify_esign on public.esign_envelopes;
create trigger notify_esign after update on public.esign_envelopes
  for each row execute function app.tg_notify_esign();

-- Change orders approved → the customer's confirmation and the PM's note.
create or replace function app.tg_notify_change_order()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status and new.status = 'approved' then
    perform app.notify_customer(new.project_id, 'change_order_confirmed',
      jsonb_build_object('number', new.number, 'amount', new.amount_delta, 'reason', new.reason), 'co:' || new.id);
    perform app.notify_project_staff(new.project_id, 'change_order_approved',
      jsonb_build_object('number', new.number, 'amount', new.amount_delta, 'reason', new.reason), 'co:' || new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists notify_change_order on public.change_orders;
create trigger notify_change_order after insert or update on public.change_orders
  for each row execute function app.tg_notify_change_order();

-- A contact assigned to a rep.
create or replace function app.tg_notify_contact()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.owner_id is not null and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id)
     and new.owner_id is distinct from (select auth.uid()) then
    perform app.notify('lead_assigned', new.owner_id, null, null, null, new.id,
      jsonb_build_object('name', concat_ws(' ', new.first_name, new.last_name), 'stage', new.contact_stage),
      'lead:' || new.id || ':' || new.owner_id);
  end if;
  return new;
end;
$$;
drop trigger if exists notify_contact on public.clients;
create trigger notify_contact after insert or update on public.clients
  for each row execute function app.tg_notify_contact();

-- A deal won → admins.
create or replace function app.tg_notify_deal()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.stage is distinct from old.stage and new.stage = 'won' then
    perform app.notify_admins('deal_won', new.project_id, new.id, new.client_id,
      jsonb_build_object('customer', concat_ws(' ', new.customer_first, new.customer_last), 'value', new.contract_value),
      'won:' || new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists notify_deal on public.deals;
create trigger notify_deal after update on public.deals
  for each row execute function app.tg_notify_deal();

-- A low rating → the PM's feed (the follow-up email is the feedback module's).
create or replace function app.tg_notify_rating()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.score is not null and new.score <= 2 and (old.score is null or old.score > 2) then
    perform app.notify_project_staff(new.project_id, 'low_rating',
      jsonb_build_object('stage', new.stage, 'score', new.score, 'comment', left(coalesce(new.comment, ''), 200)),
      'rating:' || new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists notify_rating on public.stage_feedback;
create trigger notify_rating after insert or update on public.stage_feedback
  for each row execute function app.tg_notify_rating();

-- Commission payable → the dealer.
create or replace function app.tg_notify_commission()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status and new.status = 'payable' then
    perform app.notify_dealer(new.project_id, 'commission_payable',
      jsonb_build_object('amount', new.base_amount + new.adjustment, 'payable_date', new.payable_date), 'commission:' || new.project_id);
  end if;
  return new;
end;
$$;
drop trigger if exists notify_commission on public.commissions;
create trigger notify_commission after insert or update on public.commissions
  for each row execute function app.tg_notify_commission();

-- The AI's doubts (004800 fills this table) → the PM.
create or replace function app.tg_notify_exception()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.project_id is not null and new.raised_by = 'ai' then
    perform app.notify_project_staff(new.project_id, 'ai_exception',
      jsonb_build_object('summary', new.summary), 'exception:' || new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists notify_exception on public.exceptions;
create trigger notify_exception after insert on public.exceptions
  for each row execute function app.tg_notify_exception();

-- -----------------------------------------------------------------------------
-- 5. Reading, and delivering
-- -----------------------------------------------------------------------------
create or replace function public.unread_notification_count()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int from public.notifications n
   where n.user_id = (select auth.uid()) and n.read_at is null;
$$;

/** Mark some (or, with null, all) of the caller's notifications read. */
create or replace function public.mark_notifications_read(p_ids bigint[] default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  update public.notifications n set read_at = now()
   where n.user_id = (select auth.uid()) and n.read_at is null
     and (p_ids is null or n.id = any(p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

/**
 * Raise a notification from the application — the time-based rules and the
 * AI jobs. Admin and ops only: a sales rep cannot make the system nag a PM.
 */
create or replace function public.raise_notification(
  p_kind text, p_user uuid, p_project uuid, p_payload jsonb, p_dedupe text, p_after timestamptz default now())
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'only staff may raise notifications' using errcode = '42501';
  end if;
  return app.notify(p_kind, p_user, null, p_project, null, null, p_payload, p_dedupe, p_after);
end;
$$;

/**
 * The next notifications to deliver, claimed so two overlapping runs cannot
 * send the same one twice. Joined with the rule's channels and the recipient's
 * address. A homeowner's are held through quiet hours.
 */
create or replace function public.claim_notifications(p_limit integer default 200)
returns table (
  id bigint, kind text, audience text, in_app boolean, email boolean, push boolean,
  user_id uuid, recipient_email text, recipient_name text, email_opt_out boolean,
  project_id uuid, deal_id uuid, client_id uuid, payload jsonb, created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quiet timestamptz;
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'only staff may deliver notifications' using errcode = '42501';
  end if;
  -- Quiet hours (the chat module's rule): a homeowner's notifications wait for
  -- the morning. Staff and dealers are not held.
  v_quiet := public.chat_quiet_until();
  if v_quiet is not null then
    update public.notifications n set deliver_after = greatest(n.deliver_after, v_quiet)
      from public.notification_rules r
     where r.kind = n.kind and r.audience = 'customer'
       and n.delivered_at is null and n.claimed_at is null and n.deliver_after < v_quiet;
  end if;

  return query
    with picked as (
      select n.id from public.notifications n
       where n.delivered_at is null
         and n.deliver_after <= now()
         and (n.claimed_at is null or n.claimed_at < now() - interval '10 minutes')
       order by n.created_at
       limit p_limit
       for update skip locked
    ), claimed as (
      update public.notifications n set claimed_at = now()
        from picked where n.id = picked.id
      returning n.*
    )
    select c.id, c.kind, r.audience, r.in_app, r.email, r.push,
           c.user_id,
           coalesce(c.recipient_email, cl.email, pr.email) as recipient_email,
           coalesce(nullif(concat_ws(' ', cl.first_name, cl.last_name), ''), pr.full_name) as recipient_name,
           coalesce(cl.email_opt_out, false) as email_opt_out,
           c.project_id, c.deal_id, c.client_id, c.payload, c.created_at
      from claimed c
      join public.notification_rules r on r.kind = c.kind
      left join public.profiles pr on pr.id = c.user_id
      left join public.clients cl on (r.audience = 'customer' and (cl.user_id = c.user_id or cl.id = c.client_id))
     order by c.created_at;
end;
$$;

create or replace function public.notification_delivered(
  p_id bigint, p_emailed boolean, p_pushed boolean, p_error text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'only staff may deliver notifications' using errcode = '42501';
  end if;
  update public.notifications set
    delivered_at   = now(),
    emailed_at     = case when p_emailed then now() end,
    pushed_at      = case when p_pushed then now() end,
    delivery_error = p_error
  where id = p_id;
end;
$$;

/** A person's devices, for a staff or dealer push. Staff-only caller. */
create or replace function public.push_targets_for_user(p_user uuid)
returns table (endpoint text, p256dh text, auth text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.endpoint, s.p256dh, s.auth
    from public.push_subscriptions s
   where s.user_id = p_user and s.disabled_at is null
     and app.current_user_role() in ('admin', 'ops');
$$;

revoke execute on function app.notify(text, uuid, text, uuid, uuid, uuid, jsonb, text, timestamptz) from public, anon, authenticated;
revoke execute on function app.notify_customer(uuid, text, jsonb, text) from public, anon, authenticated;
revoke execute on function app.notify_project_staff(uuid, text, jsonb, text) from public, anon, authenticated;
revoke execute on function app.notify_admins(text, uuid, uuid, uuid, jsonb, text) from public, anon, authenticated;
revoke execute on function app.notify_dealer(uuid, text, jsonb, text) from public, anon, authenticated;
revoke execute on function app.notify_payment(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.unread_notification_count() from public, anon;
revoke execute on function public.mark_notifications_read(bigint[]) from public, anon;
revoke execute on function public.raise_notification(text, uuid, uuid, jsonb, text, timestamptz) from public, anon;
revoke execute on function public.claim_notifications(integer) from public, anon;
revoke execute on function public.notification_delivered(bigint, boolean, boolean, text) from public, anon;
revoke execute on function public.push_targets_for_user(uuid) from public, anon;
grant execute on function public.unread_notification_count() to authenticated;
grant execute on function public.mark_notifications_read(bigint[]) to authenticated;
grant execute on function public.raise_notification(text, uuid, uuid, jsonb, text, timestamptz) to authenticated;
grant execute on function public.claim_notifications(integer) to authenticated;
grant execute on function public.notification_delivered(bigint, boolean, boolean, text) to authenticated;
grant execute on function public.push_targets_for_user(uuid) to authenticated;


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
  ('20260803001100_file_storage.sql'),
  ('20260803001200_manual_version.sql'),
  ('20260803001300_admin_panel.sql'),
  ('20260803001400_stage_fields.sql'),
  ('20260803001500_complete_hold_cancel.sql'),
  ('20260803001600_complete_stage_backfill.sql'),
  ('20260803001700_project_details.sql'),
  ('20260803001800_equipment_quantities.sql'),
  ('20260803001900_dealer_portal.sql'),
  ('20260803002000_dealer_companies.sql'),
  ('20260803002100_restore_project_defaults.sql'),
  ('20260803002200_report_builder.sql'),
  ('20260803002300_customer_portal.sql'),
  ('20260803002400_customer_management.sql'),
  ('20260803002500_mobile_app.sql'),
  ('20260803002600_customer_passwords.sql'),
  ('20260803002700_invite_customers_with_tokens.sql'),
  ('20260803002800_dashboard.sql'),
  ('20260803002900_project_chat.sql'),
  ('20260803003000_sign_in.sql'),
  ('20260803003100_typical_durations.sql'),
  ('20260803003200_stage_feedback.sql'),
  ('20260803003300_add_sales_role.sql'),
  ('20260803003400_crm_foundation.sql'),
  ('20260803003500_deals.sql'),
  ('20260803003600_contact_intake.sql'),
  ('20260803003700_contact_create.sql'),
  ('20260803003800_contact_stages.sql'),
  ('20260803003900_contract_signed_system.sql'),
  ('20260803004000_project_holds_contact.sql'),
  ('20260803004100_signing_creates_project.sql'),
  ('20260803004200_sales_see_deal_projects.sql'),
  ('20260803004300_stage_upload_fix.sql'),
  ('20260803004400_esignature.sql'),
  ('20260803004500_sales_see_dealer_names.sql'),
  ('20260803004600_stage_fields_solar.sql'),
  ('20260803004700_notifications.sql')
on conflict (name) do nothing;
