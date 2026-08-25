-- =============================================================================
-- 003200 — Stage feedback (customer sentiment)
-- =============================================================================
-- Implements the Stage Feedback specification: a one-tap rating asked the moment
-- a stage completes, six or seven times across a project instead of one survey
-- at the end.
--
-- The premise the whole design rests on (§1): asking at the moment tells you
-- *which stage* lost the customer, while you can still do something about it. An
-- end-of-job survey tells you that somebody is unhappy after the last chance to
-- fix it has gone.
--
-- Three things in this file are load-bearing, and each one is here rather than
-- in the application because the application is not the only thing that will
-- ever write to this table:
--
--  1. One row per (project, stage), for ever. §4's first hard limit — "a project
--     can never be asked twice about the same stage" — is a unique constraint,
--     not a check in a route. The row is created when the request is made and
--     updated when it is answered, so an unanswered request is still a
--     measurable thing (§8) rather than an absence.
--
--  2. The score is written on tap (§9). The functions are split accordingly:
--     one records a score alone, a second attaches the reasons and the comment
--     if the customer keeps going. Abandonment after tapping a face is common,
--     and that tap is the number worth having.
--
--  3. Attribution is a snapshot (§6). Who the PM, dealer and rep were at the
--     time is copied onto the row when the request is created. Reassigning a
--     project next month must not rewrite last month's scores.
--
-- What §6 asks for and this file cannot yet do: the stage-specific party is
-- recorded generically (kind + id + a name snapshot), and today only Stage 2's
-- designer is actually available — the live stage tables carry designer_id but
-- no surveyor or crew column. Those two attach the day those fields exist,
-- without a schema change here.
--
-- Note also what is deliberately absent: any table a third-party survey tool
-- would own. §8: "a rating that lives in someone else's system cannot flag a
-- project card or open a task."

-- -----------------------------------------------------------------------------
-- 1. Follow-up work
-- -----------------------------------------------------------------------------
-- §9 is blunt: "Build it after the portal and the PM task list exist. The rating
-- is only half the feature; the follow-up task is the other half, and without
-- somewhere for it to land you are just collecting numbers."
--
-- There was no task list in this product, so here is the smallest one that can
-- hold the other half honestly: a task belongs to a project, carries the reason
-- it exists, and cannot be closed without saying what was done (§5). The
-- `source` column is there so the next thing that needs to raise work for a PM
-- extends this table instead of inventing a second one.

create table if not exists public.project_tasks (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id) on delete cascade,
  source         text not null default 'feedback'
                   check (source in ('feedback', 'manual')),
  title          text not null,
  /** The first move, drawn from a template — §5's 'suggested action'. */
  suggested      text,
  detail         text,
  priority       text not null default 'high' check (priority in ('high', 'normal')),
  /** A snapshot: the PM at the time the task was raised. */
  assigned_to    uuid references public.profiles (id) on delete set null,
  created_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz,
  resolved_by    uuid references public.profiles (id) on delete set null,
  /** §5: "The task must be closed with a resolution note." Enforced below. */
  resolution     text,
  constraint project_tasks_resolution_needs_note
    check (resolved_at is null or length(btrim(coalesce(resolution, ''))) > 0)
);

create index if not exists project_tasks_open_idx
  on public.project_tasks (project_id) where resolved_at is null;
create index if not exists project_tasks_assigned_idx
  on public.project_tasks (assigned_to, resolved_at);

-- -----------------------------------------------------------------------------
-- 2. The rating itself
-- -----------------------------------------------------------------------------

-- public.stage_feedback already exists — as a placeholder from the foundation
-- schema (000200), which described it as "created now, mostly unused in phase
-- one" and gave it a rating, a free-text field, a `source` and permissive
-- policies letting any project participant write one. Nothing in the
-- application ever wrote to it.
--
-- This module is that table's real implementation, so it takes it over rather
-- than standing a near-identical table beside it. Two names change to match what
-- they now mean, the new columns arrive, and the old policies — which let a
-- dealer or a designer file a rating, and allowed many rows per stage — are
-- replaced further down.

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'stage_feedback'
                    and column_name = 'score') then
    alter table public.stage_feedback rename column rating to score;
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'stage_feedback'
                    and column_name = 'comment') then
    alter table public.stage_feedback rename column feedback to comment;
  end if;
end
$$;

