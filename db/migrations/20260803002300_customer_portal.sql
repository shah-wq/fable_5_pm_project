-- =============================================================================
-- 002300 — Customer portal (plain-language mapping, requests, PM estimate)
-- =============================================================================
-- Implements the "Customer portal" spec: a read-only homeowner surface over
-- the same stage data, with one status-mapping layer so internal vocabulary
-- ('ICA Status: Applied') never reaches a customer, four genuine actions that
-- land as requests in the PM's queue rather than writing stage fields, and
-- an optional PM-set completion estimate (an unset estimate beats a wrong one).

-- One mapping layer, admin-editable, so wording can be tuned without touching
-- the stage forms (spec §9: never render a raw dropdown value here).
create table if not exists public.customer_phrases (
  id         uuid primary key default gen_random_uuid(),
  /** Which vocabulary this belongs to: 'stage', 'stage_explainer',
      'stage_next', or a stage-form column name such as 'permit_status'. */
  domain     text not null,
  /** The internal value, or the stage key for explainer/next rows. */
  value      text not null,
  /** What the homeowner reads. */
  phrase     text not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (domain, value)
);

alter table public.customer_phrases enable row level security;
grant select, insert, update, delete on public.customer_phrases to authenticated;
drop policy if exists customer_phrases_select on public.customer_phrases;
create policy customer_phrases_select on public.customer_phrases
  for select to authenticated using (true);
drop policy if exists customer_phrases_write_i on public.customer_phrases;
create policy customer_phrases_write_i on public.customer_phrases
  for insert to authenticated with check ((select app.is_admin()));
drop policy if exists customer_phrases_write_u on public.customer_phrases;
create policy customer_phrases_write_u on public.customer_phrases
  for update to authenticated
  using ((select app.is_admin())) with check ((select app.is_admin()));
drop policy if exists customer_phrases_delete on public.customer_phrases;
create policy customer_phrases_delete on public.customer_phrases
  for delete to authenticated using ((select app.is_admin()));
drop trigger if exists set_updated_at on public.customer_phrases;
create trigger set_updated_at before update on public.customer_phrases
  for each row execute function app.tg_set_updated_at();
drop trigger if exists audit_row on public.customer_phrases;
create trigger audit_row after insert or update or delete on public.customer_phrases
  for each row execute function app.tg_audit_row();

-- Customer-facing stage names (spec §2: customer-facing names, not internal).
insert into public.customer_phrases (domain, value, phrase) values
  ('stage', 'survey', 'Site Survey'),
  ('stage', 'design', 'Design'),
  ('stage', 'permits', 'Permits'),
  ('stage', 'procurement', 'Equipment'),
  ('stage', 'install', 'Installation'),
  ('stage', 'inspection_pto', 'Inspection & Power On'),
  ('stage', 'complete', 'Complete')
on conflict (domain, value) do nothing;

-- Two or three sentences per stage, in plain language.
insert into public.customer_phrases (domain, value, phrase) values
  ('stage_explainer', 'survey',
   'A technician visits your home to measure the roof, check the electrical panel and take photos. This is what the design is drawn from, so it has to happen before anything else. It usually takes a week or two to schedule and about an hour on site.'),
  ('stage_explainer', 'design',
   'Your system is being drawn: panel layout, wiring and the paperwork the city will review. If an engineering stamp is needed for your city, that is arranged now. This normally takes one to two weeks.'),
  ('stage_explainer', 'permits',
   'Your plans are with the city or county for a building permit, and with your utility for permission to connect to the grid. This is the stage that varies most — some cities answer in days, others take a couple of months. We chase them weekly.'),
  ('stage_explainer', 'procurement',
   'Your panels, inverter and any battery are ordered and on their way to our warehouse. We schedule your installation once we can see the delivery date.'),
  ('stage_explainer', 'install',
   'Your installation is scheduled or under way. Most homes take one or two days, and the crew will need access to your roof, your electrical panel and a water tap. Your power will be off for a short period on the day.'),
  ('stage_explainer', 'inspection_pto',
   'The city inspects the finished work, then your utility gives permission to operate. Once that arrives we switch the system on — that is the moment your system starts producing.'),
  ('stage_explainer', 'complete',
   'Your system is on and producing. Your documents, warranty information and monitoring details are all here whenever you need them.')
on conflict (domain, value) do nothing;

-- 'What happens next' for the current stage.
insert into public.customer_phrases (domain, value, phrase) values
  ('stage_next', 'survey', 'We book your site survey and send you the date to confirm.'),
  ('stage_next', 'design', 'Your designer produces the plan set, then we submit it for permits.'),
  ('stage_next', 'permits', 'We are waiting on the city and your utility, and chasing them weekly.'),
  ('stage_next', 'procurement', 'Your equipment arrives at our warehouse, then we call you to book the installation.'),
  ('stage_next', 'install', 'Our crew completes the installation, then we request the city inspection.'),
  ('stage_next', 'inspection_pto', 'The city inspects, your utility issues permission to operate, and we switch the system on.'),
  ('stage_next', 'complete', 'Nothing outstanding — your project is finished.')
