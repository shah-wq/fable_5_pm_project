-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · newest module · step 7 of 7 · 20260803003900_contract_signed_system.sql
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
-- Each break is where one script adds something the next one uses, which
-- PostgreSQL will not allow inside a single pasted transaction.
--
-- Behind by more than this module? Run every db/dist/catch-up-*.sql in order
-- instead — they cover everything from 001400 onwards.
-- ============================================================================

-- >>> 20260803003900_contract_signed_system.sql
-- =============================================================================
-- Contract signed — the system is recorded at the moment it is sold
-- =============================================================================
-- A contact is a person until they sign, and nothing about a system belongs on
-- a person who has not bought one. Once they sign, the system is the most
-- important thing about them: what was sold, at what size, for how much.
--
-- So signing is a step rather than a drag. Moving somebody into Contract signed
-- asks for the system there and then, records it on the deal, and only then
-- moves them — and from that moment the contact record shows the system. Before
-- it, the contact record shows nothing about systems at all, because there is
-- nothing true to show.
--
-- The facts live on the deal, as they always have: a person with two
-- properties signs two contracts. What this file adds is the marker that says
-- "this deal's system was recorded at signing", and the one function that
-- signs, so that there is exactly one way into the column.
-- =============================================================================

do $$
begin
  if to_regclass('public.deals') is null then
    raise exception 'Run 20260803003400_crm_foundation.sql first — it creates deals.'
      using hint = 'Admin → Database → Apply runs every missing file in order.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'clients'
                    and column_name = 'contact_stage') then
    raise exception 'Run 20260803003800_contact_stages.sql first — it adds the contact stage.'
      using hint = 'Admin → Database → Apply runs every missing file in order.';
  end if;
end
$$;

/** When the system was recorded at signing. Null means it never was — which is
    true of every deal still being worked, and of every one signed before this
    file, unless the backfill below can say otherwise. */
alter table public.deals
  add column if not exists system_recorded_at timestamptz;

-- -----------------------------------------------------------------------------
-- The contacts who had already signed
-- -----------------------------------------------------------------------------
-- A contact already in Contract signed whose deal carries a system size had it
-- recorded, just not by this screen. Marking those means the System tab
-- appears for them straight away rather than asking again for something that is
-- already on file. A signed contact with no size on their deal stays unmarked:
-- nothing was recorded, and claiming otherwise would put an empty panel on the
-- record that says "here is the system" over nothing.
update public.deals d
   set system_recorded_at = coalesce(d.stage_entered_at, d.updated_at, now())
  from public.clients c
 where c.id = d.client_id
   and c.contact_stage = 'contract_signed'
   and d.system_size_kw is not null
   and d.system_recorded_at is null;

-- -----------------------------------------------------------------------------
-- Signing
-- -----------------------------------------------------------------------------
/**
 * Record the system on the contact's deal and move them to Contract signed, as
 * one statement: a failure halfway leaves them where they were with nothing
 * half-written, rather than signed with no system or with a system and not
 * signed.
 *
 * Which deal: the one named, if it is theirs and still open; otherwise their
 * newest open one; otherwise a new one. A contact typed in from a business card
 * and signed on the kitchen table has no deal yet, and needs one — that is where
 * the system goes. It starts at Contract out, the deal pipeline's last step
 * before the conversion to a project that makes it Won.
 *
 * Only the system, usage and money columns are written. Anything else in the
 * payload is ignored rather than refused, so a screen that sends a whole record
 * cannot move a deal's stage or its owner through the back door.
 *
 * The one thing insisted on is a system size: a signed contract with no system
 * on it is the situation this function exists to prevent.
 */
