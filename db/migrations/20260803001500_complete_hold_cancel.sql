-- =============================================================================
-- 001500 — Stage 7 (Complete) + Hold & Cancelled side stages
-- =============================================================================
-- Adds the terminal Complete stage and the two side stages that any project
-- can enter from any stage, bypassing validation (a customer pulls out or a
-- site fails mid-stage — these moves must never be blocked). Origin stage is
-- stored on both side records so resume/reinstate restore the project exactly.
-- Held/cancelled projects are excluded from active counts but never deleted.

alter type public.project_stage add value if not exists 'complete' after 'inspection_pto';

-- Stage 7 · Complete (terminal; filled once the project lands here) ----------
create table if not exists public.stage7_complete (
  project_id uuid primary key references public.projects (id) on delete cascade,
  completion_status text not null default 'complete'
    check (completion_status in ('complete', 'complete_with_open_items')),
  completion_date date,
  completion_notes text,
  final_drive_updated boolean not null default false,
  final_drive_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Hold — re-entrant: one row per hold, current hold = the row with no
-- resume_date. Days-excluding-hold is derivable by summing resolved holds.
create table if not exists public.project_holds (
  id                  bigint generated always as identity primary key,
  project_id          uuid not null references public.projects (id) on delete cascade,
  reason              text not null,
  notes               text not null,
  hold_start_date     date not null default current_date,
  expected_resume_date date,
  stage_held_from     public.project_stage not null,
  resume_date         date,
  created_by          uuid references public.profiles (id),
  created_at          timestamptz not null default now()
);

create index if not exists project_holds_open_idx on public.project_holds (project_id) where resume_date is null;

-- Cancelled — one record per project (reinstatable). stage_cancelled_from is
-- the single most useful figure for where projects are lost.
create table if not exists public.project_cancellation (
  project_id               uuid primary key references public.projects (id) on delete cascade,
  reason                   text not null,
  notes                    text not null,
  cancellation_date        date not null default current_date,
  stage_cancelled_from     public.project_stage not null,
  refund_required          boolean not null default false,
  refund_status            text check (refund_status in ('not_required', 'pending', 'processed')),
  refund_amount            numeric(12,2),
  equipment_return_required boolean not null default false,
  drive_updated            boolean not null default false,
  reinstated_at            timestamptz,
  created_by               uuid references public.profiles (id),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- RLS + audit + updated_at.
alter table public.stage7_complete enable row level security;
grant select, insert, update, delete on public.stage7_complete to authenticated;
drop policy if exists stage7_complete_select on public.stage7_complete;
create policy stage7_complete_select on public.stage7_complete
  for select to authenticated using (app.can_access_project(project_id));
drop policy if exists stage7_complete_write_i on public.stage7_complete;
create policy stage7_complete_write_i on public.stage7_complete
  for insert to authenticated with check (app.is_project_staff(project_id));
drop policy if exists stage7_complete_write_u on public.stage7_complete;
create policy stage7_complete_write_u on public.stage7_complete
  for update to authenticated using (app.is_project_staff(project_id)) with check (app.is_project_staff(project_id));
drop policy if exists stage7_complete_delete on public.stage7_complete;
create policy stage7_complete_delete on public.stage7_complete
  for delete to authenticated using ((select app.is_admin()));
drop trigger if exists set_updated_at on public.stage7_complete;
create trigger set_updated_at before update on public.stage7_complete
  for each row execute function app.tg_set_updated_at();
drop trigger if exists audit_row on public.stage7_complete;
create trigger audit_row after insert or update or delete on public.stage7_complete
  for each row execute function app.tg_audit_row();

alter table public.project_holds enable row level security;
grant select, insert, update, delete on public.project_holds to authenticated;
drop policy if exists project_holds_select on public.project_holds;
create policy project_holds_select on public.project_holds
  for select to authenticated using (app.can_access_project(project_id));
drop policy if exists project_holds_write_i on public.project_holds;
create policy project_holds_write_i on public.project_holds
  for insert to authenticated with check (app.is_project_staff(project_id));
drop policy if exists project_holds_write_u on public.project_holds;
create policy project_holds_write_u on public.project_holds
  for update to authenticated using (app.is_project_staff(project_id)) with check (app.is_project_staff(project_id));
drop policy if exists project_holds_delete on public.project_holds;
create policy project_holds_delete on public.project_holds
  for delete to authenticated using ((select app.is_admin()));
drop trigger if exists audit_row on public.project_holds;
create trigger audit_row after insert or update or delete on public.project_holds
  for each row execute function app.tg_audit_row();

alter table public.project_cancellation enable row level security;
grant select, insert, update, delete on public.project_cancellation to authenticated;
drop policy if exists project_cancellation_select on public.project_cancellation;
create policy project_cancellation_select on public.project_cancellation
  for select to authenticated using (app.can_access_project(project_id));
drop policy if exists project_cancellation_write_i on public.project_cancellation;
create policy project_cancellation_write_i on public.project_cancellation
  for insert to authenticated with check (app.is_project_staff(project_id));
drop policy if exists project_cancellation_write_u on public.project_cancellation;
create policy project_cancellation_write_u on public.project_cancellation
  for update to authenticated using (app.is_project_staff(project_id)) with check (app.is_project_staff(project_id));
drop policy if exists project_cancellation_delete on public.project_cancellation;
create policy project_cancellation_delete on public.project_cancellation
  for delete to authenticated using ((select app.is_admin()));
drop trigger if exists set_updated_at on public.project_cancellation;
create trigger set_updated_at before update on public.project_cancellation
  for each row execute function app.tg_set_updated_at();
drop trigger if exists audit_row on public.project_cancellation;
create trigger audit_row after insert or update or delete on public.project_cancellation
  for each row execute function app.tg_audit_row();