on conflict (domain, value) do nothing;

-- Status vocabularies. Values not listed fall back to a tidied form of the
-- raw value in code, so a new dropdown option can never show as blank.
insert into public.customer_phrases (domain, value, phrase) values
  ('survey_status', 'not_scheduled', 'Being scheduled'),
  ('survey_status', 'scheduled', 'Scheduled'),
  ('survey_status', 'completed', 'Completed'),
  ('survey_status', 'rescheduled', 'Being rescheduled'),
  ('survey_status', 'cancelled', 'Cancelled'),
  ('design_status', 'not_requested', 'Not started yet'),
  ('design_status', 'requested', 'With the designer'),
  ('design_status', 'in_progress', 'Being drawn'),
  ('design_status', 'received', 'Complete'),
  ('design_status', 'revision_requested', 'Being revised'),
  ('stamps_status', 'not_requested', 'Not needed yet'),
  ('stamps_status', 'requested', 'With the engineer'),
  ('stamps_status', 'received', 'Obtained'),
  ('stamps_status', 'na', 'Not required'),
  ('permit_status', 'not_applied', 'Not submitted yet'),
  ('permit_status', 'applied', 'Submitted, awaiting the city'),
  ('permit_status', 'in_review', 'Under review by the city'),
  ('permit_status', 'revision_requested', 'City asked for a change'),
  ('permit_status', 'approved', 'Approved'),
  ('permit_status', 'rejected', 'We are resolving a query with the city'),
  ('ica_status', 'not_applied', 'Not submitted yet'),
  ('ica_status', 'applied', 'Submitted to your utility'),
  ('ica_status', 'in_review', 'Under review by your utility'),
  ('ica_status', 'revision_requested', 'Utility asked for a change'),
  ('ica_status', 'approved', 'Approved by your utility'),
  ('ica_status', 'rejected', 'We are resolving a query with your utility'),
  ('hoa_status', 'na', 'Not required'),
  ('hoa_status', 'not_applied', 'Not submitted yet'),
  ('hoa_status', 'applied', 'Submitted to your HOA'),
  ('hoa_status', 'in_review', 'With your HOA'),
  ('hoa_status', 'revision_requested', 'HOA asked for a change'),
  ('hoa_status', 'approved', 'Approved by your HOA'),
  ('hoa_status', 'rejected', 'We are resolving a query with your HOA'),
  ('material_status', 'not_requested', 'Not ordered yet'),
  ('material_status', 'requested', 'Ordered'),
  ('material_status', 'ordered', 'Ordered'),
  ('material_status', 'in_transit', 'On its way'),
  ('material_status', 'delivered', 'Delivered to our warehouse'),
  ('material_status', 'backordered', 'Delayed by the supplier'),
  ('install_status', 'not_scheduled', 'Being scheduled'),
  ('install_status', 'requested', 'Being scheduled'),
  ('install_status', 'scheduled', 'Scheduled'),
  ('install_status', 'in_progress', 'Under way'),
  ('install_status', 'completed', 'Completed'),
  ('install_status', 'on_hold', 'Paused'),
  ('inspection_status', 'not_requested', 'Not booked yet'),
  ('inspection_status', 'requested', 'Booked with the city'),
  ('inspection_status', 'scheduled', 'Scheduled'),
  ('inspection_status', 'passed', 'Passed'),
  -- A failed inspection reads as the follow-up, never the failure notes.
  ('inspection_status', 'failed', 'A follow-up visit is scheduled'),
  ('inspection_status', 'reinspection_scheduled', 'A follow-up visit is scheduled'),
  ('pto_status', 'not_applied', 'Not submitted yet'),
  ('pto_status', 'applied', 'Submitted to your utility'),
  ('pto_status', 'in_review', 'Under review by your utility'),
  ('pto_status', 'received', 'Granted'),
  ('pto_status', 'rejected', 'We are resolving a query with your utility'),
  ('energization_status', 'not_started', 'Not yet'),
  ('energization_status', 'in_progress', 'In progress'),
  ('energization_status', 'energized', 'Your system is on'),
  ('energization_status', 'issue', 'We are resolving an issue'),
  ('payment_status', 'not_requested', 'Not yet due'),
  ('payment_status', 'requested', 'Requested'),
  ('payment_status', 'initiated', 'In progress'),
  ('payment_status', 'received', 'Received'),
  ('payment_status', 'na', 'Not applicable'),
  ('finance_status', 'not_submitted', 'Not submitted yet'),
  ('finance_status', 'submitted', 'Submitted to your lender'),
  ('finance_status', 'approved', 'Approved by your lender'),
  ('finance_status', 'rejected', 'Needs attention'),
  ('finance_status', 'na', 'Not applicable'),
  ('completion_status', 'complete', 'Complete'),
  ('completion_status', 'complete_with_open_items', 'Complete, with a few items to finish')
