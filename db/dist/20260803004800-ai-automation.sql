-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · newest module · step 16 of 16 · 20260803004800_ai_automation.sql
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
--   16. 20260803004800-ai-automation.sql
-- Each break is where one script adds something the next one uses, which
-- PostgreSQL will not allow inside a single pasted transaction.
--
-- Behind by more than this module? Run every db/dist/catch-up-*.sql in order
-- instead — they cover everything from 001400 onwards.
-- ============================================================================

-- >>> 20260803004800_ai_automation.sql
-- =============================================================================
-- AI automation: a job queue, document suggestions and reply drafts
-- =============================================================================
-- Ask SolarFlow (004400-era) answers questions. This file gives the same model
-- work to do on its own, in the shape of small jobs the database records and
-- the application runs:
--
--   read_document   a PDF or photo was attached to a stage → read it, and
--                   propose values for the stage's fields (permit number,
--                   expiry date, PO number, system size…) with a confidence
--                   and the words in the document that support each one.
--   draft_reply     a homeowner wrote → draft the PM's answer from the
--                   project's own facts, ready to send or to edit.
--   briefing        each project manager's morning summary, at the hour the
--                   admin chose, written by the assistant under that PM's
--                   own permissions.
--
-- And one that needs no model at all: evidence-based auto-advance. When an
-- admin allows it for a stage, a project whose form and attachments are
-- complete moves on by itself — the same gate, the same move service, the
-- same audit entry as the green button.
--
-- Three tables:
--
--   ai_jobs          the queue. Rows are inserted by triggers here and by the
--                    scheduled job; claimed and finished by the application.
--   ai_suggestions   one row per proposed field value. Pending until a person
--                    accepts or rejects it — or applied at once when the admin
--                    has allowed that above a confidence threshold.
--   ai_reply_drafts  one draft per homeowner message the model answered.
--
-- Nothing here writes a stage field on its own. The application does, through
-- the same allowlist as the form (src/lib/stages/fields.ts), and only when the
-- admin has switched auto-apply on or a person pressed Accept. A document the
-- model was unsure about becomes an exception (raised_by 'ai'), which 004700
-- already turns into the PM's "AI needs a decision" notification.
--
-- Every switch defaults to the cautious side: reading on, auto-apply off,
-- auto-advance for no stage, drafts on, auto-send off, briefings on.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The switches
-- -----------------------------------------------------------------------------
alter table public.app_settings
  add column if not exists ai_document_reading     boolean not null default true,
  add column if not exists ai_auto_apply           boolean not null default false,
  add column if not exists ai_confidence_threshold numeric(3,2) not null default 0.85
    check (ai_confidence_threshold between 0.5 and 1),
  add column if not exists ai_auto_advance_stages  text[] not null default '{}',
  add column if not exists ai_reply_drafts         boolean not null default true,
  add column if not exists ai_reply_auto_send      boolean not null default false,
  add column if not exists ai_briefings            boolean not null default true;

-- -----------------------------------------------------------------------------
-- 1b. The automation's own identity
-- -----------------------------------------------------------------------------
-- The scheduled job and the automation act as an admin with the all-zeros id.
-- Until now nothing they did needed a profiles row; a stage move does — the
-- stage-history trigger records who moved it — so the service account gets a
-- real row. No password, never confirmed, so it cannot sign in; inactive and
-- soft-deleted, so it appears in no list and receives no notification. What it
-- does is attributed to it in the audit log and the stage history, which is
-- the point: "the automation moved this" rather than a name borrowed from a PM.
insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000', 'automation@solarflow.local',
        '{"user_role": "admin"}'::jsonb, '{"full_name": "SolarFlow automation"}'::jsonb)
on conflict (id) do nothing;
insert into public.profiles (id, role, email, full_name)
values ('00000000-0000-0000-0000-000000000000', 'admin', 'automation@solarflow.local', 'SolarFlow automation')
on conflict (id) do nothing;
update public.profiles
   set is_active = false, deleted_at = coalesce(deleted_at, now()), full_name = 'SolarFlow automation'
 where id = '00000000-0000-0000-0000-000000000000';

