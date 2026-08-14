-- =============================================================================
-- 001900 — Dealer Portal (leads, commissions, per-field dealer visibility)
-- =============================================================================
-- Implements the "Dealer Portal" spec: a read-only surface over PM-entered
-- data, scoped in the database (RLS) to the dealer's own projects. The only
-- dealer write paths are lead submission and their own account settings.

-- Leads — a dealer's submission lands in a queue the PM reviews; it never
-- creates a project directly.
create table if not exists public.leads (
  id                   uuid primary key default gen_random_uuid(),
  dealer_id            uuid not null references public.dealers (id),
  submitted_by         uuid references public.profiles (id),
  customer_first       text not null,
  customer_last        text not null,
  customer_email       text,
  customer_phone       text,
  address              text not null,
  sales_rep_name       text,
  estimated_size_kw    numeric(6,2),
  cash_or_financing_id uuid references public.cash_financing_options (id),
  notes                text,
  status               text not null default 'submitted'
    check (status in ('submitted', 'under_review', 'converted', 'declined')),
  declined_reason      text,
  converted_project_id uuid references public.projects (id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (customer_email is not null or customer_phone is not null)
);

create index if not exists leads_dealer_idx on public.leads (dealer_id, created_at desc);
create index if not exists leads_status_idx on public.leads (status) where status in ('submitted', 'under_review');

alter table public.leads enable row level security;
grant select, insert, update on public.leads to authenticated;
drop policy if exists leads_select on public.leads;
create policy leads_select on public.leads
  for select to authenticated
  using (
    (select app.current_user_role()) in ('admin', 'ops')
    or dealer_id in (select app.current_dealer_ids())
  );
drop policy if exists leads_insert on public.leads;
create policy leads_insert on public.leads
  for insert to authenticated
  with check (
    (select app.current_user_role()) in ('admin', 'ops')
    or (dealer_id in (select app.current_dealer_ids()) and status = 'submitted')
  );
-- Only the PM team moves a lead through review/convert/decline.
drop policy if exists leads_update on public.leads;
create policy leads_update on public.leads
  for update to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops'))
  with check ((select app.current_user_role()) in ('admin', 'ops'));
drop trigger if exists set_updated_at on public.leads;
create trigger set_updated_at before update on public.leads
  for each row execute function app.tg_set_updated_at();
drop trigger if exists audit_row on public.leads;
create trigger audit_row after insert or update or delete on public.leads
  for each row execute function app.tg_audit_row();

-- Commissions — one row per project, set by an admin (nothing automatic).
-- History comes from the audit_row trigger: every change with date + actor.
create table if not exists public.commissions (
  project_id   uuid primary key references public.projects (id) on delete cascade,
  base_amount  numeric(12,2) not null default 0,
  adjustment   numeric(12,2) not null default 0,
  status       text not null default 'pending'
    check (status in ('pending', 'payable', 'paid')),
  payable_date date,
  paid_date    date,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.commissions enable row level security;
grant select, insert, update, delete on public.commissions to authenticated;
drop policy if exists commissions_select on public.commissions;
create policy commissions_select on public.commissions
  for select to authenticated using (app.can_access_project(project_id));
drop policy if exists commissions_write_i on public.commissions;
create policy commissions_write_i on public.commissions
  for insert to authenticated with check ((select app.is_admin()));
drop policy if exists commissions_write_u on public.commissions;
create policy commissions_write_u on public.commissions
  for update to authenticated
  using ((select app.is_admin())) with check ((select app.is_admin()));
drop policy if exists commissions_delete on public.commissions;
create policy commissions_delete on public.commissions
  for delete to authenticated using ((select app.is_admin()));
drop trigger if exists set_updated_at on public.commissions;
create trigger set_updated_at before update on public.commissions
  for each row execute function app.tg_set_updated_at();
drop trigger if exists audit_row on public.commissions;
create trigger audit_row after insert or update or delete on public.commissions
  for each row execute function app.tg_audit_row();

-- Per-field dealer visibility — a flag per stage field, editable in Admin
-- (Active = visible to dealers), never hardcoded. Cost/margin fields and
-- free-text PM notes are additionally hard-hidden in code regardless.
create table if not exists public.dealer_visible_fields (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,   -- column name on the stage table
  label      text not null,
  stage      text not null,          -- stage key the field belongs to
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.dealer_visible_fields enable row level security;
grant select, insert, update, delete on public.dealer_visible_fields to authenticated;
drop policy if exists dealer_visible_fields_select on public.dealer_visible_fields;
create policy dealer_visible_fields_select on public.dealer_visible_fields
  for select to authenticated using (true);
drop policy if exists dealer_visible_fields_write_i on public.dealer_visible_fields;
create policy dealer_visible_fields_write_i on public.dealer_visible_fields
  for insert to authenticated with check ((select app.is_admin()));
drop policy if exists dealer_visible_fields_write_u on public.dealer_visible_fields;
create policy dealer_visible_fields_write_u on public.dealer_visible_fields
  for update to authenticated
  using ((select app.is_admin())) with check ((select app.is_admin()));
drop policy if exists dealer_visible_fields_delete on public.dealer_visible_fields;
create policy dealer_visible_fields_delete on public.dealer_visible_fields
  for delete to authenticated using ((select app.is_admin()));
drop trigger if exists set_updated_at on public.dealer_visible_fields;
create trigger set_updated_at before update on public.dealer_visible_fields
  for each row execute function app.tg_set_updated_at();
drop trigger if exists audit_row on public.dealer_visible_fields;
create trigger audit_row after insert or update or delete on public.dealer_visible_fields
  for each row execute function app.tg_audit_row();

-- Defaults from spec §5 — everything not listed stays hidden.
insert into public.dealer_visible_fields (stage, name, label) values
  ('survey', 'survey_status', 'Site Survey Status'),
  ('survey', 'survey_completed_date', 'Site Survey Completed Date'),
  ('survey', 'down_payment_status', 'Down Payment Status'),
  ('survey', 'down_payment_received_date', 'Down Payment Received Date'),
  ('survey', 'cash_m1_status', 'Cash M1 Status'),
  ('survey', 'cash_m1_received_date', 'Cash M1 Received Date'),
  ('design', 'design_status', 'Design Status'),
  ('design', 'design_requested_date', 'Design Requested Date'),
  ('design', 'design_received_date', 'Designs Received Date'),
  ('design', 'stamps_status', 'Stamps Status'),
  ('design', 'stamps_received_date', 'Stamps Received Date'),
  ('permits', 'permit_status', 'Permit Status'),
  ('permits', 'permit_applied_date', 'Permit Applied Date'),
  ('permits', 'permit_received_date', 'Permit Received Date'),
  ('permits', 'ica_status', 'ICA Status'),
  ('permits', 'ica_applied_date', 'ICA Applied Date'),
  ('permits', 'ica_received_date', 'ICA Received Date'),
  ('permits', 'hoa_status', 'HOA Status'),
  ('permits', 'hoa_applied_date', 'HOA Applied Date'),
  ('permits', 'hoa_received_date', 'HOA Received Date'),
  ('permits', 'cash_m2_status', 'Cash M2 Status'),
  ('permits', 'cash_m2_received_date', 'Cash M2 Received Date'),
  ('permits', 'hdm_ntp_status', 'HDM NTP Status'),
  ('permits', 'hdm_ntp_approved_date', 'HDM NTP Approved Date'),
  ('procurement', 'material_status', 'Material Status'),
  ('procurement', 'material_requested_date', 'Material Requested Date'),
  ('procurement', 'material_delivered_date', 'Material Delivered Date'),
  ('install', 'install_status', 'Installation Status'),
  ('install', 'install_scheduled_date', 'Install Scheduled Date'),
  ('install', 'install_completed_date', 'Install Completed Date'),
  ('install', 'cash_m3_status', 'Cash M3 Status'),
  ('install', 'cash_m3_received_date', 'Cash M3 Received Date'),
  ('install', 'm1_status', 'Finance M1 Status'),
  ('install', 'm1_approved_date', 'Finance M1 Approved Date'),
  ('inspection_pto', 'inspection_status', 'Inspection Status'),
  ('inspection_pto', 'inspection_completed_date', 'Inspection Completed Date'),
  ('inspection_pto', 'pto_status', 'PTO Status'),
  ('inspection_pto', 'pto_applied_date', 'PTO Applied Date'),
  ('inspection_pto', 'pto_received_date', 'PTO Received Date'),
  ('inspection_pto', 'energization_status', 'Energization Status'),
  ('inspection_pto', 'energization_date', 'Energization Date'),
  ('inspection_pto', 'm2_status', 'Finance M2 Status'),
  ('inspection_pto', 'm2_approved_date', 'Finance M2 Approved Date'),
  ('complete', 'completion_status', 'Completion Status'),
  ('complete', 'completion_date', 'Project Completion Date')
on conflict (name) do nothing;

-- Optional per-company rep scoping: when on, a dealer login whose email
-- matches a sales rep sees only projects where they are the rep; logins with
-- no matching rep (the owner, managers) still see the whole book.
alter table public.dealers
  add column if not exists reps_see_own_only boolean not null default false;

-- Dealers download only dealer-appropriate documents: the signed contract,
-- permit approval letters, the PTO letter, and completion photos. Everything
-- else (plan sets, internal engineering docs) stays PM-side. This tightens
-- public.read_document from 001100/001400.
create or replace function public.read_document(p_document_id uuid)
returns table (
  title      text,
  mime_type  text,
  size_bytes bigint,
  data       bytea
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents%rowtype;
begin
  select d.* into v_doc from public.documents d where d.id = p_document_id;
  if not found then
    return;
  end if;

  if not app.can_access_project(v_doc.project_id) then
    return;
  end if;
  if app.current_user_role() = 'customer' and not v_doc.customer_visible then
    return;
  end if;
  if app.current_user_role() = 'dealer'
     and not (coalesce(v_doc.category, '') = any (array['signed_co', 'signature_docs',
                                                        'pto_letter', 'photo_completion'])
              or coalesce(v_doc.category, '') like 'permit_letter_%') then
    return;
  end if;
  if v_doc.bucket = 'project-dwg' and not app.is_project_staff(v_doc.project_id) then
    return;
  end if;

  return query
    select v_doc.title, v_doc.mime_type, v_doc.size_bytes, od.data
    from storage.objects o
    join storage.object_data od on od.object_id = o.id
    where o.bucket_id = v_doc.bucket and o.name = v_doc.object_path;
end;
$$;