on conflict (domain, value) do nothing;

-- The PM's optional completion estimate, shown as given (a month or a range).
alter table public.projects
  add column if not exists customer_estimate text;

-- Customers can silence email without losing portal access (spec §1).
alter table public.clients
  add column if not exists email_opt_out boolean not null default false,
  add column if not exists preferred_contact text
    check (preferred_contact in ('email', 'phone', 'text'));

-- The four customer actions land here — a request queue for the PM, never a
-- write to a stage field. 'Request, not a booking' is the whole point.
create table if not exists public.customer_requests (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  client_id     uuid not null references public.clients (id) on delete cascade,
  kind          text not null check (kind in ('availability', 'question', 'contact_update', 'document')),
  /** Free text from the customer: the question, or the dates they prefer. */
  message       text,
  preferred_dates text,
  time_window   text,
  contact_phone text,
  contact_email text,
  preferred_contact text,
  document_id   uuid references public.documents (id) on delete set null,
  status        text not null default 'open' check (status in ('open', 'resolved')),
  pm_reply      text,
  resolved_by   uuid references public.profiles (id),
  resolved_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists customer_requests_project_idx
  on public.customer_requests (project_id, created_at desc);
create index if not exists customer_requests_open_idx
  on public.customer_requests (status) where status = 'open';

alter table public.customer_requests enable row level security;
grant select, insert, update on public.customer_requests to authenticated;

drop policy if exists customer_requests_select on public.customer_requests;
create policy customer_requests_select on public.customer_requests
  for select to authenticated
  using (
    (select app.current_user_role()) in ('admin', 'ops')
    or client_id in (select app.current_client_ids())
  );

-- A customer may only file against their own project, and only as 'open'.
drop policy if exists customer_requests_insert on public.customer_requests;
create policy customer_requests_insert on public.customer_requests
  for insert to authenticated
  with check (
    (select app.current_user_role()) in ('admin', 'ops')
    or (client_id in (select app.current_client_ids())
        and app.can_access_project(project_id)
        and status = 'open')
  );

-- Only the PM team resolves or replies.
drop policy if exists customer_requests_update on public.customer_requests;
create policy customer_requests_update on public.customer_requests
  for update to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops'))
  with check ((select app.current_user_role()) in ('admin', 'ops'));

drop trigger if exists set_updated_at on public.customer_requests;
create trigger set_updated_at before update on public.customer_requests
  for each row execute function app.tg_set_updated_at();
drop trigger if exists audit_row on public.customer_requests;
create trigger audit_row after insert or update or delete on public.customer_requests
  for each row execute function app.tg_audit_row();

-- Customer uploads (utility bill, HOA paperwork, a photo the PM asked for).
-- Definer, because customers cannot write documents directly; the row is
-- created customer_visible so they can see what they sent, and the PM is
-- notified through a customer_requests row created by the caller.
create or replace function public.record_customer_upload(
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
  v_client uuid;
  v_name text;
  v_path text;
  v_object_id uuid;
  v_document_id uuid;
begin
  select p.client_id into v_client
  from public.projects p
  where p.id = p_project_id
    and p.client_id in (select app.current_client_ids());
  if v_client is null then
    raise exception 'only the homeowner on this project may upload' using errcode = '42501';
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
  v_path := p_project_id || '/customer/' || coalesce(nullif(btrim(p_category), ''), 'customer_upload')
            || '/' || floor(extract(epoch from clock_timestamp()) * 1000)::bigint || '-' || v_name;

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
     (case when p_mime = 'application/pdf' then 'pdf' else 'photo' end)::public.document_kind,
     coalesce(nullif(btrim(p_category), ''), 'customer_upload'),
     p_filename, p_mime, octet_length(p_data), true, auth.uid())
  returning id into v_document_id;

  return v_document_id;
end;
$$;

revoke execute on function public.record_customer_upload(uuid, text, text, text, bytea) from public, anon;
grant execute on function public.record_customer_upload(uuid, text, text, text, bytea) to authenticated;

-- Customers may update their own contact details (the request row notifies the
-- PM rather than silently overwriting expectations).
drop policy if exists clients_update_self on public.clients;
create policy clients_update_self on public.clients
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Agreed adders are part of what the customer is paying (spec §4: adders as
-- line items with the revised total), so the homeowner may read the APPROVED
-- ones on their own project. Unapproved lines stay internal — the portal must
-- never surprise someone with a number nobody agreed to.
drop policy if exists project_adders_select_customer on public.project_adders;
create policy project_adders_select_customer on public.project_adders
  for select to authenticated
  using (
    approved
    and (select app.current_user_role()) = 'customer'
    and app.can_access_project(project_id)
  );
