-- =============================================================================
-- 001200 — Manual version (SolarFlow PM): six stages, stage data model,
--          reference tables, PM-centric permissions
-- =============================================================================
-- Implements the "Manual Version Breakdown" spec: the pipeline is exactly six
-- stages (Survey · Design · Permits · Procurement · Install · Inspection &
-- PTO); every stage form's fields get typed columns now so Module 2 (the
-- forms) and later automation need no further schema work. The PM (ops) runs
-- everything; dealers/customers become read-only on projects.

-- -----------------------------------------------------------------------------
-- 1. Six-stage enum, replacing the 11-phase one (values mapped, not dropped)
-- -----------------------------------------------------------------------------

create type public.project_stage_v2 as enum (
  'survey',
  'design',
  'permits',
  'procurement',
  'install',
  'inspection_pto'
);

-- project_financials selects projects.stage — recreate around the type swap.
drop view public.project_financials;

alter table public.projects alter column stage drop default;

alter table public.projects
  alter column stage type public.project_stage_v2
  using (case stage::text
    when 'intake'          then 'survey'
    when 'site_survey'     then 'survey'
    when 'design'          then 'design'
    when 'design_review'   then 'design'
    when 'engineering'     then 'design'
    when 'permitting'      then 'permits'
    when 'permit_approved' then 'permits'
    when 'installation'    then 'install'
    when 'inspection'      then 'inspection_pto'
    when 'pto'             then 'inspection_pto'
    when 'complete'        then 'inspection_pto'
  end)::public.project_stage_v2;

alter table public.projects alter column stage set default 'survey';

alter table public.project_stage_events
  alter column from_stage type public.project_stage_v2
  using (case from_stage::text
    when 'intake' then 'survey' when 'site_survey' then 'survey'
    when 'design' then 'design' when 'design_review' then 'design' when 'engineering' then 'design'
    when 'permitting' then 'permits' when 'permit_approved' then 'permits'
    when 'installation' then 'install'
    when 'inspection' then 'inspection_pto' when 'pto' then 'inspection_pto' when 'complete' then 'inspection_pto'
  end)::public.project_stage_v2;

alter table public.project_stage_events
  alter column to_stage type public.project_stage_v2
  using (case to_stage::text
    when 'intake' then 'survey' when 'site_survey' then 'survey'
    when 'design' then 'design' when 'design_review' then 'design' when 'engineering' then 'design'
    when 'permitting' then 'permits' when 'permit_approved' then 'permits'
    when 'installation' then 'install'
    when 'inspection' then 'inspection_pto' when 'pto' then 'inspection_pto' when 'complete' then 'inspection_pto'
  end)::public.project_stage_v2;

alter table public.stage_feedback
  alter column stage type public.project_stage_v2
  using (case stage::text
    when 'intake' then 'survey' when 'site_survey' then 'survey'
    when 'design' then 'design' when 'design_review' then 'design' when 'engineering' then 'design'
    when 'permitting' then 'permits' when 'permit_approved' then 'permits'
    when 'installation' then 'install'
    when 'inspection' then 'inspection_pto' when 'pto' then 'inspection_pto' when 'complete' then 'inspection_pto'
  end)::public.project_stage_v2;

drop type public.project_stage;
alter type public.project_stage_v2 rename to project_stage;

create view public.project_financials
with (security_barrier = true, security_invoker = false)
as
select
  p.id, p.code, p.name, p.stage, p.status, p.dealer_id, p.client_id,
  p.system_size_kw, p.contract_value, p.dealer_fee, p.amount_invoiced,
  p.amount_paid, p.target_install_date, p.created_at, p.updated_at
from public.projects p
where app.current_user_role() in ('finance', 'admin');

grant select on public.project_financials to authenticated;
revoke insert, update, delete on public.project_financials from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. Reference tables the stage forms draw dropdowns from
-- -----------------------------------------------------------------------------

