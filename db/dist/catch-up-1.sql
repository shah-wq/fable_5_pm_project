-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · catch-up 1 of 2 · newest migration: 20260803003100_typical_durations.sql
--
-- Paste this whole file into a SQL console (e.g. the Neon SQL Editor) and run
-- it. Safe to run more than once: every statement below skips work already
-- done, so 'already exists' errors cannot happen. NOTICE lines saying
-- 'does not exist, skipping' are normal.
--
-- Run catch-up 1 first, then catch-up 2, each as its own execution.
-- Includes: 20260803001400_stage_fields.sql, 20260803001500_complete_hold_cancel.sql
-- ============================================================================

-- >>> 20260803001400_stage_fields.sql

-- =============================================================================
-- 001400 — Stage field specification (data-entry forms)
-- =============================================================================
-- Implements the "Stage Field Specification" PDF, which supersedes the earlier
-- breakdown's stage field tables: payment milestones (Down Payment, Cash
-- M1–M3), the five Permit tracks (Permit · ICA · HOA · Cash M2 · HDM NTP),
-- partner-labelled Finance M1/M2 milestones stored ONCE per project, and the
-- Drive Updated gate closing every stage. 'Days' fields are computed from
-- dates at read time — never stored. The old stage tables (built from the
-- earlier draft, empty in every deployment) are replaced.

drop table if exists public.stage_survey;
drop table if exists public.stage_design;
drop table if exists public.stage_procurement;
drop table if exists public.stage_install;
drop table if exists public.stage_inspection;

