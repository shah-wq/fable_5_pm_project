-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · newest module · step 5 of 6 · 20260803003700_contact_create.sql
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
-- Each break is where one script adds something the next one uses, which
-- PostgreSQL will not allow inside a single pasted transaction.
--
-- Behind by more than this module? Run every db/dist/catch-up-*.sql in order
-- instead — they cover everything from 001400 onwards.
-- ============================================================================

-- >>> 20260803003700_contact_create.sql
-- =============================================================================
-- Modules 16–19 · creating a contact
-- =============================================================================
-- Contacts is where every person lives — the ones who have signed and the ones
-- who never will. This file adds the last few columns the Create Contact form
-- asks for that had nowhere to go: a salutation, a second email, the consultant
-- working the account, and the campaign attribution a web lead arrives with.
--
-- Everything is additive and nullable, for the same reason as 003600: a form
-- that refuses half-known information is a form people keep in a spreadsheet.
-- =============================================================================

do $$
begin
  if to_regclass('public.deals') is null then
    raise exception 'Run 20260803003400_crm_foundation.sql first — it creates deals.'
      using hint = 'If that file refuses too, this database is behind by more than one module: run db/dist/catch-up-1.sql, then catch-up-2.sql, then catch-up-3.sql, each as its own execution. They carry everything from 001400 onwards and are safe on a database that already has some of it.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'clients'
                    and column_name = 'mailing_street') then
    raise exception 'Run 20260803003600_contact_intake.sql first — it adds the intake fields.'
      using hint = 'If that file refuses too, this database is behind by more than one module: run db/dist/catch-up-1.sql, then catch-up-2.sql, then catch-up-3.sql, each as its own execution. They carry everything from 001400 onwards and are safe on a database that already has some of it.';
  end if;
end
$$;

alter table public.clients
  /** Mr / Ms / Dr. A picklist on the form, free text here: honorifics are not a
      closed set and a check constraint on them ages badly. */
  add column if not exists salutation      text,
  /** A second address for the same person. Kept as a column rather than a
      channel row because the form edits one box; client_channels still holds
      the full set for matching and de-duplication. */
  add column if not exists secondary_email text,
  /** The consultant working the account, which is not always a system user —
      often a subcontracted rep — so this is a name, not a reference. */
  add column if not exists consultant      text,
  -- Where the enquiry came from, as the web form recorded it. source_id is the
  -- tidy internal list; these four are the raw truth from the landing page, and
  -- they are what a marketing spend report has to reconcile against.
  add column if not exists original_source text,
  add column if not exists utm_source      text,
  add column if not exists utm_medium      text,
  add column if not exists utm_campaign    text;

-- -----------------------------------------------------------------------------
-- The one-row-per-contact view, with the new columns
-- -----------------------------------------------------------------------------
-- Dropped and recreated rather than replaced: create or replace view can only
-- append columns, and these belong beside the ones they relate to.
drop view if exists public.contact_intake;

