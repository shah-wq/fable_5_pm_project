-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · newest module · step 3 of 10 · 20260803003500_deals.sql
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
-- Each break is where one script adds something the next one uses, which
-- PostgreSQL will not allow inside a single pasted transaction.
--
-- Behind by more than this module? Run every db/dist/catch-up-*.sql in order
-- instead — they cover everything from 001400 onwards.
-- ============================================================================

-- >>> 20260803003500_deals.sql
-- =============================================================================
-- Modules 16–19 · Part 5 and Part 9 — deals, proposals and the Won handoff
-- =============================================================================
-- 003400 gave deals their columns. This gives them the two things that cannot
-- live in the application: an activity writer that can attribute a row to a
-- deal or a person, and a conversion that either produces a project and a won
-- deal together or produces neither.
--
-- Part 9: "Transactional. If the project insert fails the deal does not move and
-- the user is told why. A half-converted deal is the worst available state and
-- is prevented at the database rather than repaired by a support script."
-- =============================================================================

do $$
begin
  if to_regclass('public.deals') is null then
    raise exception 'Run 20260803003400_crm_foundation.sql first — it creates deals.'
      using hint = 'If that file refuses too, this database is behind by more than one module: run db/dist/catch-up-1.sql, then catch-up-2.sql, then catch-up-3.sql, each as its own execution. They carry everything from 001400 onwards and are safe on a database that already has some of it.';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 1. The activity writer, extended