create table public.hoas (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  contact    jsonb not null default '{}'::jsonb,
  notes      text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.surveyors (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  phone      text,
  email      text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.crews (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  contact    jsonb not null default '{}'::jsonb,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.finance_partners (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  contact    jsonb not null default '{}'::jsonb,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at before update on public.hoas
  for each row execute function app.tg_set_updated_at();
create trigger set_updated_at before update on public.surveyors
  for each row execute function app.tg_set_updated_at();
create trigger set_updated_at before update on public.crews
  for each row execute function app.tg_set_updated_at();
create trigger set_updated_at before update on public.finance_partners
  for each row execute function app.tg_set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. Project columns the create-form and Projects tab need
-- -----------------------------------------------------------------------------

alter table public.projects
  add column address            text,
  add column finance_partner_id uuid references public.finance_partners (id),
  add column assigned_pm        uuid references public.profiles (id);

create index projects_assigned_pm_idx on public.projects (assigned_pm);

-- Documents gain a category: photo slots (roof, attic, main_panel, meter,
-- wire_path, obstructions, delivery, completion, ...) and document types
-- (plan_set_dwg, plan_set_pdf, stamped_set, signed_co, permit_letter,
-- signature_docs, work_order, inspection_signoff, pto_letter, ...). The
-- stage-requirements engine checks these slots.
alter table public.documents add column category text;
create index documents_project_category_idx on public.documents (project_id, category);

-- -----------------------------------------------------------------------------
-- 4. Stage data tables — one row per project per stage (Module 2's forms
--    write here; requirements validate against them)
-- -----------------------------------------------------------------------------

-- Stage 1 · Site Survey (jurisdiction/utility live on projects)
create table public.stage_survey (
  project_id           uuid primary key references public.projects (id) on delete cascade,
  hoa_applies          boolean,
  hoa_id               uuid references public.hoas (id),
  survey_date          date,
  time_window          text,
  surveyor_id          uuid references public.surveyors (id),
  survey_status        text check (survey_status in ('scheduled', 'completed', 'no_show', 'rescheduled')),
  roof_type            text check (roof_type in ('shingle', 's_tile', 'flat_tile', 'metal')),
  roof_pitch           text,
  main_panel_adequate  boolean,
  main_panel_notes     text,
  wire_run_ft          numeric(8,1),
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Stage 2 · Design & Engineering (plan set versions live in designs/documents;
-- adders in project_adders; the CO in change_orders)
create table public.stage_design (
  project_id           uuid primary key references public.projects (id) on delete cascade,
  designer_id          uuid references public.designers (id),
  assigned_date        date,
  due_date             date,
  adder_approval_date  date,
  new_contract_total   numeric(12,2),
  finance_notified_date date,
  finance_acked_date   date,
  production_kwh       numeric(12,1),
  client_approval_date date,
  pe_stamp_date        date,
  revision_notes       text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Stage 4 · Procurement (BOM lines live in bom_items, extended below)
create table public.stage_procurement (
  project_id           uuid primary key references public.projects (id) on delete cascade,
  total_equipment_cost numeric(12,2),
  delivery_date        date,
  delivery_ok          boolean,
  delivery_issue_notes text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Stage 5 · Installation
create table public.stage_install (
  project_id              uuid primary key references public.projects (id) on delete cascade,
  crew_id                 uuid references public.crews (id),
  start_date              date,
  end_date                date,
  customer_confirmed      boolean,
  customer_confirmed_date date,
  work_order_date         date,
  install_status          text check (install_status in ('scheduled', 'in_progress', 'completed', 'issue')),
  completion_date         date,
  punch_list              text,
  punch_resolved_date     date,
  mid_install_adder       boolean,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- Stage 6 · Inspection & PTO
create table public.stage_inspection (
  project_id          uuid primary key references public.projects (id) on delete cascade,
  inspection_date     date,
  time_window         text,
  crew_confirmed      boolean,
  result              text check (result in ('pass', 'fail')),
  correction_items    text,
  fix_date            date,
  reinspection_date   date,
  pto_submitted_date  date,
  pto_reference       text,
  pto_issued_date     date,
  handoff_done        boolean,
  handoff_date        date,
  commission_payable  boolean,
  commission_amount   numeric(12,2),
  final_notes         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Stage 3 · Permits: per-track columns on the existing permits table
-- (permit_type: 'city_county' | 'hoa' | 'utility')
alter table public.permits
  add column submission_method text check (submission_method in ('solarapp', 'portal', 'email', 'in_person', 'mail')),
  add column reference_no      text,
  add column corrections_notes text,
  add column resubmitted_date  date,
  add column fees_paid_date    date,
  add column followup_date     date;

-- Stage 4 · Procurement: per-line ordering/tracking on BOM lines
alter table public.bom_items
  add column vendor_id   uuid references public.vendors (id),
  add column po_number   text,
  add column order_date  date,
  add column tracking_no text,
  add column carrier     text,
  add column eta         date,
  add column line_status text not null default 'pending'
    check (line_status in ('pending', 'ordered', 'shipped', 'delivered'));

-- -----------------------------------------------------------------------------
-- 5. RLS + audit + updated_at for the new tables
-- -----------------------------------------------------------------------------

do $$
declare
  t text;
begin
  -- Stage data: participants read their project's rows; staff write.
  foreach t in array array['stage_survey', 'stage_design', 'stage_procurement',
                           'stage_install', 'stage_inspection']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format($p$
      create policy %1$I_select on public.%1$I
        for select to authenticated
        using (app.can_access_project(project_id))
    $p$, t);
    execute format($p$
      create policy %1$I_write_i on public.%1$I
        for insert to authenticated
        with check (app.is_project_staff(project_id))
    $p$, t);
    execute format($p$
      create policy %1$I_write_u on public.%1$I
        for update to authenticated
        using (app.is_project_staff(project_id))
        with check (app.is_project_staff(project_id))
    $p$, t);
    execute format($p$
      create policy %1$I_delete_admin on public.%1$I
        for delete to authenticated
        using ((select app.is_admin()))
    $p$, t);
    execute format('create trigger set_updated_at before update on public.%I
                    for each row execute function app.tg_set_updated_at()', t);
    execute format('create trigger audit_row after insert or update or delete on public.%I
                    for each row execute function app.tg_audit_row()', t);
  end loop;

  -- Reference data: staff read; admin+ops manage (the PM can 'add new' from
  -- stage forms); deletes stay admin-only.
  foreach t in array array['hoas', 'surveyors', 'crews', 'finance_partners']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format($p$
      create policy %1$I_select on public.%1$I
        for select to authenticated
        using ((select app.current_user_role()) in ('admin', 'ops', 'designer', 'finance'))
    $p$, t);
    execute format($p$
      create policy %1$I_write_i on public.%1$I
        for insert to authenticated
        with check ((select app.current_user_role()) in ('admin', 'ops'))
    $p$, t);
    execute format($p$
      create policy %1$I_write_u on public.%1$I
        for update to authenticated
        using ((select app.current_user_role()) in ('admin', 'ops'))
        with check ((select app.current_user_role()) in ('admin', 'ops'))
    $p$, t);
    execute format($p$
      create policy %1$I_delete_admin on public.%1$I
        for delete to authenticated
        using ((select app.is_admin()))
    $p$, t);
    execute format('create trigger audit_row after insert or update or delete on public.%I
                    for each row execute function app.tg_audit_row()', t);
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- 6. PM-centric permission adjustments
-- -----------------------------------------------------------------------------

-- The PM (ops) creates projects and clients; dealers keep their own-book
-- intake. Dealers become read-only on existing projects (manual version:
-- portals are read-only; the PM is the single operator).
-- Evaluate project visibility on the row's own columns (not via
-- can_access_project's self-lookup): INSERT … RETURNING must pass the SELECT
-- policy, and a self-lookup can't see the row inside the inserting
-- statement's snapshot. Also one query cheaper on every scan.
drop policy projects_select on public.projects;
create policy projects_select on public.projects
  for select to authenticated
  using (
    (select app.current_user_role()) in ('admin', 'ops')
    or assigned_designer_id = (select app.current_designer_id())
    or dealer_id in (select app.current_dealer_ids())
    or client_id in (select app.current_client_ids())
  );

-- SECURITY DEFINER so the projects policy below doesn't expand the clients
-- policy inline (clients' policy references projects — a direct subquery here
-- would be detected as policy recursion now that projects_select reads its
-- own columns instead of going through a function).
create or replace function app.client_belongs_to_dealer(p_client uuid, p_dealer uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.clients c
    where c.id = p_client and c.dealer_id = p_dealer
  );
$$;

grant execute on function app.client_belongs_to_dealer(uuid, uuid) to authenticated;

drop policy projects_insert on public.projects;
create policy projects_insert on public.projects
  for insert to authenticated
  with check (
    (select app.current_user_role()) in ('admin', 'ops')
    or (
      dealer_id in (select app.current_dealer_ids())
      and app.client_belongs_to_dealer(client_id, dealer_id)
    )
  );

drop policy projects_update on public.projects;
create policy projects_update on public.projects
  for update to authenticated
  using (app.is_project_staff(id))
  with check (app.is_project_staff(id));

drop policy clients_insert on public.clients;
create policy clients_insert on public.clients
  for insert to authenticated
  with check (
    (select app.current_user_role()) in ('admin', 'ops')
    or dealer_id in (select app.current_dealer_ids())
  );

-- 'Add new' from stage forms: jurisdictions/utilities become admin+ops managed.
drop policy jurisdictions_write_admin on public.jurisdictions;
create policy jurisdictions_write on public.jurisdictions
  for all to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops'))
  with check ((select app.current_user_role()) in ('admin', 'ops'));

drop policy utilities_write_admin on public.utilities;
create policy utilities_write on public.utilities
  for all to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops'))
  with check ((select app.current_user_role()) in ('admin', 'ops'));

-- The per-project activity log is the PM's working record: ops reads
-- project-scoped audit rows (global/system rows stay admin-only).
drop policy audit_log_select_admin on public.audit_log;
create policy audit_log_select on public.audit_log
  for select to authenticated
  using (
    (select app.is_admin())
    or ((select app.current_user_role()) = 'ops' and project_id is not null)
  );

-- The PM assigns people: admin+ops can list profiles (PM dropdown), and see
-- designers/surveyors/crews via their own tables.
drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or (select app.current_user_role()) in ('admin', 'ops')
  );
