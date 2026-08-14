-- =============================================================================
-- 002200 — Report builder (saved reports, schedules, run history, indexes)
-- =============================================================================
-- Implements the "Report builder" spec's persistence. A report is a JSON
-- definition, never SQL: the generator turns it into a parameterised query
-- from whitelisted columns, so nothing user-authored is ever executed.
-- Visibility follows the spec: private, shared with a role, or shared with
-- named users; recipients get read-only access unless they duplicate it.

create table if not exists public.report_definitions (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  description  text,
  definition   jsonb not null default '{}'::jsonb,
  owner_id     uuid not null references public.profiles (id) on delete cascade,
  visibility   text not null default 'private'
    check (visibility in ('private', 'role', 'users')),
  /** Roles the report is shared with when visibility = 'role'. */
  shared_roles text[] not null default '{}',
  /** Profile ids the report is shared with when visibility = 'users'. */
  shared_users uuid[] not null default '{}',
  /** Set on the shipped templates; they are visible to every staff user. */
  is_template  boolean not null default false,
  last_run_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists report_definitions_owner_idx on public.report_definitions (owner_id);
create index if not exists report_definitions_template_idx on public.report_definitions (is_template)
  where is_template;

create table if not exists public.report_schedules (
  id          uuid primary key default gen_random_uuid(),
  report_id   uuid not null references public.report_definitions (id) on delete cascade,
  created_by  uuid not null references public.profiles (id),
  cadence     text not null check (cadence in ('daily', 'weekly', 'monthly')),
  /** 0–6 (Sunday–Saturday) for weekly. */
  days_of_week integer[] not null default '{}',
  /** 1–28 for monthly. */
  day_of_month integer check (day_of_month between 1 and 28),
  /** Minutes past midnight UTC. */
  send_at_minutes integer not null default 420 check (send_at_minutes between 0 and 1439),
  format      text not null default 'xlsx' check (format in ('xlsx', 'csv')),
  recipients  text not null,
  is_active   boolean not null default true,
  last_sent_at timestamptz,
  last_error  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists report_schedules_active_idx on public.report_schedules (is_active)
  where is_active;

-- Run history: who ran or exported which report and when — the record to
-- reach for when a number is disputed.
create table if not exists public.report_runs (
  id         bigint generated always as identity primary key,
  report_id  uuid references public.report_definitions (id) on delete set null,
  report_name text not null,
  ran_by     uuid references public.profiles (id),
  format     text not null check (format in ('preview', 'xlsx', 'csv', 'print', 'schedule')),
  row_count  integer not null default 0,
  duration_ms integer,
  ran_at     timestamptz not null default now()
);

create index if not exists report_runs_report_idx on public.report_runs (report_id, ran_at desc);

-- RLS ------------------------------------------------------------------------
-- Reports are staff furniture: admin/ops/finance read what is theirs, shared
-- with their role, shared with them by name, or shipped as a template.
alter table public.report_definitions enable row level security;
grant select, insert, update, delete on public.report_definitions to authenticated;

drop policy if exists report_definitions_select on public.report_definitions;
create policy report_definitions_select on public.report_definitions
  for select to authenticated
  using (
    (select app.is_admin())
    or owner_id = (select auth.uid())
    or is_template
    or (visibility = 'role' and (select app.current_user_role())::text = any (shared_roles))
    or (visibility = 'users' and (select auth.uid()) = any (shared_users))
  );

drop policy if exists report_definitions_insert on public.report_definitions;
create policy report_definitions_insert on public.report_definitions
  for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and (select app.current_user_role()) in ('admin', 'ops', 'finance')
    and (not is_template or (select app.is_admin()))
  );

-- Shared reports are read-only to recipients: only the owner (or an admin)
-- may change or delete one.
drop policy if exists report_definitions_update on public.report_definitions;
create policy report_definitions_update on public.report_definitions
  for update to authenticated
  using ((select app.is_admin()) or owner_id = (select auth.uid()))
  with check ((select app.is_admin()) or owner_id = (select auth.uid()));

drop policy if exists report_definitions_delete on public.report_definitions;
create policy report_definitions_delete on public.report_definitions
  for delete to authenticated
  using ((select app.is_admin()) or owner_id = (select auth.uid()));

drop trigger if exists set_updated_at on public.report_definitions;
create trigger set_updated_at before update on public.report_definitions
  for each row execute function app.tg_set_updated_at();
drop trigger if exists audit_row on public.report_definitions;
create trigger audit_row after insert or update or delete on public.report_definitions
  for each row execute function app.tg_audit_row();

alter table public.report_schedules enable row level security;
grant select, insert, update, delete on public.report_schedules to authenticated;

drop policy if exists report_schedules_select on public.report_schedules;
create policy report_schedules_select on public.report_schedules
  for select to authenticated
  using (
    (select app.is_admin())
    or created_by = (select auth.uid())
    or exists (select 1 from public.report_definitions r
               where r.id = report_id and r.owner_id = (select auth.uid()))
  );

drop policy if exists report_schedules_write_i on public.report_schedules;
create policy report_schedules_write_i on public.report_schedules
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (select app.current_user_role()) in ('admin', 'ops', 'finance')
  );

drop policy if exists report_schedules_write_u on public.report_schedules;
create policy report_schedules_write_u on public.report_schedules
  for update to authenticated
  using ((select app.is_admin()) or created_by = (select auth.uid()))
  with check ((select app.is_admin()) or created_by = (select auth.uid()));

drop policy if exists report_schedules_delete on public.report_schedules;
create policy report_schedules_delete on public.report_schedules
  for delete to authenticated
  using ((select app.is_admin()) or created_by = (select auth.uid()));

drop trigger if exists set_updated_at on public.report_schedules;
create trigger set_updated_at before update on public.report_schedules
  for each row execute function app.tg_set_updated_at();
drop trigger if exists audit_row on public.report_schedules;
create trigger audit_row after insert or update or delete on public.report_schedules
  for each row execute function app.tg_audit_row();

-- Run history is append-only for staff and readable alongside the report.
alter table public.report_runs enable row level security;
grant select, insert on public.report_runs to authenticated;

drop policy if exists report_runs_select on public.report_runs;
create policy report_runs_select on public.report_runs
  for select to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops', 'finance'));

drop policy if exists report_runs_insert on public.report_runs;
create policy report_runs_insert on public.report_runs
  for insert to authenticated
  with check ((select app.current_user_role()) in ('admin', 'ops', 'finance', 'dealer'));

-- Indexes for what reports group by (spec §9: 'index what people group by').
create index if not exists projects_sales_rep_idx on public.projects (sales_rep_id);
create index if not exists projects_assigned_pm_idx on public.projects (assigned_pm);
create index if not exists projects_status_stage_idx on public.projects (status, stage);
create index if not exists projects_created_at_idx on public.projects (created_at desc);
create index if not exists stage7_completion_date_idx on public.stage7_complete (completion_date);
create index if not exists stage6_pto_received_idx on public.stage6_inspection (pto_received_date);
create index if not exists stage3_permit_dates_idx on public.stage3_permit (permit_applied_date, permit_received_date);
create index if not exists stage5_install_completed_idx on public.stage5_install (install_completed_date);
create index if not exists project_stage_events_to_stage_idx on public.project_stage_events (to_stage, changed_at desc);
create index if not exists commissions_status_idx on public.commissions (status);

-- The shipped templates live in the app's registry (src/lib/reports/templates.ts)
-- so they version with the code; they are offered to every staff user from the
-- library screen and become saved reports only when someone saves one.