-- Note what is NOT here: a type change on `score`. It arrived as integer and an
-- integer holds 1 to 5 perfectly well — and once the views below exist, altering
-- the column's type fails, which would make this file safe to run once and not
-- twice. Every migration here has to survive being pasted again.
alter table public.stage_feedback
  /** §3: one extra question, at the final stage only. */
  add column if not exists nps smallint check (nps between 0 and 10),
  /** The reason chips, by key. */
  add column if not exists tags text[] not null default '{}',
  add column if not exists channel text check (channel in ('portal', 'app', 'email')),
  add column if not exists requested_at timestamptz not null default now(),
  /**
   * When the request may actually be shown or sent. Carries §1's 7pm deferral
   * for installation day and §4's 48-hour gap: the request exists immediately
   * (so the stage is never asked about twice) but stays invisible until due.
   */
  add column if not exists send_after timestamptz not null default now(),
  add column if not exists responded_at timestamptz,
  /** 'Not now' — dismissed in the sheet, still askable as a quiet card. */
  add column if not exists dismissed_at timestamptz,
  /** The one email reminder (§4: asked twice, then never). */
  add column if not exists reminded_at timestamptz,
  /** Closed unanswered: both attempts spent, no third. */
  add column if not exists closed_at timestamptz,
  /** Attribution, snapshotted at request time (§6). */
  add column if not exists attributed_pm uuid references public.profiles (id) on delete set null,
  add column if not exists attributed_dealer uuid references public.dealers (id) on delete set null,
  add column if not exists attributed_rep uuid references public.sales_reps (id) on delete set null,
  add column if not exists attributed_party_kind text
    check (attributed_party_kind in ('surveyor', 'designer', 'crew')),
  add column if not exists attributed_party_id uuid,
  /** A name copy, so a deleted reference record does not blank the history. */
  add column if not exists attributed_party_name text,
  add column if not exists task_id uuid references public.project_tasks (id) on delete set null,
  /** sha256 of the emailed one-click token. The token itself is never stored. */
  add column if not exists token_hash text,
  add column if not exists updated_at timestamptz not null default now();

-- The legacy `source` column ('customer' | 'dealer' | 'designer' | 'ai') is left
-- alone: it is not null with a default, so it does not obstruct anything, and
-- dropping a column to tidy up is how you lose data that turns out to matter.
-- `channel` above is the field this module reads.

/**
 * §4's first hard limit as a constraint rather than a hope: one row per
 * (project, stage), for ever.
 *
 * The old table allowed several — one per participant. If a database somehow
 * holds duplicates, this says so and names them instead of quietly deleting
 * somebody's data to make room for the constraint.
 */
do $$
declare v_dupes text;
begin
  if not exists (select 1 from pg_constraint where conname = 'stage_feedback_one_per_stage') then
    select string_agg(format('%s/%s', project_id, stage), ', ')
      into v_dupes
      from (select project_id, stage from public.stage_feedback
             group by project_id, stage having count(*) > 1 limit 20) d;
    if v_dupes is not null then
      raise exception 'stage_feedback has more than one row for: %. Keep one row per project and stage, then run this file again.', v_dupes;
    end if;
    alter table public.stage_feedback
      add constraint stage_feedback_one_per_stage unique (project_id, stage);
  end if;

  -- A response has a score. Anything else is a half-written row.
  if not exists (select 1 from pg_constraint
                  where conname = 'stage_feedback_answered_has_score') then
    alter table public.stage_feedback
      add constraint stage_feedback_answered_has_score
      check (responded_at is null or score is not null);
  end if;
end
$$;

create index if not exists stage_feedback_due_idx
  on public.stage_feedback (send_after)
  where responded_at is null and closed_at is null;
create index if not exists stage_feedback_stage_idx
  on public.stage_feedback (stage, responded_at);
create index if not exists stage_feedback_low_idx
  on public.stage_feedback (project_id) where score <= 2;

drop trigger if exists set_updated_at on public.stage_feedback;
create trigger set_updated_at before update on public.stage_feedback
  for each row execute function app.tg_set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. Configuration: the chips, and which stages ask at all
-- -----------------------------------------------------------------------------
-- §3: "Editable in admin, and the chip list can vary per stage (a survey has no
-- pricing chip; an install has no permit chip)." An empty `stages` array means
-- the chip applies everywhere, which is the common case and saves listing all
-- seven on most rows.

