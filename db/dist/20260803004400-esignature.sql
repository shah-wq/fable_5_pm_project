-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · newest module · step 12 of 14 · 20260803004400_esignature.sql
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
-- Each break is where one script adds something the next one uses, which
-- PostgreSQL will not allow inside a single pasted transaction.
--
-- Behind by more than this module? Run every db/dist/catch-up-*.sql in order
-- instead — they cover everything from 001400 onwards.
-- ============================================================================

-- >>> 20260803004400_esignature.sql
-- =============================================================================
-- E-signature: contracts and change orders signed through PandaDoc
-- =============================================================================
-- A contract can now be sent to the homeowner to sign instead of being marked
-- signed by hand, and a change order can be sent the same way. What happens
-- when the signature lands is exactly what happens today when somebody signs
-- by hand, because it is the same function:
--
--   contract      public.sign_contact() with the system the rep entered when
--                 sending — the project is created, the contact is held —
--                 and the signed PDF is filed on the deal and the project as
--                 the signed installation agreement.
--   change order  the change order is approved, its amount is added to the
--                 project's contract value, and the signed PDF is filed on
--                 the project and linked from the change order.
--
-- One row per document sent, in public.esign_envelopes. Nobody writes to that
-- table directly: every change goes through the functions below, so the
-- permission rules are the ones signing already has (the sales team for a
-- contract, the project's staff for a change order).
--
-- Completion is idempotent. PandaDoc retries webhooks, the embedded signing
-- screen reports completion to the browser as well, and a person can press
-- Check status — all three can arrive for the same document, and only the
-- first does anything.
--
-- Nothing here talks to PandaDoc. The application does that; the database
-- records what it was told and applies the outcome.
-- =============================================================================

do $$
begin
  if to_regprocedure('public.sign_contact(uuid, jsonb, uuid, text)') is null then
    raise exception 'Run 20260803004100_signing_creates_project.sql first — it adds signing.';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 1. Settings: which PandaDoc templates to use
-- -----------------------------------------------------------------------------
-- The API key and the webhook key are secrets and live in the environment
-- (PANDADOC_API_KEY, PANDADOC_WEBHOOK_KEY), never in the database. The
-- templates are not secrets, and an admin changes them, so they live here.
alter table public.app_settings
  add column if not exists pandadoc_contract_template     text,
  add column if not exists pandadoc_change_order_template text,
  add column if not exists pandadoc_signer_role           text not null default 'Client';

-- -----------------------------------------------------------------------------
-- 2. Envelopes
-- -----------------------------------------------------------------------------
create table if not exists public.esign_envelopes (
  id                   uuid primary key default gen_random_uuid(),
  provider             text not null default 'pandadoc' check (provider in ('pandadoc')),
  provider_document_id text unique,
  purpose              text not null check (purpose in ('contract', 'change_order')),
  client_id            uuid references public.clients (id) on delete cascade,
  deal_id              uuid references public.deals (id) on delete set null,
  project_id           uuid references public.projects (id) on delete cascade,
  change_order_id      uuid references public.change_orders (id) on delete cascade,
  -- The provider's state, in our words. 'completed' means signed by everyone;
  -- whether we have acted on it yet is applied_at.
  status               text not null default 'preparing'
                       check (status in ('preparing', 'sent', 'viewed', 'completed',
                                         'declined', 'voided', 'failed')),
  delivery             text not null default 'email' check (delivery in ('email', 'embedded')),
  signer_name          text,
  signer_email         text not null,
  -- For a contract: the signing form as the rep sent it — what sign_contact()
  -- receives when the homeowner signs.
  payload              jsonb not null default '{}'::jsonb,
  note                 text,
  signed_object_id     uuid references storage.objects (id) on delete set null,
  document_id          uuid references public.documents (id) on delete set null,
  outcome              jsonb,
  last_error           text,
  created_by           uuid references public.profiles (id),
  created_at           timestamptz not null default now(),
  sent_at              timestamptz,
  viewed_at            timestamptz,
  completed_at         timestamptz,
  applied_at           timestamptz,
  updated_at           timestamptz not null default now(),
  constraint esign_envelopes_subject check (
    (purpose = 'contract' and client_id is not null)
    or (purpose = 'change_order' and change_order_id is not null and project_id is not null))
);

create index if not exists esign_envelopes_client_idx on public.esign_envelopes (client_id);
create index if not exists esign_envelopes_project_idx on public.esign_envelopes (project_id);
create index if not exists esign_envelopes_co_idx on public.esign_envelopes (change_order_id);
-- One document out for signature per subject at a time.
create unique index if not exists esign_envelopes_one_open_contract
  on public.esign_envelopes (client_id)
  where purpose = 'contract' and status in ('preparing', 'sent', 'viewed');
create unique index if not exists esign_envelopes_one_open_co
  on public.esign_envelopes (change_order_id)
  where purpose = 'change_order' and status in ('preparing', 'sent', 'viewed');

drop trigger if exists set_updated_at on public.esign_envelopes;
create trigger set_updated_at before update on public.esign_envelopes
  for each row execute function app.tg_set_updated_at();
drop trigger if exists audit_row on public.esign_envelopes;
create trigger audit_row after insert or update or delete on public.esign_envelopes
  for each row execute function app.tg_audit_row();

alter table public.esign_envelopes enable row level security;
revoke all on public.esign_envelopes from public, anon;
grant select on public.esign_envelopes to authenticated;

drop policy if exists esign_envelopes_select on public.esign_envelopes;
create policy esign_envelopes_select on public.esign_envelopes
  for select to authenticated
  using (
    (purpose = 'contract' and app.is_sales_staff())
    or (purpose = 'change_order' and app.is_project_staff(project_id))
  );

-- -----------------------------------------------------------------------------
-- 3. Who may act on an envelope
-- -----------------------------------------------------------------------------
create or replace function app.can_act_on_envelope(p_purpose text, p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_purpose
           when 'contract' then app.is_sales_staff()
           when 'change_order' then app.is_project_staff(p_project)
           else false
         end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Opening one
-- -----------------------------------------------------------------------------
/**
 * Record a document about to be sent. Returns the envelope id; the application
 * then creates the document in PandaDoc and reports back with esign_mark().
 *
 * A contract is checked the way signing checks it, before anybody is emailed:
 * the contact must not already have a project, and the three fields a project
 * cannot be made without must be in the payload. Finding out after the
 * homeowner has signed would be the worst time.
 */
create or replace function public.esign_open(
  p_purpose      text,
  p_client       uuid,
  p_deal         uuid,
  p_change_order uuid,
  p_signer_name  text,
  p_signer_email text,
  p_delivery     text,
  p_payload      jsonb,
  p_note         text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id      uuid;
  v_project uuid;
  v_co      public.change_orders%rowtype;
  v_held    text;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
begin
  if p_signer_email is null or p_signer_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'the signer needs a valid email address' using errcode = '22023';
  end if;
  if coalesce(p_delivery, 'email') not in ('email', 'embedded') then
    raise exception 'unknown delivery %', p_delivery using errcode = '22023';
  end if;

  if p_purpose = 'contract' then
    if not app.is_sales_staff() then
      raise exception 'only the sales team may send a contract' using errcode = '42501';
    end if;
    if not exists (select 1 from public.clients c where c.id = p_client) then
      raise exception 'that contact no longer exists' using errcode = 'P0002';
    end if;
    select cp.project_code into v_held from public.contact_project(p_client) cp;
    if v_held is not null then
      raise exception 'this contact is already signed — project % holds them', v_held
        using errcode = '55000';
    end if;
    if coalesce((v_payload ->> 'system_size_kw')::numeric, 0) <= 0 then
      raise exception 'a signed contract needs a system size' using errcode = '22023';
    end if;
    if coalesce(v_payload ->> 'dealer_id', '') = '' then
      raise exception 'the project needs a dealer' using errcode = '22023';
    end if;
    if coalesce(btrim(v_payload ->> 'address'), '') in ('', 'Address to be confirmed') then
      raise exception 'the project needs a site address' using errcode = '22023';
    end if;
    if exists (select 1 from public.esign_envelopes e
                where e.client_id = p_client and e.purpose = 'contract'
                  and e.status in ('preparing', 'sent', 'viewed')) then
      raise exception 'a contract is already out for signature for this contact — void it first'
        using errcode = '23505';
    end if;

    insert into public.esign_envelopes
      (purpose, client_id, deal_id, signer_name, signer_email, delivery, payload, note, created_by)
    values
      ('contract', p_client, p_deal, nullif(btrim(p_signer_name), ''), lower(btrim(p_signer_email)),
       coalesce(p_delivery, 'email'), v_payload, p_note, (select auth.uid()))
    returning id into v_id;

    perform public.log_audit_event(
      'esign.sent', 'esign_envelopes', v_id::text, null,
      jsonb_build_object('purpose', 'contract', 'signer', lower(btrim(p_signer_email))),
      'email', p_deal, p_client);

  elsif p_purpose = 'change_order' then
    select * into v_co from public.change_orders co where co.id = p_change_order for update;
    if not found then
      raise exception 'that change order no longer exists' using errcode = 'P0002';
    end if;
    v_project := v_co.project_id;
    if not app.is_project_staff(v_project) then
      raise exception 'only the project team may send a change order' using errcode = '42501';
    end if;
    if v_co.status not in ('draft', 'pending_approval', 'rejected') then
      raise exception 'a % change order cannot be sent for signature', v_co.status
        using errcode = '22023';
    end if;
    if exists (select 1 from public.esign_envelopes e
                where e.change_order_id = p_change_order
                  and e.status in ('preparing', 'sent', 'viewed')) then
      raise exception 'this change order is already out for signature — void it first'
        using errcode = '23505';
    end if;

    insert into public.esign_envelopes
      (purpose, project_id, change_order_id, client_id, signer_name, signer_email, delivery,
       note, created_by)
    values
      ('change_order', v_project, p_change_order,
       (select p.client_id from public.projects p where p.id = v_project),
       nullif(btrim(p_signer_name), ''), lower(btrim(p_signer_email)),
       coalesce(p_delivery, 'email'), p_note, (select auth.uid()))
    returning id into v_id;

    update public.change_orders set status = 'pending_approval' where id = p_change_order;

    perform app.write_audit('change_order.sent', 'change_orders', p_change_order::text, v_project,
      null, null, jsonb_build_object('number', v_co.number, 'signer', lower(btrim(p_signer_email))));
  else
    raise exception 'unknown purpose %', p_purpose using errcode = '22023';
  end if;

  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. What PandaDoc said
-- -----------------------------------------------------------------------------
/**
 * Record the provider's document id or a change in its state. States only move
 * forward: a late 'viewed' after 'completed' changes nothing, and nothing
 * leaves 'completed'.
 */
create or replace function public.esign_mark(
  p_envelope    uuid,
  p_provider_id text,
  p_status      text,
  p_error       text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_env  public.esign_envelopes%rowtype;
  v_rank constant jsonb := '{"preparing":0,"sent":1,"viewed":2,"declined":3,"voided":3,"failed":3,"completed":4}';
begin
  select * into v_env from public.esign_envelopes e where e.id = p_envelope for update;
  if not found then
    raise exception 'that envelope no longer exists' using errcode = 'P0002';
  end if;
  if not app.can_act_on_envelope(v_env.purpose, v_env.project_id) then
    raise exception 'not allowed to change this envelope' using errcode = '42501';
  end if;
  if p_status is not null and not (v_rank ? p_status) then
    raise exception 'unknown status %', p_status using errcode = '22023';
  end if;

  if p_provider_id is not null and v_env.provider_document_id is null then
    update public.esign_envelopes set provider_document_id = p_provider_id where id = p_envelope;
  end if;

  if p_status is not null
     and v_env.status <> 'completed'
     and (v_rank ->> p_status)::int >= (v_rank ->> v_env.status)::int
     and p_status <> v_env.status then
    update public.esign_envelopes set
      status       = p_status,
      sent_at      = case when p_status in ('sent', 'viewed', 'completed') then coalesce(sent_at, now()) else sent_at end,
      viewed_at    = case when p_status in ('viewed', 'completed') then coalesce(viewed_at, now()) else viewed_at end,
      completed_at = case when p_status = 'completed' then coalesce(completed_at, now()) else completed_at end,
      last_error   = coalesce(p_error, last_error)
    where id = p_envelope;

    if v_env.purpose = 'change_order' and p_status in ('declined', 'voided', 'failed') then
      update public.change_orders
         set status = case when p_status = 'declined' then 'rejected' else 'draft' end::public.change_order_status
       where id = v_env.change_order_id and status = 'pending_approval';
    end if;

    perform public.log_audit_event(
      'esign.' || p_status, 'esign_envelopes', p_envelope::text, v_env.project_id,
      jsonb_build_object('purpose', v_env.purpose, 'error', p_error),
      'system', v_env.deal_id, v_env.client_id);
  elsif p_error is not null then
    update public.esign_envelopes set last_error = p_error where id = p_envelope;
  end if;

  return (select status from public.esign_envelopes where id = p_envelope);
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Who a webhook acts as
-- -----------------------------------------------------------------------------
/**
 * A webhook carries no session. Once the application has checked PandaDoc's
 * signature on it, this says which envelope it is about and who sent that
 * envelope, so the outcome is applied as that person — with their permissions,
 * and in the activity log under their name. Nothing else about the envelope is
 * returned.
 */
create or replace function public.esign_webhook_target(p_provider_id text)
returns table (envelope_id uuid, sender_id uuid, sender_role text, sender_active boolean,
               sender_email text, status text, applied boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, e.created_by, pr.role::text, coalesce(pr.is_active, false), pr.email,
         e.status, e.applied_at is not null
    from public.esign_envelopes e
    left join public.profiles pr on pr.id = e.created_by
   where e.provider_document_id = p_provider_id;
$$;

-- -----------------------------------------------------------------------------
-- 7. Signed
-- -----------------------------------------------------------------------------
/**
 * Everyone has signed: file the PDF and apply the outcome.
 *
 * The PDF is stored first and kept whatever happens next — it is the signed
 * contract. If applying the outcome fails (a contact already moved on, a rule
 * the form did not check), the envelope is left completed but not applied,
 * with the reason in last_error, and pressing Finish on the record runs this
 * again with nothing to download.
 */
create or replace function public.esign_complete(
  p_envelope uuid,
  p_filename text,
  p_data     bytea
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_env      public.esign_envelopes%rowtype;
  v_object   uuid;
  v_path     text;
  v_size     bigint;
  v_name     text;
  v_deal     uuid;
  v_project  uuid;
  v_code     text;
  v_error    text;
  v_doc      uuid;
  v_co       public.change_orders%rowtype;
  v_category text;
  v_outcome  jsonb;
  v_created  boolean := false;
begin
  select * into v_env from public.esign_envelopes e where e.id = p_envelope for update;
  if not found then
    raise exception 'that envelope no longer exists' using errcode = 'P0002';
  end if;
  if not app.can_act_on_envelope(v_env.purpose, v_env.project_id) then
    raise exception 'not allowed to complete this envelope' using errcode = '42501';
  end if;
  if v_env.applied_at is not null then
    return v_env.outcome || jsonb_build_object('already', true);
  end if;
  if v_env.status in ('declined', 'voided') then
    raise exception 'this document was % and cannot be completed', v_env.status
      using errcode = '22023';
  end if;

  -- The signed PDF, once.
  if v_env.signed_object_id is null then
    if p_data is null or octet_length(p_data) = 0 then
      raise exception 'the signed PDF is required' using errcode = '22023';
    end if;
    if octet_length(p_data) > 26214400 then
      raise exception 'the signed PDF is larger than 25 MB' using errcode = '22023';
    end if;
    v_name := coalesce(nullif(regexp_replace(coalesce(p_filename, ''), '[^\w.\-]+', '_', 'g'), ''),
                       'signed.pdf');
    v_path := 'esign/' || p_envelope || '/'
              || floor(extract(epoch from clock_timestamp()) * 1000)::bigint || '-' || right(v_name, 100);
    insert into storage.objects (bucket_id, name, owner)
    values ('project-deliverables', v_path, (select auth.uid()))
    returning id into v_object;
    insert into storage.object_data (object_id, data) values (v_object, p_data);
    update public.esign_envelopes set signed_object_id = v_object where id = p_envelope;
    v_env.signed_object_id := v_object;
  end if;
  select o.name into v_path from storage.objects o where o.id = v_env.signed_object_id;
  select octet_length(od.data) into v_size from storage.object_data od
   where od.object_id = v_env.signed_object_id;

  if v_env.purpose = 'contract' then
    v_category := 'signed_installation_agreement';
    select cp.project_id, cp.project_code into v_project, v_code
      from public.contact_project(v_env.client_id) cp;
    if v_project is not null then
      -- Signed by hand while the document was out: the project is there
      -- already, and the PDF joins it.
      select d.id into v_deal from public.deals d where d.project_id = v_project limit 1;
    else
      begin
        select s.signed_deal_id, s.signed_project_id, s.signed_project_code, s.deal_created
          into v_deal, v_project, v_code, v_created
          from public.sign_contact(
                 v_env.client_id, v_env.payload,
                 (select d.id from public.deals d
                   where d.id = v_env.deal_id and d.stage not in ('won', 'lost')),
                 coalesce(v_env.note, 'Signed in PandaDoc')) s;
      exception when others then
        v_error := sqlerrm;
      end;
    end if;
    if v_deal is null then
      -- Somewhere for the PDF to live even when signing could not finish.
      select d.id into v_deal from public.deals d
       where d.client_id = v_env.client_id order by d.updated_at desc limit 1;
    end if;
    v_outcome := jsonb_build_object('project_id', v_project, 'project_code', v_code,
                                    'deal_id', v_deal, 'deal_created', v_created);
  else
    v_category := 'change_order';
    v_project := v_env.project_id;
    select * into v_co from public.change_orders co where co.id = v_env.change_order_id for update;
    if not found then
      v_error := 'the change order was deleted before it was signed';
    elsif v_co.status <> 'approved' then
      update public.change_orders set
        status      = 'approved',
        approved_by = (select auth.uid()),
        approved_at = now()
      where id = v_co.id;
      update public.projects p
         set contract_value = coalesce(p.contract_value, 0) + v_co.amount_delta
       where p.id = v_project;
      perform app.write_audit('change_order.signed', 'change_orders', v_co.id::text, v_project,
        null, null, jsonb_build_object('number', v_co.number, 'amount_delta', v_co.amount_delta,
                                       'via', 'pandadoc'));
    end if;
    v_outcome := jsonb_build_object('project_id', v_project, 'change_order_id', v_env.change_order_id,
                                    'amount_delta', v_co.amount_delta,
                                    'contract_value',
                                    (select p.contract_value from public.projects p where p.id = v_project));
  end if;

  -- File it where the rest of the paperwork is.
  if v_env.document_id is null and (v_project is not null or v_deal is not null) then
    insert into public.documents
      (project_id, deal_id, bucket, object_path, kind, category, title, mime_type, size_bytes,
       customer_visible, uploaded_by)
    values
      (v_project, v_deal, 'project-deliverables', v_path, 'pdf'::public.document_kind, v_category,
       coalesce(nullif(p_filename, ''), 'Signed document.pdf'), 'application/pdf', v_size,
       false, (select auth.uid()))
    returning id into v_doc;
    update public.esign_envelopes set document_id = v_doc where id = p_envelope;
    if v_env.purpose = 'change_order' and v_co.id is not null then
      update public.change_orders set document_id = v_doc where id = v_co.id;
    end if;
  else
    v_doc := v_env.document_id;
  end if;
  v_outcome := v_outcome || jsonb_build_object('document_id', v_doc);

  update public.esign_envelopes set
    status       = 'completed',
    completed_at = coalesce(completed_at, now()),
    applied_at   = case when v_error is null then now() else null end,
    outcome      = v_outcome,
    last_error   = v_error,
    project_id   = coalesce(project_id, v_project),
    deal_id      = coalesce(deal_id, v_deal)
  where id = p_envelope;

  perform public.log_audit_event(
    case when v_error is null then 'esign.completed' else 'esign.needs_attention' end,
    'esign_envelopes', p_envelope::text, v_project,
    v_outcome || jsonb_build_object('purpose', v_env.purpose, 'error', v_error),
    'system', v_deal, v_env.client_id);

  return v_outcome || jsonb_build_object('error', v_error);
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Change orders, created on the project
-- -----------------------------------------------------------------------------
create or replace function public.create_change_order(
  p_project      uuid,
  p_reason       text,
  p_description  text,
  p_amount_delta numeric,
  p_requires_signature boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id     uuid;
  v_number integer;
begin
  if not app.is_project_staff(p_project) then
    raise exception 'only the project team may raise a change order' using errcode = '42501';
  end if;
  if not exists (select 1 from public.projects p where p.id = p_project) then
    raise exception 'that project no longer exists' using errcode = 'P0002';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a change order needs a reason' using errcode = '22023';
  end if;
  if p_amount_delta is null then
    raise exception 'a change order needs an amount (0 when the price does not change)'
      using errcode = '22023';
  end if;

  -- The company's numbering (Admin → Settings: prefix and next number), taken
  -- and advanced in one statement — the row lock serialises two people raising
  -- one at once. Skipped past any number this project already has, so an admin
  -- resetting the counter cannot collide with (project_id, number).
  update public.app_settings s set co_next_number = greatest(
           s.co_next_number,
           (select coalesce(max(co.number), 0) + 1 from public.change_orders co
             where co.project_id = p_project)) + 1
   where s.id
  returning s.co_next_number - 1 into v_number;
  if v_number is null then
    select coalesce(max(co.number), 0) + 1 into v_number
      from public.change_orders co where co.project_id = p_project;
  end if;

  insert into public.change_orders
    (project_id, number, status, reason, description, amount_delta,
     requires_customer_signature, requested_by)
  values
    (p_project, v_number, 'draft', btrim(p_reason), nullif(btrim(p_description), ''),
     round(p_amount_delta, 2), coalesce(p_requires_signature, true), (select auth.uid()))
  returning id into v_id;

  perform app.write_audit('change_order.created', 'change_orders', v_id::text, p_project,
    null, null, jsonb_build_object('number', v_number, 'amount_delta', round(p_amount_delta, 2)));
  return v_id;
end;
$$;

/**
 * Approve a change order without e-signature — one that needs no customer
 * signature, or one signed on paper. Admin and ops only; applies the amount
 * exactly as a signed one does.
 */
create or replace function public.approve_change_order(p_change_order uuid, p_note text default null)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_co public.change_orders%rowtype;
  v_value numeric;
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'only admin or ops may approve a change order by hand' using errcode = '42501';
  end if;
  select * into v_co from public.change_orders co where co.id = p_change_order for update;
  if not found then
    raise exception 'that change order no longer exists' using errcode = 'P0002';
  end if;
  if v_co.status = 'approved' then
    raise exception 'that change order is already approved' using errcode = '22023';
  end if;
  if v_co.status = 'void' then
    raise exception 'a void change order cannot be approved' using errcode = '22023';
  end if;
  if exists (select 1 from public.esign_envelopes e
              where e.change_order_id = p_change_order and e.status in ('preparing', 'sent', 'viewed')) then
    raise exception 'this change order is out for signature — void that first' using errcode = '23505';
  end if;

  update public.change_orders set status = 'approved', approved_by = (select auth.uid()),
         approved_at = now() where id = p_change_order;
  update public.projects p set contract_value = coalesce(p.contract_value, 0) + v_co.amount_delta
   where p.id = v_co.project_id
  returning p.contract_value into v_value;
  perform app.write_audit('change_order.approved', 'change_orders', p_change_order::text,
    v_co.project_id, null, null,
    jsonb_build_object('number', v_co.number, 'amount_delta', v_co.amount_delta,
                       'via', 'manual', 'note', p_note));
  return v_value;
end;
$$;

/** Void a draft or pending change order; an approved one is history. */
create or replace function public.void_change_order(p_change_order uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_co public.change_orders%rowtype;
begin
  select * into v_co from public.change_orders co where co.id = p_change_order for update;
  if not found then
    raise exception 'that change order no longer exists' using errcode = 'P0002';
  end if;
  if not app.is_project_staff(v_co.project_id) then
    raise exception 'only the project team may void a change order' using errcode = '42501';
  end if;
  if v_co.status = 'approved' then
    raise exception 'an approved change order cannot be voided — raise a new one to reverse it'
      using errcode = '22023';
  end if;
  update public.change_orders set status = 'void' where id = p_change_order;
  update public.esign_envelopes set status = 'voided'
   where change_order_id = p_change_order and status in ('preparing', 'sent', 'viewed');
  perform app.write_audit('change_order.voided', 'change_orders', p_change_order::text,
    v_co.project_id, null, null, jsonb_build_object('number', v_co.number));
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. The templates, for the people who send
-- -----------------------------------------------------------------------------
-- app_settings is readable by admin and ops only, and a sales rep sending a
-- contract needs to know which template to use. This hands over exactly that
-- and the company name printed on it — nothing else in the settings row.
drop function if exists public.esign_settings();
create function public.esign_settings()
returns table (contract_template text, change_order_template text, signer_role text,
               company_name text, co_prefix text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.pandadoc_contract_template, s.pandadoc_change_order_template,
         coalesce(nullif(btrim(s.pandadoc_signer_role), ''), 'Client'), s.company_name,
         s.co_prefix
    from public.app_settings s
   where s.id and app.current_user_role() in ('admin', 'ops', 'sales');
$$;

revoke execute on function public.esign_settings() from public, anon;
grant execute on function public.esign_settings() to authenticated;

revoke execute on function app.can_act_on_envelope(text, uuid) from public, anon;
revoke execute on function public.esign_open(text, uuid, uuid, uuid, text, text, text, jsonb, text) from public, anon;
revoke execute on function public.esign_mark(uuid, text, text, text) from public, anon;
revoke execute on function public.esign_webhook_target(text) from public, anon;
revoke execute on function public.esign_complete(uuid, text, bytea) from public, anon;
revoke execute on function public.create_change_order(uuid, text, text, numeric, boolean) from public, anon;
revoke execute on function public.approve_change_order(uuid, text) from public, anon;
revoke execute on function public.void_change_order(uuid) from public, anon;
grant execute on function app.can_act_on_envelope(text, uuid) to authenticated;
grant execute on function public.esign_open(text, uuid, uuid, uuid, text, text, text, jsonb, text) to authenticated;
grant execute on function public.esign_mark(uuid, text, text, text) to authenticated;
grant execute on function public.esign_webhook_target(text) to authenticated;
grant execute on function public.esign_complete(uuid, text, bytea) to authenticated;
grant execute on function public.create_change_order(uuid, text, text, numeric, boolean) to authenticated;
grant execute on function public.approve_change_order(uuid, text) to authenticated;
grant execute on function public.void_change_order(uuid) to authenticated;