-- -----------------------------------------------------------------------------
-- 2. The queue
-- -----------------------------------------------------------------------------
create table if not exists public.ai_jobs (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('read_document', 'draft_reply', 'briefing')),
  project_id  uuid references public.projects (id) on delete cascade,
  -- What the job is about: a document id, a message id, 'user:date' for a briefing.
  entity_id   text not null,
  payload     jsonb not null default '{}'::jsonb,
  status      text not null default 'queued'
              check (status in ('queued', 'running', 'done', 'failed', 'skipped')),
  attempts    integer not null default 0,
  run_after   timestamptz not null default now(),
  locked_at   timestamptz,
  finished_at timestamptz,
  result      jsonb,
  error       text,
  created_at  timestamptz not null default now()
);

-- A document is read once, a message answered once, a briefing written once a day.
create unique index if not exists ai_jobs_entity_idx on public.ai_jobs (kind, entity_id);
create index if not exists ai_jobs_queue_idx on public.ai_jobs (run_after) where status in ('queued', 'running');
create index if not exists ai_jobs_project_idx on public.ai_jobs (project_id);

alter table public.ai_jobs enable row level security;
revoke all on public.ai_jobs from public, anon;
grant select on public.ai_jobs to authenticated;
drop policy if exists ai_jobs_select on public.ai_jobs;
create policy ai_jobs_select on public.ai_jobs
  for select to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops'));

/** Queue a job. Silent when the same job is already queued or done. */
create or replace function app.enqueue_ai_job(p_kind text, p_project uuid, p_entity text, p_payload jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare v_id bigint;
begin
  insert into public.ai_jobs (kind, project_id, entity_id, payload)
  values (p_kind, p_project, p_entity, coalesce(p_payload, '{}'::jsonb))
  on conflict (kind, entity_id) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

/** The scheduled job's way in: queue a briefing for a person on a date. */
create or replace function public.enqueue_ai_job(p_kind text, p_project uuid, p_entity text, p_payload jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select app.current_user_role()) not in ('admin', 'ops') then
    raise exception 'only staff queue automation' using errcode = '42501';
  end if;
  return app.enqueue_ai_job(p_kind, p_project, p_entity, p_payload);
end;
$$;
revoke execute on function public.enqueue_ai_job(text, uuid, text, jsonb) from public, anon;
grant execute on function public.enqueue_ai_job(text, uuid, text, jsonb) to authenticated;

/**
 * Claim up to p_limit jobs to run. A job left 'running' for ten minutes is
 * taken to have died with its process and is claimed again; after three
 * attempts it is failed for good, so a document the model cannot read does
 * not cost a call every ten minutes for ever.
 */
create or replace function public.claim_ai_jobs(p_limit integer default 10)
returns setof public.ai_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select app.current_user_role()) not in ('admin', 'ops') then
    raise exception 'only staff run automation' using errcode = '42501';
  end if;
  update public.ai_jobs j
     set status = 'failed', finished_at = now(),
         error = coalesce(j.error, 'gave up after ' || j.attempts || ' attempts')
   where j.status = 'running' and j.locked_at < now() - interval '10 minutes' and j.attempts >= 3;

  return query
    with picked as (
      select j.id from public.ai_jobs j
       where j.run_after <= now()
         and (j.status = 'queued'
              or (j.status = 'running' and j.locked_at < now() - interval '10 minutes'))
       order by j.created_at
       limit greatest(1, least(coalesce(p_limit, 10), 50))
       for update skip locked)
    update public.ai_jobs j
       set status = 'running', locked_at = now(), attempts = j.attempts + 1
      from picked where j.id = picked.id
    returning j.*;
end;
$$;
revoke execute on function public.claim_ai_jobs(integer) from public, anon;
grant execute on function public.claim_ai_jobs(integer) to authenticated;

create or replace function public.finish_ai_job(p_id bigint, p_status text, p_result jsonb, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select app.current_user_role()) not in ('admin', 'ops') then
    raise exception 'only staff run automation' using errcode = '42501';
  end if;
  if p_status not in ('done', 'failed', 'skipped', 'queued') then
    raise exception 'unknown job status %', p_status;
  end if;
  update public.ai_jobs
     set status = p_status,
         finished_at = case when p_status = 'queued' then null else now() end,
         -- 'queued' is a retry: back off a little so a flapping API is not hammered.
         run_after = case when p_status = 'queued' then now() + interval '2 minutes' else run_after end,
         locked_at = case when p_status = 'queued' then null else locked_at end,
         result = coalesce(p_result, result),
         error = left(p_error, 1000)
   where id = p_id;