create table if not exists public.feedback_reasons (
  key        text primary key,
  label      text not null,
  stages     public.project_stage[] not null default '{}',
  sort_order integer not null default 100,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.feedback_reasons (key, label, stages, sort_order) values
  ('slow_updates',  'Slow updates',       '{}', 10),
  ('scheduling',    'Scheduling',         '{}', 20),
  ('communication', 'Communication',      '{}', 30),
  ('technician',    'Technician or crew',
     '{survey,install,inspection_pto}', 40),
  ('pricing',       'Unclear pricing',    '{survey,design,complete}', 50),
  ('quality',       'Quality concern',    '{install,inspection_pto,complete}', 60),
  ('other',         'Something else',     '{}', 100)
on conflict (key) do nothing;

drop trigger if exists set_updated_at on public.feedback_reasons;
create trigger set_updated_at before update on public.feedback_reasons
  for each row execute function app.tg_set_updated_at();

-- Which stages ask, on the table that already holds the per-stage config.
--
-- Guarded, because stage_thresholds arrives with the dashboard module and a
-- database that skipped it would otherwise fail this whole file on a plain
-- `alter table`. The request function reads the flag through the same table and
-- the application's calls are savepoint-guarded, so a database without it simply
-- asks about every stage — which is the default anyway.
do $$
begin
  if to_regclass('public.stage_thresholds') is null then
    raise notice '003200: public.stage_thresholds is not here yet (it arrives with the dashboard migration 002800), so the per-stage feedback switch was skipped. Every stage will ask until that file is run.';
  else
    execute 'alter table public.stage_thresholds
               add column if not exists feedback_enabled boolean not null default true';
  end if;
end
$$;

-- Complete asks (and adds the recommendation question); the rest default on.
alter table public.app_settings
  add column if not exists feedback_enabled boolean not null default true,
  add column if not exists feedback_nps_enabled boolean not null default true,
  /** Templates for §5's suggested first move, by chip key. */
  add column if not exists feedback_action_templates jsonb not null default '{}'::jsonb;

update public.app_settings set feedback_action_templates = jsonb_build_object(
  'slow_updates',  'Call them with a status summary and set a date for the next update.',
  'scheduling',    'Call to re-book, with two concrete dates to choose between.',
  'communication', 'Call, apologise for the silence, and agree who they contact and how.',
  'technician',    'Review the visit with the crew lead before calling the customer back.',
  'pricing',       'Walk them through the contract line by line, including any adders.',
  'quality',       'Book a site visit to look at the concern in person.',
  'other',         'Call and ask what happened — the comment will not have the whole story.'
) where feedback_action_templates = '{}'::jsonb;

-- §4: the customer's own off switch, alongside the other notification kinds.
-- Guarded for the same reason as the switch above — this table arrives with the
-- mobile module, and every one of these files has to survive being run against a
-- database that is missing an earlier one.
do $$
begin
  if to_regclass('public.notification_preferences') is null then
    raise notice '003200: public.notification_preferences is not here yet (it arrives with the mobile migration 002500), so the rating opt-out category was skipped.';
  else
    alter table public.notification_preferences
      drop constraint if exists notification_preferences_category_check;
    alter table public.notification_preferences
      add constraint notification_preferences_category_check
      check (category in ('stage_advanced', 'appointment', 'action_needed', 'on_hold',
                          'power_on', 'chat_message', 'feedback_request'));
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 4. Row-level security
-- -----------------------------------------------------------------------------

-- app.is_project_customer() belongs to the chat module (002900) and is used by
-- the policy and the answer functions below. Created here only if it is absent,
-- so this file installs cleanly on a database that skipped 002900 — the same
-- predicate, never overwriting the original. A migration that fails because an
-- earlier one was skipped leaves an operator with a half-applied catch-up and no
-- idea which file to blame.
do $$
begin
  if to_regprocedure('app.is_project_customer(uuid)') is null then
    execute $f$
      create function app.is_project_customer(pid uuid)
      returns boolean
      language sql
      stable
      security definer
      set search_path = ''
      as $body$
        select exists (
          select 1 from public.projects p
          where p.id = pid
            and p.client_id in (select app.current_client_ids())
        );
      $body$
    $f$;
    execute 'grant execute on function app.is_project_customer(uuid) to authenticated';
  end if;
end
$$;

alter table public.project_tasks enable row level security;
alter table public.stage_feedback enable row level security;
alter table public.feedback_reasons enable row level security;

grant select on public.project_tasks to authenticated;
grant select on public.stage_feedback to authenticated;
grant select on public.feedback_reasons to authenticated;

-- Tasks are staff work. A customer must never see that their rating became a
-- ticket with a suggested script — and a dealer must not see it either.
drop policy if exists project_tasks_select on public.project_tasks;
create policy project_tasks_select on public.project_tasks
  for select to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops'));

/**
 * The rating rows.
 *
 * Staff see everything. The customer sees their own project's rows, which is
 * what lets the sheet know whether to appear and what the persistent card says.
 * Dealers are NOT given the table: §5 says a dealer learns the fact and not the
 * verbatim comment, so they read a view that has no comment column in it at
 * all (below). Filtering a comment out in the application would be one edit
 * away from leaking it.
 */
-- The foundation schema's policies let any project participant insert a rating
-- and the author read their own. Both are wrong here: a dealer or designer must
-- not file a customer's rating, and every write now goes through a function.
drop policy if exists stage_feedback_insert on public.stage_feedback;
drop policy if exists stage_feedback_write_admin_u on public.stage_feedback;
drop policy if exists stage_feedback_write_admin_d on public.stage_feedback;

drop policy if exists stage_feedback_select on public.stage_feedback;
create policy stage_feedback_select on public.stage_feedback
  for select to authenticated
  using (
    (select app.current_user_role()) in ('admin', 'ops')
    or app.is_project_customer(project_id)
  );

drop policy if exists feedback_reasons_select on public.feedback_reasons;
create policy feedback_reasons_select on public.feedback_reasons
  for select to authenticated using (true);

drop policy if exists feedback_reasons_write on public.feedback_reasons;
create policy feedback_reasons_write on public.feedback_reasons
  for all to authenticated
  using (app.is_admin()) with check (app.is_admin());

-- Every write to a rating goes through a function below. The same reasoning as
-- the chat module: a table a customer can update directly is a table where a
-- customer can set somebody else's score, or their own twice.
revoke insert, update, delete on public.stage_feedback from authenticated;
revoke insert, update, delete on public.project_tasks from authenticated;

-- -----------------------------------------------------------------------------
-- 5. Asking
-- -----------------------------------------------------------------------------

/**
 * Create the request for a stage that has just completed.
 *
 * Called by the stage-move service as part of the same transaction as the move,
 * so a completed stage and its rating request cannot come apart. Returns the
 * request id, or null when a guardrail says not to ask — every one of §1 and
 * §4's rules is checked here rather than at the call site, because the call site
 * will eventually be more than one place.
 */
create or replace function public.request_stage_feedback(
  p_project uuid,
  p_stage   public.project_stage
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id           uuid;
  v_project      record;
  v_enabled      boolean;
  v_last_request timestamptz;
  v_send_after   timestamptz := now();
  v_tz           text;
  v_opted_out    boolean;
  v_party_kind   text;
  v_party_id     uuid;
  v_party_name   text;
begin
  if (select app.current_user_role()) not in ('admin', 'ops') then
    raise exception 'only staff may raise a feedback request' using errcode = '42501';
  end if;

  -- Globally off, or off for this stage (§3's per-stage configuration).
  select coalesce(a.feedback_enabled, true) into v_enabled
    from public.app_settings a where a.id;
  if not coalesce(v_enabled, true) then return null; end if;

  -- Same reasoning as the guarded alter above: on a database without the
  -- dashboard migration there is no per-stage switch, and the answer is 'ask'.
  if to_regclass('public.stage_thresholds') is not null then
    execute 'select coalesce(t.feedback_enabled, true) from public.stage_thresholds t
              where t.stage = $1'
       into v_enabled using p_stage;
    if not coalesce(v_enabled, true) then return null; end if;
  end if;

  select p.id, p.status, p.assigned_pm, p.dealer_id, p.sales_rep_id, p.client_id
    into v_project
    from public.projects p where p.id = p_project;
  if not found then return null; end if;

  -- §1: a project on hold or cancelled is not asked. "Asking someone to rate
  -- the experience at the moment it goes wrong is tone-deaf and produces
  -- useless data."
  if v_project.status in ('on_hold', 'cancelled') then return null; end if;

  -- §4: the customer's own off switch, honoured everywhere.
  select exists (
    select 1 from public.notification_preferences np
    join public.clients c on c.user_id = np.user_id
    where c.id = v_project.client_id
      and np.category = 'feedback_request'
      and not np.push and not coalesce(np.email, true)
  ) into v_opted_out;
  if v_opted_out then return null; end if;

  -- §4: never two requests inside 48 hours. The second one queues rather than
  -- being dropped — permits finishing the day after equipment is a real
  -- sequence, and the second stage is still worth asking about later.
  select max(f.requested_at) into v_last_request
    from public.stage_feedback f where f.project_id = p_project;
  if v_last_request is not null and v_last_request > now() - interval '48 hours' then
    v_send_after := v_last_request + interval '48 hours';
  end if;

  -- §1: installation is asked in the evening. "A crew leaving at 4pm is still
  -- packing the van — ask when the customer has actually seen their system."
  if p_stage = 'install' then
    select coalesce(a.company_timezone, 'America/Chicago') into v_tz
      from public.app_settings a where a.id;
    -- 7pm on the day the request would otherwise go out — which is not always
    -- today: a 48-hour queue may already have pushed it into next week, and
    -- 'greatest(queued, 7pm tonight)' would then quietly drop the deferral.
    -- If it is already past 7pm that day, it is evening enough.
    if (v_send_after at time zone v_tz)::time < time '19:00' then
      v_send_after := (((v_send_after at time zone v_tz)::date + time '19:00')
                       at time zone v_tz);
    end if;
  end if;

  -- The stage-specific party, where the schema has one (§6).
  if p_stage = 'design' then
    select 'designer', d.id, d.display_name into v_party_kind, v_party_id, v_party_name
      from public.stage2_design s2
      join public.designers d on d.id = s2.designer_id
     where s2.project_id = p_project;
  end if;

  insert into public.stage_feedback
    (project_id, stage, send_after, attributed_pm, attributed_dealer, attributed_rep,
     attributed_party_kind, attributed_party_id, attributed_party_name)
  values
    (p_project, p_stage, v_send_after, v_project.assigned_pm, v_project.dealer_id,
     v_project.sales_rep_id, v_party_kind, v_party_id, v_party_name)
  -- §4 again, belt and braces: a second attempt at the same stage is a no-op
  -- rather than an error, so an admin re-running a move cannot break a save.
  on conflict (project_id, stage) do nothing
  returning id into v_id;

  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Answering
-- -----------------------------------------------------------------------------

/**
 * Record the score, on tap (§9).
 *
 * Deliberately does nothing else: no comment, no chips, no Send. If the customer
 * closes the sheet immediately afterwards — which many will — the number is
 * already saved, and that is the part the business can act on.
 *
 * A low score opens the follow-up task here, in the same statement, so §5's
 * "creates a task" is true even for a customer who taps one face and walks away.
 */
create or replace function public.record_stage_feedback(
  p_project uuid,
  p_stage   public.project_stage,
  p_score   integer,
  p_channel text default 'portal'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.stage_feedback;
begin
  if not app.is_project_customer(p_project) then
    raise exception 'only this project''s customer may rate it' using errcode = '42501';
  end if;
  if p_score is null or p_score < 1 or p_score > 5 then
    raise exception 'score must be 1 to 5' using errcode = '22023';
  end if;

  update public.stage_feedback f
     set score = p_score,
         responded_at = coalesce(f.responded_at, now()),
         channel = coalesce(f.channel, case when p_channel in ('portal', 'app', 'email')
                                            then p_channel else 'portal' end),
         dismissed_at = null
   where f.project_id = p_project and f.stage = p_stage
     and f.closed_at is null
  returning * into v_row;

  if not found then return null; end if;

  perform public.open_feedback_task(v_row.id);
  return v_row.id;
end;
$$;

/**
 * Step two: the reasons and the comment, if they keep going (§3).
 *
 * Separate from the score on purpose — see above. Also used by the email path,
 * where the score arrives by link and the comment on the page that link opens.
 */
create or replace function public.detail_stage_feedback(
  p_project uuid,
  p_stage   public.project_stage,
  p_tags    text[],
  p_comment text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.stage_feedback;
begin
  if not app.is_project_customer(p_project) then
    raise exception 'only this project''s customer may rate it' using errcode = '42501';
  end if;

  update public.stage_feedback f
     set tags = coalesce(
           (select array_agg(r.key order by r.sort_order)
              from public.feedback_reasons r
             where r.key = any(coalesce(p_tags, '{}'))),
           '{}'),
         comment = nullif(btrim(coalesce(p_comment, '')), ''),
         -- Only a score makes this a response. Stamping responded_at on a
         -- comment alone would both violate the check constraint and count an
         -- unrated stage as answered in the response rate.
         responded_at = case when f.score is null then f.responded_at
                             else coalesce(f.responded_at, now()) end
   where f.project_id = p_project and f.stage = p_stage
  returning * into v_row;

  if not found then return null; end if;

  -- The task's suggested action depends on the chips, so it is recomputed once
  -- they arrive. A task raised by the tap alone gets the generic prompt.
  perform public.open_feedback_task(v_row.id);
  return v_row.id;
end;
$$;

/** The recommendation question, final stage only (§3). */
create or replace function public.record_stage_nps(
  p_project uuid,
  p_stage   public.project_stage,
  p_nps     integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.stage_feedback;
begin
  if not app.is_project_customer(p_project) then
    raise exception 'only this project''s customer may rate it' using errcode = '42501';
  end if;
  if p_nps is null or p_nps < 0 or p_nps > 10 then
    raise exception 'recommendation score must be 0 to 10' using errcode = '22023';
  end if;

  update public.stage_feedback f
     set nps = p_nps, responded_at = coalesce(f.responded_at, now())
   where f.project_id = p_project and f.stage = p_stage
  returning * into v_row;

  if not found then return null; end if;
  -- §5: a detractor is treated exactly like a low stage score.
  perform public.open_feedback_task(v_row.id);
  return v_row.id;
end;
$$;

/** 'Not now'. Dismissible, never blocking (§2). */
create or replace function public.dismiss_stage_feedback(
  p_project uuid,
  p_stage   public.project_stage
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not app.is_project_customer(p_project) then
    raise exception 'not your project' using errcode = '42501';
  end if;
  update public.stage_feedback
     set dismissed_at = now()
   where project_id = p_project and stage = p_stage and responded_at is null;
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. A low score becomes work
-- -----------------------------------------------------------------------------

/**
 * Open (or update) the follow-up task for a rating.
 *
 * §5: score 1–2, or NPS 0–6, creates a task flagged high, carrying the score,
 * the comment, the chips and which stage it refers to. Idempotent: called again
 * when the comment arrives, it fills in the detail rather than raising a second
 * task.
 *
 * Internal — the application never calls this directly, which is why it is not
 * granted below. It exists as its own function so the rule "what counts as a
 * low score" is written once.
 */
create or replace function public.open_feedback_task(p_feedback uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_f         public.stage_feedback;
  v_project   record;
  v_task      uuid;
  v_low       boolean;
  v_templates jsonb;
  v_suggested text;
  v_labels    text;
begin
  select * into v_f from public.stage_feedback where id = p_feedback;
  if not found then return null; end if;

  v_low := (v_f.score is not null and v_f.score <= 2)
        or (v_f.nps is not null and v_f.nps <= 6);
  if not v_low then return v_f.task_id; end if;

  select p.name, p.code, p.assigned_pm into v_project
    from public.projects p where p.id = v_f.project_id;

  select a.feedback_action_templates into v_templates
    from public.app_settings a where a.id;

  -- §5: the suggested first move comes from the chips. The first chip wins —
  -- with two selected the customer's first choice is the more likely cause.
  select string_agg(r.label, ', ' order by r.sort_order) into v_labels
    from public.feedback_reasons r where r.key = any(v_f.tags);
  select coalesce(
      v_templates ->> (v_f.tags)[1],
      'Call them, ask what happened, and agree the next step.')
    into v_suggested;

  if v_f.task_id is not null then
    update public.project_tasks
       set detail = format('Score %s of 5 on %s.%s%s',
                           coalesce(v_f.score::text, '—'),
                           replace(v_f.stage::text, '_', ' '),
                           case when v_labels is null then '' else ' Reasons: ' || v_labels || '.' end,
                           case when v_f.comment is null then ''
                                else E'\n\n' || v_f.comment end),
           suggested = v_suggested
     where id = v_f.task_id and resolved_at is null;
    return v_f.task_id;
  end if;

  insert into public.project_tasks (project_id, source, title, suggested, detail, priority, assigned_to)
  values (
    v_f.project_id,
    'feedback',
    format('Low rating on %s — %s', replace(v_f.stage::text, '_', ' '),
           coalesce(v_project.name, v_project.code)),
    v_suggested,
    format('Score %s of 5 on %s.%s%s',
           coalesce(v_f.score::text, '—'),
           replace(v_f.stage::text, '_', ' '),
           case when v_labels is null then '' else ' Reasons: ' || v_labels || '.' end,
           case when v_f.comment is null then '' else E'\n\n' || v_f.comment end),
    'high',
    coalesce(v_f.attributed_pm, v_project.assigned_pm)
  )
  returning id into v_task;

  update public.stage_feedback set task_id = v_task where id = p_feedback;
  return v_task;
end;
$$;

/** Close a task with the note §5 requires. */
create or replace function public.resolve_project_task(p_task uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select app.current_user_role()) not in ('admin', 'ops') then
    raise exception 'only staff may resolve a task' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_note, ''))) = 0 then
    raise exception 'a resolution note is required' using errcode = '22023';
  end if;
  update public.project_tasks
     set resolved_at = now(),
         resolved_by = (select auth.uid()),
         resolution = btrim(p_note)
   where id = p_task and resolved_at is null;
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. The email fallback (§2)
-- -----------------------------------------------------------------------------
-- "If nothing has been answered in the portal or app after 24 hours, one email
-- with the five faces as clickable links — clicking a face records the score
-- immediately and opens the portal for the optional comment. This is where most
-- responses will actually come from."
--
-- Which means the link must work without a login (§9). One token per request,
-- stored hashed; the five links differ only by the score in the query string.
-- The precedent is the no-login upload link the platform already has.

/** Issue (or reissue) the token for a request. Staff/cron only. */
create or replace function public.feedback_email_token(p_feedback uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  if (select app.current_user_role()) not in ('admin', 'ops') then
    raise exception 'only staff may issue a feedback token' using errcode = '42501';
  end if;
  update public.stage_feedback
     set token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex'),
         reminded_at = now()
   where id = p_feedback and responded_at is null and closed_at is null;
  if not found then return null; end if;
  return v_token;
end;
$$;

/**
 * Record a score from an emailed link, with no session at all.
 *
 * Safe to expose because the token grants exactly one capability: setting the
 * score on one rating request. It reads nothing, and a guessed token is 24
 * random bytes. It returns the project id so the page that opened can show the
 * thank-you and offer the comment box.
 *
 * Tokens stay usable while the request is open, so a customer who clicks a face
 * twice, or clicks a different face on reflection, gets the answer they meant
 * rather than an error page.
 */
-- Dropped first: `create or replace` cannot change a function's return type, and
-- this one's third column was smallint in an earlier draft of this file. Anybody
-- who ran that draft would otherwise keep the broken definition for ever, with
-- the file reporting success.
drop function if exists public.record_feedback_by_token(text, integer);
create or replace function public.record_feedback_by_token(p_token text, p_score integer)
-- `score integer`, not smallint: the column this reads was created as integer by
-- the foundation schema and deliberately left that way (see above), and plpgsql
-- compares RETURN QUERY types exactly — a smallint declaration here fails at
-- runtime with 'structure of query does not match function result type', on the
-- one path that has no session to show an error to.
returns table (project_id uuid, stage public.project_stage, score integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.stage_feedback;
begin
  if p_score is null or p_score < 1 or p_score > 5 then
    raise exception 'score must be 1 to 5' using errcode = '22023';
  end if;

  update public.stage_feedback f
     set score = p_score,
         responded_at = coalesce(f.responded_at, now()),
         channel = coalesce(f.channel, 'email')
   where f.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
     and f.closed_at is null
     and f.requested_at > now() - interval '60 days'
  returning * into v_row;

  if not found then return; end if;
  perform public.open_feedback_task(v_row.id);
  return query select v_row.project_id, v_row.stage, v_row.score;
end;
$$;

/**
 * The comment box on the emailed page, again with no session.
 *
 * Same token, same single capability, extended to the optional detail — the
 * alternative is asking somebody who has just told you they are unhappy to go
 * and find their password.
 */
create or replace function public.detail_feedback_by_token(
  p_token   text,
  p_tags    text[],
  p_comment text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.stage_feedback;
begin
  update public.stage_feedback f
     set tags = coalesce(
           (select array_agg(r.key order by r.sort_order)
              from public.feedback_reasons r
             where r.key = any(coalesce(p_tags, '{}'))),
           '{}'),
         comment = nullif(btrim(coalesce(p_comment, '')), '')
   where f.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
     and f.responded_at is not null
     and f.requested_at > now() - interval '60 days'
  returning * into v_row;

  if not found then return null; end if;
  perform public.open_feedback_task(v_row.id);
  return v_row.id;
end;
$$;

/**
 * What the cron endpoint needs: requests that are due, unanswered, and have not
 * had their one email yet. Also closes the ones that have had both attempts —
 * §4's "asked twice, then never", which has to be a state, not a silence.
 */
create or replace function public.claim_feedback_emails(p_limit integer default 50)
returns table (f_id uuid, f_project uuid, f_stage public.project_stage, f_token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_token text;
begin
  if (select app.current_user_role()) not in ('admin', 'ops') then
    raise exception 'only staff may send feedback email' using errcode = '42501';
  end if;

  -- Both attempts spent and still nothing: close it, and never ask again.
  update public.stage_feedback
     set closed_at = now()
   where responded_at is null and closed_at is null
     and reminded_at is not null
     and reminded_at < now() - interval '7 days';

  for v_row in
    select f.id, f.project_id, f.stage
      from public.stage_feedback f
     where f.responded_at is null
       and f.closed_at is null
       and f.reminded_at is null
       and f.send_after < now() - interval '24 hours'
     order by f.send_after
     limit greatest(1, least(200, coalesce(p_limit, 50)))
  loop
    v_token := public.feedback_email_token(v_row.id);
    if v_token is not null then
      return query select v_row.id, v_row.project_id, v_row.stage, v_token;
    end if;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Retention (§8)
-- -----------------------------------------------------------------------------
-- "Verbatim comments anonymised after two years; scores retained with the
-- project record." The score is a business metric; the sentence somebody typed
-- about their own house is personal data with a shelf life.

create or replace function public.sweep_feedback_comments()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.stage_feedback
     set comment = null
   where comment is not null
     and responded_at < now() - interval '2 years';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. Reporting (§7)
-- -----------------------------------------------------------------------------
-- security_invoker views, so the reader's own policies decide what they can see
-- and these do not become a way around them.

-- CSAT by stage, with the response count beside every average — an average of
-- three answers is a different fact from an average of ninety.
create or replace view public.feedback_by_stage
with (security_invoker = true) as
select f.stage::text as stage,
       count(*) filter (where f.score is not null)          as responses,
       count(*)                                             as requests,
       round(avg(f.score) filter (where f.score is not null), 2) as avg_score,
       count(*) filter (where f.score <= 2)                 as low_scores,
       count(*) filter (where f.responded_at is null and f.closed_at is not null) as unanswered
  from public.stage_feedback f
 group by f.stage;

grant select on public.feedback_by_stage to authenticated;

-- The trend, by month, so you can see whether a fix worked.
create or replace view public.feedback_monthly
with (security_invoker = true) as
select date_trunc('month', f.responded_at)::date as month,
       count(*)                                   as responses,
       round(avg(f.score), 2)                     as avg_score,
       count(*) filter (where f.score <= 2)       as low_scores
  from public.stage_feedback f
 where f.responded_at is not null and f.score is not null
 group by 1;

grant select on public.feedback_monthly to authenticated;

/**
 * By party (§6, §7) — PM, dealer, rep, and the stage party where there is one.
 *
 * Admin and ops only, and not because the numbers are secret: §6 is explicit
 * that these are "a prompt for a conversation, not a league table", and a
 * per-person average visible to everyone becomes a league table whatever the
 * documentation says. Sample sizes travel with every row for the same reason.
 */
create or replace view public.feedback_by_party
with (security_invoker = false) as
select kind, party_id, party_name,
       count(*) as responses,
       round(avg(score), 2) as avg_score,
       count(*) filter (where score <= 2) as low_scores
  from (
    select 'pm' as kind, f.attributed_pm as party_id,
           coalesce(pr.full_name, pr.email) as party_name, f.score
      from public.stage_feedback f
      join public.profiles pr on pr.id = f.attributed_pm
     where f.score is not null
    union all
    select 'dealer', f.attributed_dealer, d.name, f.score
      from public.stage_feedback f
      join public.dealers d on d.id = f.attributed_dealer
     where f.score is not null
    union all
    select 'rep', f.attributed_rep, sr.name, f.score
      from public.stage_feedback f
      join public.sales_reps sr on sr.id = f.attributed_rep
     where f.score is not null
    union all
    select f.attributed_party_kind, f.attributed_party_id, f.attributed_party_name, f.score
      from public.stage_feedback f
     where f.score is not null and f.attributed_party_kind is not null
  ) parties
 where (select app.current_user_role()) in ('admin', 'ops')
 group by kind, party_id, party_name;

grant select on public.feedback_by_party to authenticated;

-- Response rate per channel (§7): if the email carries most of the answers,
-- that is a fact about the portal worth knowing.
create or replace view public.feedback_response_rate
with (security_invoker = true) as
select coalesce(f.channel, 'unanswered') as channel,
       count(*) as requests,
       count(*) filter (where f.responded_at is not null) as responses
  from public.stage_feedback f
 group by 1;

grant select on public.feedback_response_rate to authenticated;

/**
 * The verbatim log — §7 calls it "the most useful part of the whole module —
 * read it, do not just average it".
 *
 * Definer with an explicit role guard, because it carries what a customer wrote
 * about their own project and the join to project and PM names. Dealers and
 * customers get nothing from it.
 */
create or replace view public.feedback_verbatims
with (security_invoker = false) as
select f.id, f.project_id, p.name as project_name, p.code as project_code,
       f.stage::text as stage, f.score, f.nps, f.comment, f.tags,
       f.channel, f.responded_at,
       coalesce(pr.full_name, pr.email) as pm_name,
       d.name as dealer_name,
       f.task_id,
       t.resolved_at as task_resolved_at
  from public.stage_feedback f
  join public.projects p on p.id = f.project_id
  left join public.profiles pr on pr.id = f.attributed_pm
  left join public.dealers d on d.id = f.attributed_dealer
  left join public.project_tasks t on t.id = f.task_id
 where f.responded_at is not null
   and (select app.current_user_role()) in ('admin', 'ops');

grant select on public.feedback_verbatims to authenticated;

/**
 * A project's rolling rating (§8), for the project card and the dealer portal.
 *
 * This is the dealer's whole view of the module: an average and a count for
 * their own projects, with no comment column in it to leak.
 *
 * Definer with its own guard, not security_invoker — that was the first attempt
 * and it gave the dealer nothing at all. The policy that would have applied is
 * the one on stage_feedback, which admits staff and the project's customer; a
 * dealer reading through it sees no rows to aggregate. So the scoping is written
 * here, once, and the view carries no column a dealer may not see.
 */
create or replace view public.project_csat
with (security_invoker = false) as
select f.project_id,
       count(*) filter (where f.score is not null) as responses,
       round(avg(f.score) filter (where f.score is not null), 2) as avg_score,
       min(f.score) as worst_score,
       count(*) filter (where f.score <= 2 and f.task_id is not null) as low_scores,
       max(f.responded_at) as last_responded_at
  from public.stage_feedback f
 where (select app.current_user_role()) in ('admin', 'ops')
    or app.is_project_customer(f.project_id)
    or exists (
         select 1 from public.projects p
          where p.id = f.project_id
            and p.dealer_id = any (select app.current_dealer_ids())
       )
 group by f.project_id;

grant select on public.project_csat to authenticated;

-- How long low-score tasks take to close, and how many are open (§7): the
-- measure of whether the loop is actually closing.
create or replace view public.feedback_task_stats
with (security_invoker = false) as
select count(*) filter (where t.resolved_at is null) as open_tasks,
       count(*) filter (where t.resolved_at is not null) as closed_tasks,
       round(avg(extract(epoch from (t.resolved_at - t.created_at)) / 86400.0)
             filter (where t.resolved_at is not null), 1) as avg_days_to_close,
       max(extract(epoch from (now() - t.created_at)) / 86400.0)
             filter (where t.resolved_at is null) as oldest_open_days
  from public.project_tasks t
 where t.source = 'feedback'
   and (select app.current_user_role()) in ('admin', 'ops');

grant select on public.feedback_task_stats to authenticated;

-- -----------------------------------------------------------------------------
-- 11. Grants
-- -----------------------------------------------------------------------------

revoke execute on function
  public.request_stage_feedback(uuid, public.project_stage),
  public.record_stage_feedback(uuid, public.project_stage, integer, text),
  public.detail_stage_feedback(uuid, public.project_stage, text[], text),
  public.record_stage_nps(uuid, public.project_stage, integer),
  public.dismiss_stage_feedback(uuid, public.project_stage),
  public.open_feedback_task(uuid),
  public.resolve_project_task(uuid, text),
  public.feedback_email_token(uuid),
  public.record_feedback_by_token(text, integer),
  public.detail_feedback_by_token(text, text[], text),
  public.claim_feedback_emails(integer),
  public.sweep_feedback_comments()
from public, anon;

-- open_feedback_task is deliberately NOT granted: it is called from inside the
-- functions above, and a caller who could reach it directly could raise a task
-- against any project.
grant execute on function
  public.request_stage_feedback(uuid, public.project_stage),
  public.record_stage_feedback(uuid, public.project_stage, integer, text),
  public.detail_stage_feedback(uuid, public.project_stage, text[], text),
  public.record_stage_nps(uuid, public.project_stage, integer),
  public.dismiss_stage_feedback(uuid, public.project_stage),
  public.resolve_project_task(uuid, text),
  public.feedback_email_token(uuid),
  public.record_feedback_by_token(text, integer),
  public.detail_feedback_by_token(text, text[], text),
  public.claim_feedback_emails(integer),
  public.sweep_feedback_comments()
to authenticated;

-- -----------------------------------------------------------------------------
-- 12. Audit
-- -----------------------------------------------------------------------------
-- Ratings are not audited row by row: the row itself is the record, it is
-- written once by the person it belongs to, and a second copy in the audit log
-- would double the storage of the most-written table in the module for no new
-- information. Tasks are audited, because a task being raised, reassigned and
-- closed is exactly the history somebody will want to reconstruct.

drop trigger if exists audit_row on public.project_tasks;
create trigger audit_row after insert or update or delete on public.project_tasks
  for each row execute function app.tg_audit_row();