-- -----------------------------------------------------------------------------
-- The existing five-argument log_audit_event stays exactly as it is: every
-- caller in the product uses it and none of them knows about deals. This is an
-- overload, so a CRM caller can attribute a row to a deal or a person and get
-- the same immutability, the same actor resolution and the same table.
create or replace function public.log_audit_event(
  p_action      text,
  p_entity_type text,
  p_entity_id   text,
  p_project_id  uuid,
  p_context     jsonb,
  p_kind        text,
  p_deal_id     uuid,
  p_client_id   uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if p_kind is not null and p_kind not in
     ('call', 'email', 'sms', 'meeting', 'note', 'form', 'download',
      'login', 'system', 'field_change', 'stage_move') then
    raise exception 'unknown activity kind %', p_kind using errcode = '22023';
  end if;

  insert into public.audit_log
    (actor_id, actor_role, action, entity_type, entity_id, project_id, context,
     kind, deal_id, client_id)
  values
    ((select auth.uid()), app.current_user_role(), p_action, p_entity_type,
     p_entity_id, p_project_id, coalesce(p_context, '{}'::jsonb),
     coalesce(p_kind, 'field_change'), p_deal_id, p_client_id)
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function
  public.log_audit_event(text, text, text, uuid, jsonb, text, uuid, uuid) from public, anon;
grant execute on function
  public.log_audit_event(text, text, text, uuid, jsonb, text, uuid, uuid) to authenticated;

-- The CRM half of the timeline has to be readable by the people who write it.
-- audit_log is admin-only, and deliberately so — it is the tamper-evident record
-- of who changed what. But Part 3 puts the deal timeline in that same table
-- ("One log renders the project audit trail, the customer Activity tab and the
-- deal timeline"), and a timeline only an admin can read is not a timeline. So
-- the rows that belong to a deal or a person are readable by the staff who work
-- them; everything else stays exactly as locked as it was.
drop policy if exists audit_log_select_crm on public.audit_log;
create policy audit_log_select_crm on public.audit_log
  for select to authenticated
  using (
    (deal_id is not null or client_id is not null)
    and app.is_sales_staff()
  );

-- Contact is a fact about the deal, not only a row in the log. Part 5 gates the
-- move out of New on it, and that gate has to be answerable from the deal row:
-- a board that asks the audit log per card would be both slow and — for anyone
-- who cannot read that table — wrong.
alter table public.deals
  add column if not exists first_contact_at timestamptz,
  add column if not exists last_contact_at  timestamptz,
  add column if not exists contact_count    integer not null default 0;

/**
 * Log an interaction against a deal, and record what it proves.
 *
 * `p_reached` is the difference between a conversation and an attempt: "A
 * voicemail is an attempt, logged as an activity; the deal stays in New."
 */
create or replace function public.log_deal_contact(
  p_deal    uuid,
  p_kind    text,
  p_note    text,
  p_reached boolean
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client uuid;
  v_id     bigint;
begin
  if not app.is_sales_staff() then
    raise exception 'only the sales team may log against a deal' using errcode = '42501';
  end if;

  select client_id into v_client from public.deals where id = p_deal;
  if not found then
    raise exception 'that deal no longer exists' using errcode = 'P0002';
  end if;

  v_id := public.log_audit_event(
    p_note, 'deals', p_deal::text, null,
    jsonb_build_object('reached', coalesce(p_reached, false)),
    case when coalesce(p_reached, false) then p_kind else 'note' end,
    p_deal, v_client);

  if coalesce(p_reached, false) then
    update public.deals
       set first_contact_at = coalesce(first_contact_at, now()),
           last_contact_at = now(),
           contact_count = contact_count + 1
     where id = p_deal;
  end if;

  return v_id;
end;
$$;

revoke execute on function public.log_deal_contact(uuid, text, text, boolean) from public, anon;
grant execute on function public.log_deal_contact(uuid, text, text, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Proposals are versioned, never overwritten (Part 5)
-- -----------------------------------------------------------------------------
-- "Versioned rows, not overwrites, each with its document, sent and viewed
-- dates. 'What did we quote them in March?' has to have an answer."
create or replace function public.add_proposal(
  p_deal        uuid,
  p_gross       numeric,
  p_incentives  numeric,
  p_net         numeric,
  p_monthly     numeric,
  p_document    uuid,
  p_notes       text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version integer;
  v_id      uuid;
begin
  if not app.is_sales_staff() then
    raise exception 'only the sales team may quote a deal' using errcode = '42501';
  end if;
  if not exists (select 1 from public.deals d where d.id = p_deal) then
    raise exception 'that deal no longer exists' using errcode = 'P0002';
  end if;

  select coalesce(max(version), 0) + 1 into v_version
    from public.proposals where deal_id = p_deal;

  insert into public.proposals
    (deal_id, version, document_id, gross_price, incentives, net_price,
     monthly_payment, notes, created_by)
  values
    (p_deal, v_version, p_document, p_gross, p_incentives, p_net,
     p_monthly, p_notes, (select auth.uid()))
  returning id into v_id;

  -- The previous version is superseded rather than deleted, so the history
  -- reads as a sequence of offers instead of a single mutable number.
  update public.proposals
     set superseded_by_id = v_id
   where deal_id = p_deal and version = v_version - 1;

  -- The deal's headline price follows its newest proposal.
  update public.deals
     set gross_price = coalesce(p_gross, gross_price),
         incentives = coalesce(p_incentives, incentives),
         net_price = coalesce(p_net, net_price),
         monthly_payment = coalesce(p_monthly, monthly_payment)
   where id = p_deal;

  return v_id;
end;
$$;

revoke execute on function
  public.add_proposal(uuid, numeric, numeric, numeric, numeric, uuid, text) from public, anon;
grant execute on function
  public.add_proposal(uuid, numeric, numeric, numeric, numeric, uuid, text) to authenticated;

/** Marking a proposal sent is its own step: a draft is not an offer. */
create or replace function public.mark_proposal_sent(p_proposal uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  if not app.is_sales_staff() then
    raise exception 'only the sales team may send a proposal' using errcode = '42501';
  end if;
  update public.proposals set sent_at = coalesce(sent_at, now())
   where id = p_proposal
  returning sent_at into v_at;
  if not found then
    raise exception 'that proposal no longer exists' using errcode = 'P0002';
  end if;
  return v_at;
end;
$$;

revoke execute on function public.mark_proposal_sent(uuid) from public, anon;
grant execute on function public.mark_proposal_sent(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 2b. A document can belong to a deal or a dealer, not only a project (Part 3)
-- -----------------------------------------------------------------------------
-- "Module 5 already does versioning and per-document visibility flags defaulting
-- to hidden. Proposals, contracts and dealer agreements are documents with a
-- deal_id or dealer_id instead of a project_id. On conversion, the signed
-- contract already sits where the project expects it — no copy, no second store,
-- no divergent visibility rules."
--
-- Which needs project_id to be nullable. It has been NOT NULL since 000200,
-- because until now every document was about a job.
alter table public.documents
  add column if not exists deal_id   uuid references public.deals (id) on delete cascade,
  add column if not exists dealer_id uuid references public.dealers (id) on delete cascade;

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'documents'
                and column_name = 'project_id' and is_nullable = 'NO') then
    alter table public.documents alter column project_id drop not null;
  end if;

  -- A document still has to be about something. Without this, a null in every
  -- relation makes a file nobody can find and nobody can delete.
  if not exists (select 1 from pg_constraint where conname = 'documents_belong_somewhere') then
    alter table public.documents
      add constraint documents_belong_somewhere
      check (project_id is not null or deal_id is not null or dealer_id is not null);
  end if;
end
$$;

create index if not exists documents_deal_idx on public.documents (deal_id);
create index if not exists documents_dealer_idx on public.documents (dealer_id);

-- The existing policies are all written against project_id, and a null there
-- fails app.can_access_project() — so these are *additional* permissive
-- policies covering the two new owners. The project rules are untouched.
drop policy if exists documents_select_crm on public.documents;
create policy documents_select_crm on public.documents
  for select to authenticated
  using (
    ((deal_id is not null or dealer_id is not null) and app.is_sales_staff())
    -- A dealer sees their own agreements and their own submissions' documents,
    -- under the same hard exclusions the portal already applies.
    or (dealer_id is not null and dealer_id in (select app.current_dealer_ids()))
    or (deal_id is not null and exists (
          select 1 from public.deals d
           where d.id = documents.deal_id
             and d.dealer_id in (select app.current_dealer_ids())))
  );

drop policy if exists documents_write_crm on public.documents;
create policy documents_write_crm on public.documents
  for all to authenticated
  using ((deal_id is not null or dealer_id is not null) and app.is_sales_staff())
  with check ((deal_id is not null or dealer_id is not null) and app.is_sales_staff());

-- -----------------------------------------------------------------------------
-- 3. Won becomes a project, or nothing happens (Part 9)
-- -----------------------------------------------------------------------------
create or replace function public.convert_deal_to_project(
  p_deal  uuid,
  p_stage public.project_stage default 'survey'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  d           public.deals;
  v_client    uuid;
  v_address   text;
  v_project   uuid;
  v_name      text;
begin
  if not app.is_sales_staff() then
    raise exception 'only the sales team may convert a deal' using errcode = '42501';
  end if;

  select * into d from public.deals where id = p_deal for update;
  if not found then
    raise exception 'that deal no longer exists' using errcode = 'P0002';
  end if;

  -- Idempotent: a second press of a button that already worked returns the
  -- project it already made rather than making another one.
  if d.project_id is not null then
    return d.project_id;
  end if;

  -- The person is the same clients row, "whose lifecycle flips from prospect to
  -- customer with no copying at all". A deal that arrived as a dealer
  -- submission may have no person yet, so one is created from what it carries.
  v_client := d.client_id;
  if v_client is null then
    if coalesce(btrim(d.customer_first), '') = ''
       or coalesce(btrim(d.customer_last), '') = '' then
      raise exception 'a project needs a first and last name' using errcode = '23514';
    end if;
    insert into public.clients (dealer_id, first_name, last_name, email, phone, source_id)
    values (d.dealer_id, btrim(d.customer_first), btrim(d.customer_last),
            d.customer_email, d.customer_phone, d.source_id)
    returning id into v_client;

    if d.customer_email is not null then
      insert into public.client_channels (client_id, kind, value, value_normalised, is_primary)
      values (v_client, 'email', d.customer_email, '', true)
      on conflict do nothing;
    end if;
    if d.customer_phone is not null then
      insert into public.client_channels (client_id, kind, value, value_normalised, is_primary)
      values (v_client, 'phone', d.customer_phone, '', true)
      on conflict do nothing;
    end if;

    update public.deals set client_id = v_client where id = p_deal;
  end if;

  -- "Property address becomes site address."
  select coalesce(a.lines, d.address) into v_address
    from (select 1) _
    left join public.client_addresses a on a.id = d.property_address_id;
  if coalesce(btrim(v_address), '') = '' then
    raise exception 'a project needs a site address' using errcode = '23514';
  end if;

  if d.dealer_id is null then
    raise exception 'a project needs a dealer' using errcode = '23514';
  end if;

  select c.first_name || ' ' || c.last_name into v_name
    from public.clients c where c.id = v_client;

  -- Everything the proposal already decided pre-fills the specification, and
  -- the contract value becomes the contract total. Nothing else is required:
  -- "a Friday-evening signature is never blocked by a missing module selection".
  insert into public.projects
    (name, address, dealer_id, client_id, stage, status, contract_value,
     system_size_kw, module_type_id, inverter_type_id, battery_type_id,
     battery_quantity, financing_company_id, utility_id, deal_id, created_by)
  values
    (v_name, btrim(v_address), d.dealer_id, v_client, p_stage, 'active',
     coalesce(d.contract_value, d.net_price),
     d.system_size_kw, d.module_id, d.inverter_id, d.battery_id,
     d.battery_qty, d.financing_company_id, d.utility_id, p_deal,
     (select auth.uid()))
  returning id into v_project;

  -- "Documents are already filed and simply gain the project relation." No
  -- copying, no second store: the same row, one more foreign key.
  update public.documents
     set project_id = v_project
   where project_id is null
     and deal_id = p_deal;

  update public.deals
     set project_id = v_project,
         stage = 'won',
         won_at = coalesce(won_at, now()),
         client_id = v_client
   where id = p_deal;

  perform public.log_audit_event(
    'deal.converted', 'deals', p_deal::text, v_project,
    jsonb_build_object('project_id', v_project, 'client_id', v_client),
    'stage_move', p_deal, v_client);

  return v_project;
end;
$$;

revoke execute on function public.convert_deal_to_project(uuid, public.project_stage)
  from public, anon;
grant execute on function public.convert_deal_to_project(uuid, public.project_stage)
  to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Attribution does not move (Part 6, Part 9)
-- -----------------------------------------------------------------------------
-- "Originating dealer company and submitting user recorded on every deal and
-- carried to the project, editable afterwards only by an admin with a reason.
-- Commission and performance reporting both depend on this not moving."
create or replace function app.tg_project_deal_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.deal_id is not null and new.deal_id is distinct from old.deal_id
     and not app.is_admin() then
    raise exception 'a project''s originating deal cannot be changed'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists project_deal_immutable on public.projects;
create trigger project_deal_immutable before update on public.projects
  for each row execute function app.tg_project_deal_immutable();

-- A won deal is read-only apart from the fields that describe its outcome.
create or replace function app.tg_deal_won_readonly()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.stage = 'won' and not app.is_admin() then
    if new.stage is distinct from old.stage then
      raise exception 'a deal cannot be un-won — cancel the project instead'
        using errcode = '42501';
    end if;
    if new.contract_value is distinct from old.contract_value
       or new.client_id is distinct from old.client_id
       or new.dealer_id is distinct from old.dealer_id then
      raise exception 'a won deal''s contract and attribution are fixed'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists deal_won_readonly on public.deals;
create trigger deal_won_readonly before update on public.deals
  for each row execute function app.tg_deal_won_readonly();

-- -----------------------------------------------------------------------------
-- 5. The board's roll-ups (Part 5: "Column headers carry count and total value")
-- -----------------------------------------------------------------------------
create or replace view public.deal_stage_totals
with (security_invoker = true) as
select d.stage,
       count(*) as deals,
       sum(coalesce(d.contract_value, d.net_price, 0)) as total_value,
       sum(coalesce(d.contract_value, d.net_price, 0)
           * coalesce(d.probability, 0) / 100.0) as weighted_value
  from public.deals d
 group by d.stage;

grant select on public.deal_stage_totals to authenticated;

-- Deals needing action: no next action, or one that is due (Part 5). The same
-- shape as the project board's attention list, computed the same way.
create or replace view public.deals_needing_action
with (security_invoker = true) as
select d.id, d.code, d.stage, d.owner_id, d.next_action, d.next_action_at,
       coalesce(c.first_name || ' ' || c.last_name,
                nullif(btrim(coalesce(d.customer_first, '') || ' ' ||
                             coalesce(d.customer_last, '')), ''),
                'Unnamed') as person_name,
       case when d.next_action is null or d.next_action_at is null then 'no next action'
            else 'next action due' end as reason
  from public.deals d
  left join public.clients c on c.id = d.client_id
 where d.stage not in ('won', 'lost')
   and (d.next_action is null
        or d.next_action_at is null
        or d.next_action_at <= current_date);

grant select on public.deals_needing_action to authenticated;