create view public.contact_intake
with (security_invoker = true) as
select c.id as client_id,
       c.salutation, c.first_name, c.last_name,
       c.email, c.secondary_email, c.phone, c.alternate_phone as mobile, c.owner_phone,
       c.mailing_street, c.mailing_city, c.mailing_state,
       c.mailing_postal_code, c.mailing_country, c.description,
       c.consultant, c.original_source, c.utm_source, c.utm_medium, c.utm_campaign,
       coalesce(owner.full_name, owner.email) as contact_owner,
       coalesce(creator.full_name, creator.email) as created_by_name,
       src.name as lead_source,
       dl.name as dealer_name,
       d.id as deal_id, d.code as deal_code, d.stage as lead_status,
       d.system_size_kw, d.module_quantity, d.module_wattage,
       d.battery_qty, d.battery_size_kwh, d.includes_battery,
       d.inverter_size_kw, d.mount_type, d.hoa, d.comparable_brand_ok,
       d.annual_usage_kwh, d.production_estimate_kwh, d.avg_monthly_bill,
       d.gross_price, d.contract_value, d.down_payment, d.amount_financed,
       d.financing_route, d.dealer_code, d.wave_sales_notes,
       d.additional_information, d.reschedule_reason,
       mod.name as module_brand, inv.name as inverter_brand, bat.name as battery_brand,
       fin.name as financing_company, u.name as electric_utility,
       lr.name as lost_reason
  from public.clients c
  left join public.profiles owner on owner.id = c.owner_id
  left join public.profiles creator on creator.id = c.created_by
  left join public.client_sources src on src.id = c.source_id
  left join public.dealers dl on dl.id = c.dealer_id
  left join lateral (
    select * from public.deals dd
     where dd.client_id = c.id
     order by (dd.stage not in ('won', 'lost')) desc, dd.updated_at desc
     limit 1
  ) d on true
  left join public.module_types mod on mod.id = d.module_id
  left join public.inverter_types inv on inv.id = d.inverter_id
  left join public.battery_types bat on bat.id = d.battery_id
  left join public.financing_companies fin on fin.id = d.financing_company_id
  left join public.utilities u on u.id = d.utility_id
  left join public.deal_loss_reasons lr on lr.id = d.lost_reason_id;

grant select on public.contact_intake to authenticated;

-- -----------------------------------------------------------------------------
-- A contact and its first deal, made together
-- -----------------------------------------------------------------------------
/**
 * Create Contact fills in one form and expects one record back, but the answers
 * live in two tables — the person, and the opportunity that carries the system
 * and the money. This makes both in one statement so a failure halfway leaves
 * neither behind, and returns the pair.
 *
 * The deal is only made when there is something to put on it. A contact typed
 * in from a business card is a person and nothing else, and inventing an empty
 * opportunity for them would put a phantom on the board and in the forecast.
 */
