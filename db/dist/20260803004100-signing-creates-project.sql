-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · newest module · step 9 of 9 · 20260803004100_signing_creates_project.sql
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
-- Each break is where one script adds something the next one uses, which
-- PostgreSQL will not allow inside a single pasted transaction.
--
-- Behind by more than this module? Run every db/dist/catch-up-*.sql in order
-- instead — they cover everything from 001400 onwards.
-- ============================================================================

-- >>> 20260803004100_signing_creates_project.sql
-- =============================================================================
-- Signing creates the project
-- =============================================================================
-- Contract signed records the system (003900) and, from this file, creates the
-- project in the same step — so a signed contract becomes work for the install
-- team without anybody converting anything by hand.
--
-- Why a file of its own: sign_contact was first shipped inside 003900 in a
-- shape that recorded the system but made no project. Databases that took that
-- shape have 003900 recorded as applied, and a function that exists answers
-- "yes" to "is it there?" whatever it returns — so Admin → Database said Up to
-- date while signing failed. This file is probed by the function's result
-- columns, not its name, so a database with the first shape is shown as
-- missing it, and Apply fixes it.
-- =============================================================================

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'deals'
                    and column_name = 'system_recorded_at') then
    raise exception 'Run 20260803003900_contract_signed_system.sql first — it adds signing.'
      using hint = 'Admin → Database → Apply runs every missing file in order.';
  end if;
  if to_regprocedure('public.convert_deal_to_project(uuid,public.project_stage)') is null then
    raise exception 'Run 20260803003500_deals.sql first — it converts deals to projects.'
      using hint = 'Admin → Database → Apply runs every missing file in order.';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Signing
-- -----------------------------------------------------------------------------
-- Dropped first: the first version returned the deal alone, and a function's
-- result columns cannot change in place. This is the only file that defines
-- it, so re-running anything never puts that version back.
drop function if exists public.sign_contact(uuid, jsonb, uuid, text);

/**
 * Record the system, move the contact to Contract signed, and create the
 * project — as one statement. Any refusal, including the project's own, leaves
 * everything as it was: nobody ends up signed without a project, or with a
 * project and not signed.
 *
 * The form asks for the two things a project cannot exist without and a
 * contact can: a dealer, and a site address. Both are written to the deal; the
 * dealer goes on the contact too when they had none, since the attribution is
 * theirs from now on.
 *
 * The rest is as 003900: the named open deal, else their newest open one, else
 * a new one; only the system, usage, money, dealer and address columns are
 * written, whatever the payload carries; whole-number columns are rounded.
 */
create function public.sign_contact(
  p_client  uuid,
  p_deal    jsonb,
  p_deal_id uuid default null,
  p_note    text default null
)
returns table (signed_deal_id uuid, deal_created boolean,
               signed_project_id uuid, signed_project_code text)
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
    'financing_route', 'financing_company_id',
    'dealer_id', 'address'];
  v_integers constant text[] := array[
    'module_quantity', 'module_wattage', 'battery_qty',
    'annual_usage_kwh', 'production_estimate_kwh'];
  -- What a deal made for a contact with no address to give is written with. A
  -- project cannot be surveyed at it, so it counts as no address at all.
  v_placeholder constant text := 'Address to be confirmed';
  v_client  public.clients%rowtype;
  v_row     public.deals%rowtype;
  v_new     public.deals%rowtype;
  v_patch   jsonb;
  v_deal    uuid;
  v_created boolean := false;
  v_before  text;
  v_project uuid;
  v_code    text;
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
                when e.key = 'address' and jsonb_typeof(e.value) = 'string'
                then to_jsonb(nullif(btrim(e.value #>> '{}'), ''))
                else e.value end), '{}'::jsonb)
    into v_patch
    from jsonb_each(coalesce(p_deal, '{}'::jsonb)) e
   where e.key = any(v_allowed);

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
               v_placeholder),
      v_client.dealer_id, v_client.source_id, v_client.owner_id, 'contract_out')
    returning id into v_deal;
    v_created := true;
  end if;

  select * into v_row from public.deals d where d.id = v_deal for update;
  v_new := jsonb_populate_record(v_row, v_patch);

  -- What the project will need, checked before anything is written so the
  -- refusal names the field rather than surfacing from inside the conversion.
  if v_new.system_size_kw is null or v_new.system_size_kw <= 0 then
    raise exception 'a signed contract needs a system size'
      using errcode = '22023',
            hint = 'Enter the system size in kW — it is the one field signing insists on.';
  end if;
  if v_new.dealer_id is null then
    raise exception 'the project needs a dealer'
      using errcode = '22023', hint = 'Choose the dealer this sale belongs to.';
  end if;
  if coalesce(btrim(v_new.address), '') in ('', v_placeholder) then
    raise exception 'the project needs a site address'
      using errcode = '22023', hint = 'Enter the address the system is being installed at.';
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
    dealer_id               = v_new.dealer_id,
    address                 = btrim(v_new.address),
    system_recorded_at      = now()
  where d.id = v_deal;

  if v_client.dealer_id is null then
    update public.clients c set dealer_id = v_new.dealer_id where c.id = p_client;
  end if;

  if v_before is distinct from 'contract_signed' then
    update public.clients c set contact_stage = 'contract_signed' where c.id = p_client;
    perform public.log_audit_event(
      'contact.stage_moved', 'clients', p_client::text, null,
      jsonb_build_object('from', v_before, 'to', 'contract_signed', 'note', p_note),
      'stage_move', v_deal, p_client);
  end if;

  -- The project, through the same conversion the deal board uses, so a
  -- project made by signing is the same shape as one made there: the system
  -- pre-filled, the documents gaining the project relation, the deal Won.
  -- It starts at Survey, as it does from the board.
  v_project := public.convert_deal_to_project(v_deal, 'survey'::public.project_stage);

  -- The conversion copies the system size and the brands but not the module
  -- count, which the signing form asks for and the project's specification
  -- shows. Only where the project has none: a project the conversion returned
  -- rather than made keeps whatever it already says.
  update public.projects p
     set module_quantity = coalesce(p.module_quantity, nullif(v_new.module_quantity, 0))
   where p.id = v_project;

  select p.code into v_code from public.projects p where p.id = v_project;

  perform public.log_audit_event(
    'contact.contract_signed', 'deals', v_deal::text, v_project,
    jsonb_build_object('deal_created', v_created,
                       'project_id', v_project,
                       'project_code', v_code,
                       'system_size_kw', v_new.system_size_kw,
                       'contract_value', v_new.contract_value),
    'form', v_deal, p_client);

  return query select v_deal, v_created, v_project, v_code;
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
  ('20260803003900_contract_signed_system.sql'),
  ('20260803004000_project_holds_contact.sql'),
  ('20260803004100_signing_creates_project.sql')
on conflict (name) do nothing;