end;
$$;
revoke execute on function public.finish_ai_job(bigint, text, jsonb, text) from public, anon;
grant execute on function public.finish_ai_job(bigint, text, jsonb, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Suggestions: what the reader proposed
-- -----------------------------------------------------------------------------
create table if not exists public.ai_suggestions (
  id          bigint generated always as identity primary key,
  project_id  uuid not null references public.projects (id) on delete cascade,
  document_id uuid references public.documents (id) on delete cascade,
  stage       public.project_stage not null,
  field       text not null,
  value       jsonb not null,
  confidence  numeric(3,2) not null check (confidence between 0 and 1),
  evidence    text,
  status      text not null default 'pending'
              check (status in ('pending', 'applied', 'rejected', 'superseded')),
  decided_by  uuid references public.profiles (id),
  decided_at  timestamptz,
  created_at  timestamptz not null default now()
);
create unique index if not exists ai_suggestions_doc_field_idx
  on public.ai_suggestions (document_id, field) where document_id is not null;
create index if not exists ai_suggestions_project_idx on public.ai_suggestions (project_id) where status = 'pending';

alter table public.ai_suggestions enable row level security;
revoke all on public.ai_suggestions from public, anon;
grant select, insert, update on public.ai_suggestions to authenticated;
drop policy if exists ai_suggestions_select on public.ai_suggestions;
create policy ai_suggestions_select on public.ai_suggestions
  for select to authenticated
  using ((select app.is_admin()) or app.is_project_staff(project_id));
drop policy if exists ai_suggestions_insert on public.ai_suggestions;
create policy ai_suggestions_insert on public.ai_suggestions
  for insert to authenticated
  with check ((select app.is_admin()) or app.is_project_staff(project_id));
drop policy if exists ai_suggestions_update on public.ai_suggestions;
create policy ai_suggestions_update on public.ai_suggestions
  for update to authenticated
  using ((select app.is_admin()) or app.is_project_staff(project_id))
  with check ((select app.is_admin()) or app.is_project_staff(project_id));

drop trigger if exists audit_row on public.ai_suggestions;
create trigger audit_row after update on public.ai_suggestions
  for each row execute function app.tg_audit_row();

/**
 * Once every suggestion from a document has been decided, the exception that
 * asked for the decisions closes itself. Kept in the database so it holds
 * whether the decision came from the exceptions screen or the stage form.
 */
create or replace function app.tg_ai_suggestion_decided()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status <> 'pending' and old.status = 'pending' and new.document_id is not null
     and not exists (select 1 from public.ai_suggestions s
                      where s.document_id = new.document_id and s.status = 'pending') then
    update public.exceptions e
       set status = 'resolved', resolved_at = now(), resolved_by = auth.uid(),
           resolution_notes = coalesce(e.resolution_notes, 'Every suggested value was decided.')
     where e.raised_by = 'ai' and e.entity_type = 'documents' and e.entity_id = new.document_id::text
       and e.status in ('open', 'acknowledged', 'in_progress');
  end if;
  return new;
end;
$$;
drop trigger if exists ai_suggestion_decided on public.ai_suggestions;
create trigger ai_suggestion_decided after update on public.ai_suggestions
  for each row execute function app.tg_ai_suggestion_decided();

-- -----------------------------------------------------------------------------
-- 4. Reply drafts
-- -----------------------------------------------------------------------------
create table if not exists public.ai_reply_drafts (
  id          bigint generated always as identity primary key,
  project_id  uuid not null references public.projects (id) on delete cascade,
  message_id  uuid not null references public.project_messages (id) on delete cascade,
  body        text not null,
  confidence  numeric(3,2) not null check (confidence between 0 and 1),
  -- The model's own view: does this need a person? Why?
  needs_human boolean not null default false,
  reason      text,
  status      text not null default 'draft'
              check (status in ('draft', 'sent', 'sent_auto', 'dismissed')),
  sent_message_id uuid references public.project_messages (id) on delete set null,
  decided_by  uuid references public.profiles (id),
  decided_at  timestamptz,
  created_at  timestamptz not null default now()
);
create unique index if not exists ai_reply_drafts_message_idx on public.ai_reply_drafts (message_id);
create index if not exists ai_reply_drafts_project_idx on public.ai_reply_drafts (project_id) where status = 'draft';

alter table public.ai_reply_drafts enable row level security;
revoke all on public.ai_reply_drafts from public, anon;
grant select, insert, update on public.ai_reply_drafts to authenticated;
drop policy if exists ai_reply_drafts_select on public.ai_reply_drafts;
create policy ai_reply_drafts_select on public.ai_reply_drafts
  for select to authenticated
  using ((select app.is_admin()) or app.is_project_staff(project_id));
drop policy if exists ai_reply_drafts_insert on public.ai_reply_drafts;
create policy ai_reply_drafts_insert on public.ai_reply_drafts
  for insert to authenticated
  with check ((select app.is_admin()) or app.is_project_staff(project_id));
drop policy if exists ai_reply_drafts_update on public.ai_reply_drafts;
create policy ai_reply_drafts_update on public.ai_reply_drafts
  for update to authenticated
  using ((select app.is_admin()) or app.is_project_staff(project_id))
  with check ((select app.is_admin()) or app.is_project_staff(project_id));

-- -----------------------------------------------------------------------------
-- 5. What queues the work
-- -----------------------------------------------------------------------------
-- A stage attachment (a document with a category) → read it. Chat attachments
-- and generated PDFs have no category and are left alone. Only formats the
-- model can read: PDFs and ordinary photos.
create or replace function app.tg_ai_document()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- 'chat' is the chat module's filing category, not a stage field.
  if new.category is null or new.category = 'chat' or new.project_id is null then return new; end if;
  if coalesce(new.mime_type, '') not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp') then
    return new;
  end if;
  if not coalesce((select s.ai_document_reading from public.app_settings s where s.id), true) then
    return new;
  end if;
  perform app.enqueue_ai_job('read_document', new.project_id, new.id::text,
    jsonb_build_object('category', new.category, 'title', new.title, 'mime', new.mime_type));
  return new;
end;
$$;
drop trigger if exists ai_document on public.documents;
create trigger ai_document after insert on public.documents
  for each row execute function app.tg_ai_document();

-- A homeowner's message → draft the answer.
create or replace function app.tg_ai_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.sender_role <> 'customer' or new.is_internal then return new; end if;
  if not coalesce((select s.ai_reply_drafts from public.app_settings s where s.id), true) then
    return new;
  end if;
  perform app.enqueue_ai_job('draft_reply', new.project_id, new.id::text, '{}'::jsonb);
  return new;
end;
$$;
drop trigger if exists ai_message on public.project_messages;
create trigger ai_message after insert on public.project_messages
  for each row execute function app.tg_ai_message();

-- -----------------------------------------------------------------------------
-- 6. The exceptions queue, as the screen reads it
-- -----------------------------------------------------------------------------
/** Open exceptions this person may see, with the project and the pending suggestion count. */
create or replace function public.open_exceptions()
returns table (
  id uuid, project_id uuid, project_code text, project_name text, customer_name text,
  entity_type text, entity_id text, severity text, status text, summary text, details jsonb,
  raised_by text, assigned_to uuid, assigned_name text, pending_suggestions integer, created_at timestamptz
)
language sql
security invoker
stable
set search_path = ''
as $$
  select e.id, e.project_id, p.code, p.name,
         nullif(btrim(concat_ws(' ', cl.first_name, cl.last_name)), ''),
         e.entity_type, e.entity_id, e.severity::text, e.status::text, e.summary, e.details,
         e.raised_by, e.assigned_to, coalesce(pr.full_name, pr.email),
         (select count(*) from public.ai_suggestions s
           where e.entity_type = 'documents' and s.document_id::text = e.entity_id and s.status = 'pending')::int,
         e.created_at
    from public.exceptions e
    left join public.projects p on p.id = e.project_id
    left join public.clients cl on cl.id = p.client_id
    left join public.profiles pr on pr.id = e.assigned_to
   where e.status in ('open', 'acknowledged', 'in_progress')
   order by array_position(array['critical','high','medium','low'], e.severity::text), e.created_at desc
$$;
revoke execute on function public.open_exceptions() from public, anon;
grant execute on function public.open_exceptions() to authenticated;


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
  ('20260803004700_notifications.sql'),
  ('20260803004800_ai_automation.sql')
on conflict (name) do nothing;