-- Stage 1 · Site Survey ------------------------------------------------------
create table if not exists public.stage1_survey (
  project_id uuid primary key references public.projects (id) on delete cascade,
  down_payment_status text not null default 'not_requested'
    check (down_payment_status in ('not_requested', 'requested', 'initiated', 'received')),
  down_payment_requested_date date,
  down_payment_initiated_date date,
  down_payment_received_date  date,
  cash_m1_status text not null default 'not_requested'
    check (cash_m1_status in ('not_requested', 'requested', 'initiated', 'received', 'na')),
  cash_m1_requested_date date,
  cash_m1_initiated_date date,
  cash_m1_received_date  date,
  survey_status text not null default 'not_scheduled'
    check (survey_status in ('not_scheduled', 'scheduled', 'completed', 'rescheduled', 'cancelled')),
  survey_completed_date date,
  adders_details text,
  drive_updated boolean not null default false,
  drive_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Stage 2 · Design -----------------------------------------------------------
create table if not exists public.stage2_design (
  project_id uuid primary key references public.projects (id) on delete cascade,
  designer_id uuid references public.designers (id),
  design_status text not null default 'not_requested'
    check (design_status in ('not_requested', 'requested', 'in_progress', 'received', 'revision_requested')),
  design_requested_date date,
  design_received_date  date,
  shading_report_date   date,
  pm_notes text,
  stamps_status text not null default 'not_requested'
    check (stamps_status in ('not_requested', 'requested', 'received', 'na')),
  stamps_requested_date date,
  stamps_received_date  date,
  drive_updated boolean not null default false,
  drive_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Stage 3 · Permit (five tracks, flat columns) --------------------------------
create table if not exists public.stage3_permit (
  project_id uuid primary key references public.projects (id) on delete cascade,
  required_permits text[] not null default '{}',
  permit_status text not null default 'not_applied'
    check (permit_status in ('not_applied', 'applied', 'in_review', 'revision_requested', 'approved', 'rejected')),
  permit_pm_notes       text,
  permit_revision_notes text,
  permit_applied_date   date,
  permit_received_date  date,
  ica_status text not null default 'not_applied'
    check (ica_status in ('not_applied', 'applied', 'in_review', 'revision_requested', 'approved', 'rejected')),
  ica_pm_notes       text,
  ica_revision_notes text,
  ica_applied_date   date,
  ica_received_date  date,
  hoa_status text not null default 'not_applied'
    check (hoa_status in ('na', 'not_applied', 'applied', 'in_review', 'revision_requested', 'approved', 'rejected')),
  hoa_revision_notes text,
  hoa_applied_date   date,
  hoa_received_date  date,
  cash_m2_status text not null default 'not_requested'
    check (cash_m2_status in ('not_requested', 'requested', 'initiated', 'received', 'na')),
  cash_m2_requested_date date,
  cash_m2_initiated_date date,
  cash_m2_received_date  date,
  hdm_ntp_status text not null default 'not_submitted'
    check (hdm_ntp_status in ('not_submitted', 'submitted', 'approved', 'rejected', 'na')),
  hdm_ntp_submitted_date date,
  hdm_ntp_approved_date  date,
  drive_updated boolean not null default false,
  drive_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Stage 4 · Procurement --------------------------------------------------------
create table if not exists public.stage4_procurement (
  project_id uuid primary key references public.projects (id) on delete cascade,
  procurement_manager uuid references public.profiles (id),
  material_status text not null default 'not_requested'
    check (material_status in ('not_requested', 'requested', 'ordered', 'in_transit', 'delivered', 'backordered')),
  material_requested_date date,
  material_delivered_date date,
  pm_notes text,
  drive_updated boolean not null default false,
  drive_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Stage 5 · Installation --------------------------------------------------------
create table if not exists public.stage5_install (
  project_id uuid primary key references public.projects (id) on delete cascade,
  install_manager uuid references public.profiles (id),
  install_status text not null default 'not_scheduled'
    check (install_status in ('not_scheduled', 'requested', 'scheduled', 'in_progress', 'completed', 'on_hold')),
  install_requested_date date,
  install_scheduled_date date,
  install_completed_date date,
  cash_m3_status text not null default 'not_requested'
    check (cash_m3_status in ('not_requested', 'requested', 'initiated', 'received', 'na')),
  cash_m3_requested_date date,
  cash_m3_initiated_date date,
  cash_m3_received_date  date,
  drive_updated boolean not null default false,
  drive_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Stage 6 · Inspection & PTO -----------------------------------------------------
create table if not exists public.stage6_inspection (
  project_id uuid primary key references public.projects (id) on delete cascade,
  inspection_status text not null default 'not_requested'
    check (inspection_status in ('not_requested', 'requested', 'scheduled', 'passed', 'failed', 'reinspection_scheduled')),
  inspection_failed_notes text,
  inspection_requested_date date,
  inspection_completed_date date,
  pm_notes text,
  pto_status text not null default 'not_applied'
    check (pto_status in ('not_applied', 'applied', 'in_review', 'received', 'rejected')),
  pto_applied_date  date,
  pto_received_date date,
  energization_status text not null default 'not_started'
    check (energization_status in ('not_started', 'in_progress', 'energized', 'issue')),
  energization_date date,
  drive_updated boolean not null default false,
  drive_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Finance M1/M2 — ONE field set per project (the label follows the project's
-- finance partner), rendered on the Install and Inspection forms.
create table if not exists public.finance_milestones (
  project_id uuid primary key references public.projects (id) on delete cascade,
  m1_status text not null default 'not_submitted'
    check (m1_status in ('not_submitted', 'submitted', 'approved', 'rejected', 'na')),
  m1_submitted_date date,
  m1_approved_date  date,
  m2_status text not null default 'not_submitted'
    check (m2_status in ('not_submitted', 'submitted', 'approved', 'rejected', 'na')),
  m2_submitted_date date,
  m2_approved_date  date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS + audit + updated_at for all seven, same shape as before: participants
-- read their project's rows, staff (admin/ops) write, deletes admin-only.
do $$
declare
  t text;
begin
  foreach t in array array['stage1_survey', 'stage2_design', 'stage3_permit',
                           'stage4_procurement', 'stage5_install',
                           'stage6_inspection', 'finance_milestones']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists %1$I_select on public.%1$I', t);
    execute format($p$
      create policy %1$I_select on public.%1$I
        for select to authenticated
        using (app.can_access_project(project_id))
    $p$, t);
    execute format('drop policy if exists %1$I_write_i on public.%1$I', t);
    execute format($p$
      create policy %1$I_write_i on public.%1$I
        for insert to authenticated
        with check (app.is_project_staff(project_id))
    $p$, t);
    execute format('drop policy if exists %1$I_write_u on public.%1$I', t);
    execute format($p$
      create policy %1$I_write_u on public.%1$I
        for update to authenticated
        using (app.is_project_staff(project_id))
        with check (app.is_project_staff(project_id))
    $p$, t);
    execute format('drop policy if exists %1$I_delete_admin on public.%1$I', t);
    execute format($p$
      create policy %1$I_delete_admin on public.%1$I
        for delete to authenticated
        using ((select app.is_admin()))
    $p$, t);
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format('create trigger set_updated_at before update on public.%I
                    for each row execute function app.tg_set_updated_at()', t);
    execute format('drop trigger if exists audit_row on public.%I', t);
    execute format('create trigger audit_row after insert or update or delete on public.%I
                    for each row execute function app.tg_audit_row()', t);
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- Staff uploads (shading reports, install pictures) and deletes — governed,
-- audited, byte storage beside the metadata like the grant path.
-- -----------------------------------------------------------------------------

create or replace function public.record_staff_upload(
  p_project_id uuid,
  p_category   text,
  p_filename   text,
  p_mime       text,
  p_data       bytea
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_path text;
  v_object_id uuid;
  v_document_id uuid;
begin
  if not app.is_project_staff(p_project_id) then
    raise exception 'only project staff may upload' using errcode = '42501';
  end if;
  if p_category is null or btrim(p_category) = '' then
    raise exception 'category is required';
  end if;
  if p_mime not in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
                    'application/pdf') then
    raise exception 'only photos and PDFs are accepted';
  end if;
  if p_data is null or octet_length(p_data) = 0 or octet_length(p_data) > 26214400 then
    raise exception 'file must be between 1 byte and 25 MB';
  end if;

  v_name := coalesce(nullif(regexp_replace(coalesce(p_filename, ''), '[^\w.\-]+', '_', 'g'), ''), 'file');
  v_name := right(v_name, 100);
  v_path := p_project_id || '/uploads/' || p_category || '/'
            || floor(extract(epoch from clock_timestamp()) * 1000)::bigint || '-' || v_name;

  insert into storage.objects (bucket_id, name, owner)
  values (case when p_mime = 'application/pdf' then 'project-deliverables' else 'project-photos' end,
          v_path, auth.uid())
  returning id into v_object_id;

  insert into storage.object_data (object_id, data) values (v_object_id, p_data);

  insert into public.documents
    (project_id, bucket, object_path, kind, category, title, mime_type, size_bytes,
     customer_visible, uploaded_by)
  values
    (p_project_id,
     case when p_mime = 'application/pdf' then 'project-deliverables' else 'project-photos' end,
     v_path,
     case when p_mime = 'application/pdf' then 'pdf' else 'photo' end,
     btrim(p_category), p_filename, p_mime, octet_length(p_data), false, auth.uid())
  returning id into v_document_id;

  perform app.write_audit('document.uploaded', 'documents', v_document_id::text, p_project_id,
    null, null, jsonb_build_object('category', p_category, 'filename', p_filename));

  return v_document_id;
end;
$$;

create or replace function public.delete_document(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents%rowtype;
begin
  select d.* into v_doc from public.documents d where d.id = p_document_id;
  if not found then
    raise exception 'document not found';
  end if;
  if not app.is_project_staff(v_doc.project_id) then
    raise exception 'only project staff may delete documents' using errcode = '42501';
  end if;

  delete from storage.objects o where o.bucket_id = v_doc.bucket and o.name = v_doc.object_path;
  delete from public.documents d where d.id = p_document_id;

  perform app.write_audit('document.deleted', 'documents', p_document_id::text, v_doc.project_id,
    null, null, jsonb_build_object('category', v_doc.category, 'filename', v_doc.title));
end;
$$;

revoke execute on function public.record_staff_upload(uuid, text, text, text, bytea) from public, anon;
grant execute on function public.record_staff_upload(uuid, text, text, text, bytea) to authenticated;
revoke execute on function public.delete_document(uuid) from public, anon;
grant execute on function public.delete_document(uuid) to authenticated;



-- >>> 20260803001500_complete_hold_cancel.sql

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