create or replace function public.create_contact(
  p_client jsonb,
  p_deal   jsonb default null
)
returns table (client_id uuid, deal_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_client uuid;
  v_deal uuid;
  v_stage text;
begin
  insert into public.clients (
    salutation, first_name, last_name, email, secondary_email, phone, alternate_phone,
    owner_phone, owner_id, source_id, dealer_id, description, consultant,
    original_source, utm_source, utm_medium, utm_campaign,
    mailing_street, mailing_city, mailing_state, mailing_postal_code, mailing_country,
    contact_stage)
  values (
    p_client ->> 'salutation', p_client ->> 'first_name', p_client ->> 'last_name',
    lower(nullif(btrim(coalesce(p_client ->> 'email', '')), '')),
    lower(nullif(btrim(coalesce(p_client ->> 'secondary_email', '')), '')),
    p_client ->> 'phone', p_client ->> 'alternate_phone', p_client ->> 'owner_phone',
    (p_client ->> 'owner_id')::uuid, (p_client ->> 'source_id')::uuid,
    (p_client ->> 'dealer_id')::uuid,
    p_client ->> 'description', p_client ->> 'consultant',
    p_client ->> 'original_source', p_client ->> 'utm_source',
    p_client ->> 'utm_medium', p_client ->> 'utm_campaign',
    p_client ->> 'mailing_street', p_client ->> 'mailing_city', p_client ->> 'mailing_state',
    p_client ->> 'mailing_postal_code', p_client ->> 'mailing_country',
    -- The stage is the contact's own, and a new one starts where they are: on
    -- file. A form that offers it may say otherwise, and anything it does not
    -- recognise falls back rather than failing the insert.
    coalesce(nullif(p_client ->> 'contact_stage', ''), 'created'))
  returning id into v_client;

  -- The channels, so the person is findable by either address and the duplicate
  -- check on the next creation can see them.
  if (p_client ->> 'email') is not null then
    insert into public.client_channels (client_id, kind, value, value_normalised, is_primary)
    values (v_client, 'email', p_client ->> 'email', '', true) on conflict do nothing;
  end if;
  if (p_client ->> 'secondary_email') is not null then
    insert into public.client_channels (client_id, kind, value, value_normalised, is_primary)
    values (v_client, 'email', p_client ->> 'secondary_email', '', false) on conflict do nothing;
  end if;
  if (p_client ->> 'phone') is not null then
    insert into public.client_channels (client_id, kind, value, value_normalised, is_primary)
    values (v_client, 'phone', p_client ->> 'phone', '', true) on conflict do nothing;
  end if;
  if (p_client ->> 'alternate_phone') is not null then
    insert into public.client_channels (client_id, kind, value, value_normalised, is_primary)
    values (v_client, 'phone', p_client ->> 'alternate_phone', '', false) on conflict do nothing;
  end if;

  if p_deal is not null and p_deal <> '{}'::jsonb then
    -- Won and Lost are outcomes, not starting points: Won is reached through
    -- the conversion that creates the project, and Lost needs a reason from the
    -- list. Anything else on the board is a fair place to start.
    v_stage := coalesce(p_deal ->> 'stage', 'new');
    if v_stage not in ('new', 'contacted', 'qualified', 'proposal',
                       'negotiation', 'contract_out') then
      v_stage := 'new';
    end if;

    insert into public.deals (
      client_id, customer_first, customer_last, customer_email, customer_phone,
      address, dealer_id, source_id, owner_id, stage,
      system_size_kw, module_id, module_quantity, module_wattage,
      inverter_id, inverter_size_kw, battery_id, battery_qty, battery_size_kwh,
      mount_type, roof_type_id, hoa, comparable_brand_ok,
      utility_id, avg_monthly_bill, annual_usage_kwh, production_estimate_kwh,
      gross_price, contract_value, down_payment, amount_financed,
      financing_route, financing_company_id, lost_reason_id,
      dealer_code, wave_sales_notes, additional_information, reschedule_reason)
    values (
      v_client, p_client ->> 'first_name', p_client ->> 'last_name',
      lower(nullif(btrim(coalesce(p_client ->> 'email', '')), '')), p_client ->> 'phone',
      coalesce(nullif(btrim(coalesce(p_deal ->> 'address', '')), ''),
               nullif(btrim(concat_ws(', ', p_client ->> 'mailing_street',
                                            p_client ->> 'mailing_city',
                                            p_client ->> 'mailing_state')), ''),
               'Address to be confirmed'),
      (p_client ->> 'dealer_id')::uuid, (p_client ->> 'source_id')::uuid,
      (p_client ->> 'owner_id')::uuid, v_stage,
      (p_deal ->> 'system_size_kw')::numeric, (p_deal ->> 'module_id')::uuid,
      (p_deal ->> 'module_quantity')::integer, (p_deal ->> 'module_wattage')::integer,
      (p_deal ->> 'inverter_id')::uuid, (p_deal ->> 'inverter_size_kw')::numeric,
      (p_deal ->> 'battery_id')::uuid, (p_deal ->> 'battery_qty')::integer,
      (p_deal ->> 'battery_size_kwh')::numeric,
      p_deal ->> 'mount_type', (p_deal ->> 'roof_type_id')::uuid, p_deal ->> 'hoa',
      (p_deal ->> 'comparable_brand_ok')::boolean,
      (p_deal ->> 'utility_id')::uuid, (p_deal ->> 'avg_monthly_bill')::numeric,
      (p_deal ->> 'annual_usage_kwh')::integer, (p_deal ->> 'production_estimate_kwh')::integer,
      (p_deal ->> 'gross_price')::numeric, (p_deal ->> 'contract_value')::numeric,
      (p_deal ->> 'down_payment')::numeric, (p_deal ->> 'amount_financed')::numeric,
      p_deal ->> 'financing_route', (p_deal ->> 'financing_company_id')::uuid,
      (p_deal ->> 'lost_reason_id')::uuid,
      p_deal ->> 'dealer_code', p_deal ->> 'wave_sales_notes',
      p_deal ->> 'additional_information', p_deal ->> 'reschedule_reason')
    returning id into v_deal;
  end if;

  return query select v_client, v_deal;
end;
$$;

revoke execute on function public.create_contact(jsonb, jsonb) from public, anon;
grant execute on function public.create_contact(jsonb, jsonb) to authenticated;