create or replace function public.sign_contact(
  p_client  uuid,
  p_deal    jsonb,
  p_deal_id uuid default null,
  p_note    text default null
)
returns table (signed_deal_id uuid, deal_created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed constant text[] := array[
    'system_size_kw', 'module_id', 'module_quantity', 'module_wattage',
    'inverter_id', 'inverter_size_kw', 'battery_id', 'battery_qty', 'battery_size_kwh',
    'includes_battery', 'mount_type', 'roof_type_id', 'hoa', 'comparable_brand_ok',
    'utility_id', 'avg_monthly_bill', 'annual_usage_kwh', 'production_estimate_kwh',
    'gross_price', 'contract_value', 'down_payment', 'amount_financed',
    'financing_route', 'financing_company_id'];
  -- Whole numbers in the table. A form field that accepts 12.5 panels would
  -- otherwise fail the whole signing on a cast, so they are rounded here, once,
  -- for every caller.
  v_integers constant text[] := array[
    'module_quantity', 'module_wattage', 'battery_qty',
    'annual_usage_kwh', 'production_estimate_kwh'];
  v_client  public.clients%rowtype;
  v_row     public.deals%rowtype;
  v_new     public.deals%rowtype;
  v_patch   jsonb;
  v_deal    uuid;
  v_created boolean := false;
  v_before  text;
begin
  if not app.is_sales_staff() then
    raise exception 'only the sales team may sign a contact' using errcode = '42501';
  end if;

  select * into v_client from public.clients c where c.id = p_client for update;
  if not found then
    raise exception 'that contact no longer exists' using errcode = 'P0002';
  end if;
  v_before := v_client.contact_stage;

  select coalesce(jsonb_object_agg(
           e.key,
           case when e.key = any(v_integers) and jsonb_typeof(e.value) = 'number'
                then to_jsonb(round((e.value #>> '{}')::numeric))
                else e.value end), '{}'::jsonb)
    into v_patch
    from jsonb_each(coalesce(p_deal, '{}'::jsonb)) e
   where e.key = any(v_allowed);

  -- The deal the system goes on.
  if p_deal_id is not null then
    select d.id into v_deal from public.deals d
     where d.id = p_deal_id and d.client_id = p_client
       and d.stage not in ('won', 'lost');
    if v_deal is null then
      raise exception 'that deal is not an open deal on this contact' using errcode = '22023';
    end if;
  else
    select d.id into v_deal from public.deals d
     where d.client_id = p_client and d.stage not in ('won', 'lost')
     order by d.updated_at desc
     limit 1;
  end if;

  if v_deal is null then
    insert into public.deals (
      client_id, customer_first, customer_last, customer_email, customer_phone,
      address, dealer_id, source_id, owner_id, stage)
    values (
      p_client, v_client.first_name, v_client.last_name, v_client.email, v_client.phone,
      coalesce(nullif(btrim(concat_ws(', ', v_client.mailing_street,
                                            v_client.mailing_city,
                                            v_client.mailing_state)), ''),
               'Address to be confirmed'),
      v_client.dealer_id, v_client.source_id, v_client.owner_id, 'contract_out')
    returning id into v_deal;
    v_created := true;
  end if;

  -- What is on file, overlaid with what was sent. A key that is absent keeps its
  -- value; a key sent as null clears it — which is how a form says "no battery".
  select * into v_row from public.deals d where d.id = v_deal for update;
  v_new := jsonb_populate_record(v_row, v_patch);

  if v_new.system_size_kw is null or v_new.system_size_kw <= 0 then
    raise exception 'a signed contract needs a system size'
      using errcode = '22023',
            hint = 'Enter the system size in kW — it is the one field signing insists on.';
  end if;

  update public.deals d set
    system_size_kw          = v_new.system_size_kw,
    module_id               = v_new.module_id,
    module_quantity         = v_new.module_quantity,
    module_wattage          = v_new.module_wattage,
    inverter_id             = v_new.inverter_id,
    inverter_size_kw        = v_new.inverter_size_kw,
    battery_id              = v_new.battery_id,
    battery_qty             = v_new.battery_qty,
    battery_size_kwh        = v_new.battery_size_kwh,
    includes_battery        = v_new.includes_battery,
    mount_type              = v_new.mount_type,
    roof_type_id            = v_new.roof_type_id,
    hoa                     = v_new.hoa,
    comparable_brand_ok     = v_new.comparable_brand_ok,
    utility_id              = v_new.utility_id,
    avg_monthly_bill        = v_new.avg_monthly_bill,
    annual_usage_kwh        = v_new.annual_usage_kwh,
    production_estimate_kwh = v_new.production_estimate_kwh,
    gross_price             = v_new.gross_price,
    contract_value          = v_new.contract_value,
    down_payment            = v_new.down_payment,
    amount_financed         = v_new.amount_financed,
    financing_route         = v_new.financing_route,
    financing_company_id    = v_new.financing_company_id,
    system_recorded_at      = now()
  where d.id = v_deal;

  if v_before is distinct from 'contract_signed' then
    update public.clients c set contact_stage = 'contract_signed' where c.id = p_client;
    perform public.log_audit_event(
      'contact.stage_moved', 'clients', p_client::text, null,
      jsonb_build_object('from', v_before, 'to', 'contract_signed', 'note', p_note),
      'stage_move', v_deal, p_client);
  end if;

  perform public.log_audit_event(
    'contact.contract_signed', 'deals', v_deal::text, null,
    jsonb_build_object('deal_created', v_created,
                       'system_size_kw', v_new.system_size_kw,
                       'contract_value', v_new.contract_value),
    'form', v_deal, p_client);

  return query select v_deal, v_created;
end;
$$;

revoke execute on function public.sign_contact(uuid, jsonb, uuid, text) from public, anon;
grant execute on function public.sign_contact(uuid, jsonb, uuid, text) to authenticated;


-- >>> migration bookkeeping (lets `npm run db:migrate` skip these later)
create table if not exists public.schema_migrations (
  name       text primary key,
  applied_at timestamptz not null default now()
);
insert into public.schema_migrations (name) values
  ('20260803000000_platform.sql'),
  ('20260803000100_init_schema_and_enums.sql'),
  ('20260803000200_tables.sql'),
  ('20260803000300_access_helpers.sql'),
  ('20260803000400_hooks_and_views.sql'),
  ('20260803000500_audit.sql'),
  ('20260803000600_rls_policies.sql'),
  ('20260803000700_storage.sql'),
  ('20260803000800_add_ops_role.sql'),
  ('20260803000900_auth_module.sql'),
  ('20260803001000_auth_engine.sql'),
  ('20260803001100_file_storage.sql'),
  ('20260803001200_manual_version.sql'),
  ('20260803001300_admin_panel.sql'),
  ('20260803001400_stage_fields.sql'),
  ('20260803001500_complete_hold_cancel.sql'),
  ('20260803001600_complete_stage_backfill.sql'),
  ('20260803001700_project_details.sql'),
  ('20260803001800_equipment_quantities.sql'),
  ('20260803001900_dealer_portal.sql'),
  ('20260803002000_dealer_companies.sql'),
  ('20260803002100_restore_project_defaults.sql'),
  ('20260803002200_report_builder.sql'),
  ('20260803002300_customer_portal.sql'),
  ('20260803002400_customer_management.sql'),
  ('20260803002500_mobile_app.sql'),
  ('20260803002600_customer_passwords.sql'),
  ('20260803002700_invite_customers_with_tokens.sql'),
  ('20260803002800_dashboard.sql'),
  ('20260803002900_project_chat.sql'),
  ('20260803003000_sign_in.sql'),
  ('20260803003100_typical_durations.sql'),
  ('20260803003200_stage_feedback.sql'),
  ('20260803003300_add_sales_role.sql'),
  ('20260803003400_crm_foundation.sql'),
  ('20260803003500_deals.sql'),
  ('20260803003600_contact_intake.sql'),
  ('20260803003700_contact_create.sql'),
  ('20260803003800_contact_stages.sql'),
  ('20260803003900_contract_signed_system.sql')
on conflict (name) do nothing;
