-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · catch-up 2 of 2 · newest migration: 20260803003200_stage_feedback.sql
--
-- Paste this whole file into a SQL console (e.g. the Neon SQL Editor) and run
-- it. Safe to run more than once: every statement below skips work already
-- done, so 'already exists' errors cannot happen. NOTICE lines saying
-- 'does not exist, skipping' are normal.
--
-- Run catch-up 1 first, then catch-up 2, each as its own execution.
-- Includes: 20260803001600_complete_stage_backfill.sql, 20260803001700_project_details.sql, 20260803001800_equipment_quantities.sql, 20260803001900_dealer_portal.sql, 20260803002000_dealer_companies.sql, 20260803002100_restore_project_defaults.sql, 20260803002200_report_builder.sql, 20260803002300_customer_portal.sql, 20260803002400_customer_management.sql, 20260803002500_mobile_app.sql, 20260803002600_customer_passwords.sql, 20260803002700_invite_customers_with_tokens.sql, 20260803002800_dashboard.sql, 20260803002900_project_chat.sql, 20260803003000_sign_in.sql, 20260803003100_typical_durations.sql, 20260803003200_stage_feedback.sql, migration bookkeeping
-- ============================================================================

-- >>> 20260803001600_complete_stage_backfill.sql

-- =============================================================================
-- 001600 — Backfill: completed projects land on the Complete stage
-- =============================================================================
-- Projects that finished before 001500 added the 'complete' enum value have
-- status = 'complete' but stage still at 'inspection_pto', so they never show
-- in the board's Complete column and an admin back-out targets the wrong
-- stage. Move them onto the Complete stage and seed their completion record.
--
-- Re-runnable, and safe in the same batch as 001500: a pasted console script
-- is one transaction, and PostgreSQL refuses to use an enum value the same
-- transaction added (55P04). Rather than fail the whole batch, the backfill
-- reports that it was skipped; running this file again afterwards finishes it.

do $$
begin
  begin
    update public.projects
    set stage = 'complete'
    where status = 'complete' and stage <> 'complete';

    insert into public.stage7_complete (project_id, completion_date)
    select p.id, current_date
    from public.projects p
    where p.status = 'complete'
    on conflict (project_id) do nothing;
  exception
    when unsafe_new_enum_value_usage then
      raise notice 'Complete-stage backfill skipped: the ''complete'' stage value was added in this same transaction. Run this file again on its own to finish it.';
  end;
end
$$;



-- >>> 20260803001700_project_details.sql

-- =============================================================================
-- 001700 — New Project form & Project Details (equipment + financing lists)
-- =============================================================================
-- Implements the "New Project form & Project Details" PDF: the six dropdown
-- lists from Solar_SCOOP_Data.xlsx become admin-managed reference tables (not
-- hardcoded), plus a Sales Reps list, and the project row grows the system-
-- specification / financing / sales-rep columns. Reference rows are stored by
-- ID on the project — correcting a typo in a module name fixes it everywhere.
-- Deactivate-not-delete, same as every other admin list.

-- Equipment & financing reference lists ---------------------------------------
create table if not exists public.system_types (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.module_types (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  manufacturer text,
  wattage      integer check (wattage > 0),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.inverter_types (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  manufacturer text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.battery_types (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  manufacturer text,
  capacity_kwh numeric(8,2) check (capacity_kwh > 0),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.financing_companies (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cash_financing_options (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Sales reps as a list, not free text — 'J. Smith', 'John Smith' and 'jsmith'
-- must not become three different reps.
create table if not exists public.sales_reps (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  email      text,
  phone      text,
  dealer_id  uuid references public.dealers (id),
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Project detail columns (everything the New Project form / Details tab edits
-- that projects didn't already carry) -----------------------------------------
alter table public.projects
  add column if not exists sales_rep_id         uuid references public.sales_reps (id),
  add column if not exists system_type_id       uuid references public.system_types (id),
  add column if not exists module_type_id       uuid references public.module_types (id),
  add column if not exists module_quantity      integer check (module_quantity > 0),
  add column if not exists inverter_type_id     uuid references public.inverter_types (id),
  add column if not exists battery_type_id      uuid references public.battery_types (id),
  add column if not exists cash_or_financing_id uuid references public.cash_financing_options (id),
  add column if not exists financing_company_id uuid references public.financing_companies (id),
  add column if not exists financing_notes      text;

-- RLS: staff read, admin+ops manage (the PM can '+ Add new' inline), deletes
-- admin-only — the reference-data pattern from 001200.
do $$
declare t text;
begin
  foreach t in array array['system_types', 'module_types', 'inverter_types',
                           'battery_types', 'financing_companies',
                           'cash_financing_options', 'sales_reps']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists %1$I_select on public.%1$I', t);
    execute format($p$
      create policy %1$I_select on public.%1$I
        for select to authenticated
        using ((select app.current_user_role()) in ('admin', 'ops', 'designer', 'finance'))
    $p$, t);
    execute format('drop policy if exists %1$I_write_i on public.%1$I', t);
    execute format($p$
      create policy %1$I_write_i on public.%1$I
        for insert to authenticated
        with check ((select app.current_user_role()) in ('admin', 'ops'))
    $p$, t);
    execute format('drop policy if exists %1$I_write_u on public.%1$I', t);
    execute format($p$
      create policy %1$I_write_u on public.%1$I
        for update to authenticated
        using ((select app.current_user_role()) in ('admin', 'ops'))
        with check ((select app.current_user_role()) in ('admin', 'ops'))
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

-- Finance partner (milestones) list from the spec — added idempotently so
-- existing rows (and their project references) are untouched.
insert into public.finance_partners (name)
select v.name
from (values ('Credit Human'), ('TOPCO'), ('ICCU'), ('LightReach'),
             ('HDM'), ('Climate'), ('PE'), ('ATMOS')) as v(name)
where not exists (
  select 1 from public.finance_partners fp where lower(fp.name) = lower(v.name)
);

-- Seeds — Appendices A–F, exactly as they appear in Solar_SCOOP_Data.xlsx.
-- (The inverter list carries 'EG4 18KPV' and 'EG4 18kPV' from the source;
-- an admin can deactivate the duplicate.)
insert into public.module_types (name) values
  ('Sirus ELNSM54M-HC-410'),
  ('Canadian Solar CS3W-400P'),
  ('Hyundai HIS-S410YH(BK)'),
  ('Seraphim SEG-360-BMB-HV'),
  ('Hyundai HIS-S405YH(BK)'),
  ('VSUN 410-144BMH-DG'),
  ('Hyperion HY-DH108P8-400'),
  ('Canadian Solar CS3W-395P'),
  ('Hyperion HY-DH108P8-405'),
  ('Phono Solar Technology PS410M6-18/VH'),
  ('Aptos DNA-120-BF10-440W'),
  ('Znshinesolar ZXM6-NH120 370'),
  ('Longi LR5-54HABB-400M'),
  ('Znshinesolar ZXM7-SH108 400'),
  ('Jinko JKM425N-54HL4-B'),
  ('Qcells Q.PEAK DUO BLK ML-G10+ 410'),
  ('Jinko JKM430N-54HL4-B'),
  ('Hyperion HY-DH108P8-410B'),
  ('Qcell Q.PEAK DUO BLK ML-G10+ 415'),
  ('Qcells Q.TRON BLK M-G2+ 425'),
  ('Qcell Q.TRON BLK M-G2+ 430'),
  ('Meyer Burger GmbH Black 390'),
  ('REC REC420AA Pure2'),
  ('Axitec Solar AC-550MBT/144V'),
  ('REC REC450AA Pure-RX'),
  ('Phono Solar Technology PS400M6-18/VH'),
  ('REC REC460AA Pure-RX'),
  ('URECO FBF430BFG-BB'),
  ('SEG 430 BTD-BG'),
  ('TRINA SOLAR TSM-NE09RC.05-425W'),
  ('Canadian Solar CS6.1-54TM-455H'),
  ('Mission Solar MSOLAR HC SERIES TXI10-400108BB'),
  ('Renogy RSP200DC-ASR'),
  ('Other'),
  ('Canadian Solar CS6.2-66TB-610'),
  ('Mission Solar MSOLAR HC SERIES TXI10-410108BB'),
  ('Aptos DNA-144-BF10-550W-DG'),
  ('Panasonic EVERVOLT EVPV430HK2'),
  ('Canadian Solar CS6.1-54TM-445H'),
  ('REC 420 Pure R'),
  ('Znshinesolar ZXM8-TPLDD132 660'),
  ('REC 410AA PURE'),
  ('Canadian Solar CS6K-300MS'),
  ('Axitec 400'),
  ('VSUN 400-108BMH'),
  ('Trina 420'),
  ('Philadelphia Solar PS-M144(HCBF)-550W'),
  ('REC 400 AA Pure'),
  ('Canadian Solar CS3L-385MS'),
  ('Meyer Burger 380'),
  ('Seraphim SRP-600-BMB-BG'),
  ('REC 405 Alpha'),
  ('Canadian Solar CS6R-405MS'),
  ('QCELLS Q.PEAK DUO M-G11S 420W'),
  ('Trina Solar TSM-250 PC05A.08'),
  ('Canadian Solar CS6.1-54TM-450H'),
  ('Qcells Q.TRON XL-G2.3 BFG 630'),
  ('G Star 435W'),
  ('Trina Solar TSM-250 PA05'),
  ('Regitec RMHT54/430AB2'),
  ('VSUN 550-144BMH-DG'),
  ('Trina 445W TSM-445 NEG9RC.27'),
  ('Qcells Q.TRON BLK M-G2+ 435'),
  ('CW T450'),
  ('JA Solar JAM54S31-405/MR'),
  ('SolarEver 450W'),
  ('JA Solar JAM54S30-405/MR'),
  ('SolarEver 410'),
  ('Solarever USA SE-166*83-445M-144'),
  ('SEG 440 W'),
  ('Silfab Solar SIL-580 XM+'),
  ('Solaria Powerxt-330R-px'),
  ('Panasonic EVPV420HK2'),
  ('Silfab 440QD-DCA2'),
  ('VSUN 410-144MH'),
  ('Hyundai 440BK'),
  ('URE United Renewable Energy FAK445C8G'),
  ('HiN-T440NF(BK)'),
  ('Silfab Solar SIL-590 XM+ Bifacial')
on conflict (name) do nothing;

insert into public.inverter_types (name) values
  ('Enphase IQ8+ 72-2-US'),
  ('EG4 6000XP'),
  ('Enphase IQ8A -72-2-US'),
  ('SolarEdge SE50K'),
  ('Enphase IQ8MC'),
  ('SolarEdge SE100K'),
  ('Enphase IQ8X -80-M-US [240V]'),
  ('Solplanet ASW08kH-T1'),
  ('Enphase IQ8HC'),
  ('Growatt MIN 3800TL-XH-US'),
  ('Duracel D350-M1'),
  ('Growatt MIN 5000TL-X'),
  ('Duracel D700-M2'),
  ('Enphase IQ8M-72-M-US'),
  ('Tesla PW3'),
  ('Growatt MIN 10000TL-XH-US'),
  ('Franklin'),
  ('Schneider XW Pro 6848 NA 120/240 V'),
  ('EG4 18KPV'),
  ('Sol-Ark SA-12K (240V) (Single Phase)'),
  ('Hoymiles HM - 1500NT [240V]'),
  ('Sol-Ark SA-8K (240V)'),
  ('PointGuard Energy PG Controller 7.6kW'),
  ('APSystems DS3-L (North America)'),
  ('Tesla 1707000-xx-y 7.6kW'),
  ('Growatt MIN 7600TL-XH-US'),
  ('Sol-Ark Limitless 15K-LV'),
  ('Tesla 1538000-xx-y 7.6kW'),
  ('EG4 18kPV'),
  ('Tesla 1707000-xx-y 11.5kW'),
  ('EG4 IV-8000-HYB-AW'),
  ('APSystems DS3 (North America)'),
  ('Enphase IQ8HC-72-M-INT [25 year warranty]'),
  ('SolarEdge SE11400H-US [240V]'),
  ('EG4 FlexBOSS18'),
  ('Sol-Ark 15K'),
  ('SolarEdge USE11400H-USMNBL75 (Domestic)'),
  ('EG4 18KPV-12LV'),
  ('SolarEdge SE10K'),
  ('Hoymiles HM-1500NT [240V]'),
  ('GoodWe GW11K4-ES-US20'),
  ('Enphase IQ8A-72-2-US'),
  ('SolarEdge Energy Hub SE7600H-US [240V]'),
  ('Panasonic EVHB- 17'),
  ('Sol-Ark 60K-3P-480V'),
  ('GROWATT MIN 11400TL-XH-US'),
  ('Sol-Ark 30K-3P-208V-N'),
  ('Enphase IQ8M'),
  ('Fronius SYMO ADVANCED 24.0-3 480'),
  ('TIGO 7.6 KW hybrid inverter'),
  ('Fronius 24.0-3 480'),
  ('Solis 40K'),
  ('Fronius Symo 20.0-3-M Advanced'),
  ('Other'),
  ('SolarEdge Energy Hub SE10000H-US [240V]'),
  ('Hoymiles 1800-4T'),
  ('Hoymiles HMT-2000-4T'),
  ('Hoymiles HM-1600NT'),
  ('Hoymiles HMS-2000-4T-NA [240V] [25 Years]'),
  ('APSystems DS3-S (North America)'),
  ('Growatt 7600MTLP-US [240V]'),
  ('General Motors - Energy Home System'),
  ('GoodWe GW7600A-ES'),
  ('Enphase IQ8P-72-2-INT (480 watts)'),
  ('Enphase IQ8HC-72-M-INT'),
  ('Hoymiles 1600- 4T'),
  ('EG4 8KEXP-240V'),
  ('Hoymiles HMS-1600'),
  ('Duracell D1500-M4 (240V)')
on conflict (name) do nothing;

insert into public.battery_types (name) values
  ('EG4 PowerPro 14.3kw'),
  ('HomeGrid PF5- LFP38400-2A01'),
  ('EG4 Lifepower4 5.2kwh'),
  ('HomeGrid PF5- LFP14400-2A01'),
  ('Tesla PW3 powerwall 3'),
  ('Tesla Powerwall 3 Battery (Expansion) Tesla'),
  ('Schneider Boost BAT10K1 10kWh'),
  ('Anker X1-P6KB15-US'),
  ('Emporia 8.2kwh Smart Home Battery System'),
  ('DELTA Pro Ultra Battery'),
  ('Franklin WH 13.6kwh'),
  ('Growatt ALP 5.0L-E1'),
  ('Growatt APX 5kwh'),
  ('SolarEdge SE BAT-10K1PS0B-x2'),
  ('Pyte 30.72Kwh'),
  ('Tesla Powerwall+'),
  ('Homegrid Energy Stacked 4.8kwh'),
  ('Tesla Powerwall'),
  ('Enphase IQBATTERY-5P-1P-NA, 5 kWh, 7.68 kVA Peak Output'),
  ('Tesla Powerwall 2.0'),
  ('APSystem ELS 5kwh'),
  ('Eternalplanet Energy (EP Cube) Hybrid NA720G (19.9 kWh)'),
  ('Fortress Eflex 5.4kwh'),
  ('Enphase ENCHARGE-10-1P-NA'),
  ('Generac PWRcell 3 Cell 9kwh'),
  ('LG Chem RESU 10'),
  ('Ecoflow DELTA Pro Ultra 6kwh'),
  ('HomeGrid PF5- LFP19200-2A01'),
  ('Panasonic EVHB-I7-X10'),
  ('Tigo TSB-10'),
  ('Panasonic EVHB-I7-X15'),
  ('Growatt APX 10.0P'),
  ('Panasonic EVHB-I7-X20'),
  ('Growatt APX 20.0P'),
  ('BYD-HVL 32kwh'),
  ('Enphase ENCHARGE-10T-1P-INT'),
  ('Solax S15kwh'),
  ('HomeGrid Integrated 14.4 kWh'),
  ('Point Guard Home 5kwh'),
  ('HomeGrid Integrated 24 kWh'),
  ('Point Guard Home 8kwh'),
  ('HomeGrid HG-FS48100-15OSJ1'),
  ('Bigbattery 30.7kwh (6 stackable units)'),
  ('Pytes E-BOX-48100R'),
  ('Other'),
  ('EG4 LifePower4 [24V 200AH] 30.72kWh'),
  ('PointGuard PGHome-A-10.76-C'),
  ('EG4-LL'),
  ('SolarEdge BAT-10K1P'),
  ('EG4 LifePower4 [48V 100AH] 30.72kWh'),
  ('Enphase IQBATTERY-10C-1P-NA 10kWh'),
  ('Emporia ALPHA-ESS-BATT-EMS'),
  ('Tesla 1807000-20-B'),
  ('Emporia Smart Home Battery System (8.2 kWh)'),
  ('Pytes HV48100'),
  ('Panasonic EVHB-L6 17.5 kWh'),
  ('PointGuard PG BatteryPack 5.0kWh'),
  ('LG Chem RESU 6.5'),
  ('PointGuard PG BatteryPack 8.0kWh'),
  ('LG Chem RESU 10H'),
  ('Franklin WH aPower 2'),
  ('Franklin WH aPower'),
  ('PointGuard PGHome-A-24.18-C'),
  ('EG4 LifePower4 [51.2V 100AH]'),
  ('EG4 WallMount Indoor 280Ah'),
  ('GROWATT ARK10.2XH 10.24KWH'),
  ('PointGuard PGHome-A-21.50-C'),
  ('Yoshopo NOVA 2000 - YLB2P-14'),
  ('Growatt APX 15.0P'),
  ('SOL-ARK L3 HVR-60 L3 HVR-60KWH-30K'),
  ('Growatt ALP 15.0L-E1')
on conflict (name) do nothing;

insert into public.financing_companies (name) values
  ('Credit Human Union'),
  ('Sungage'),
  ('Mosaic'),
  ('Clean Energy Funds of Texas'),
  ('Skylight'),
  ('Self Help'),
  ('Climate Financing'),
  ('Service Finance'),
  ('Go Green (California Coast + Self-Help)'),
  ('California Coast'),
  ('Go Green Financing'),
  ('TOPCU'),
  ('Energy Loan Network'),
  ('Other'),
  ('Home Loan Improvement Bank')
on conflict (name) do nothing;

insert into public.system_types (name) values
  ('Battery only'),
  ('Battery & solar'),
  ('Grid-tie solar'),
  ('Inverter only'),
  ('Battery & solar (Off-grid)')
on conflict (name) do nothing;

insert into public.cash_financing_options (name) values
  ('Cash'),
  ('Financing'),
  ('Cash and Financing'),
  ('HDM with Finance'),
  ('HDM with Cash'),
  ('Palmetto PPA')
on conflict (name) do nothing;




-- >>> 20260803001800_equipment_quantities.sql

-- =============================================================================
-- 001800 — Inverter & battery quantities
-- =============================================================================
-- The system specification carries how many of each, not just which model:
-- module_quantity arrived with 001700; inverter and battery counts join it.

alter table public.projects
  add column if not exists inverter_quantity integer check (inverter_quantity > 0),
  add column if not exists battery_quantity  integer check (battery_quantity > 0);



-- >>> 20260803001900_dealer_portal.sql

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



-- >>> 20260803002000_dealer_companies.sql

-- =============================================================================
-- 002000 — Dealer companies (admin record, commission defaults, guarded delete)
-- =============================================================================
-- Implements the "Dealer companies" spec: the company record grows identity /
-- commercial / portal-behaviour fields, names are unique case-insensitively
-- (catch 'SunPro Energy LLC' vs 'sunpro energy llc ' at creation, not later),
-- and every change is audited. Deletion stays restricted at the database
-- level: projects.dealer_id and leads.dealer_id have plain (NO ACTION)
-- foreign keys, so a referenced company cannot be deleted by any code path.

alter table public.dealers
  add column if not exists primary_contact_name    text,
  add column if not exists primary_contact_email   text,
  add column if not exists company_address         text,
  add column if not exists tax_id                  text,
  add column if not exists default_commission_basis text
    check (default_commission_basis in
           ('percentage_of_contract', 'fixed_per_project', 'per_watt', 'manual')),
  add column if not exists default_commission_rate numeric(12,4)
    check (default_commission_rate >= 0),
  add column if not exists payment_terms           text,
  add column if not exists notification_recipients text,
  add column if not exists notes                   text;

-- Case-insensitive, trimmed uniqueness on the company name.
create unique index if not exists dealers_name_ci_key
  on public.dealers (lower(trim(name)));

-- Every field change on a company is written to the activity log.
drop trigger if exists audit_row on public.dealers;
create trigger audit_row after insert or update or delete on public.dealers
  for each row execute function app.tg_audit_row();

-- Commission prefill from the dealer's defaults — forward-only: it fires at
-- project creation, so changing a dealer's defaults later never restates
-- money already promised on existing projects. Definer rights because the
-- commissions table is otherwise admin-write-only.
create or replace function app.tg_seed_commission_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_basis text;
  v_rate  numeric;
  v_base  numeric;
begin
  select d.default_commission_basis, d.default_commission_rate
    into v_basis, v_rate
  from public.dealers d
  where d.id = new.dealer_id;

  if v_basis is null or v_rate is null or v_basis = 'manual' then
    return new;
  end if;

  v_base := case v_basis
    when 'percentage_of_contract' then round(v_rate * new.contract_value / 100.0, 2)
    when 'fixed_per_project'      then round(v_rate, 2)
    when 'per_watt'               then round(v_rate * new.system_size_kw * 1000, 2)
  end;
  if v_base is null then
    return new;
  end if;

  insert into public.commissions (project_id, base_amount, status, notes)
  values (new.id, v_base, 'pending',
          'Prefilled from dealer default (' || v_basis || ' @ ' || v_rate || ')')
  on conflict (project_id) do nothing;
  return new;
end;
$$;

drop trigger if exists seed_commission_defaults on public.projects;
create trigger seed_commission_defaults after insert on public.projects
  for each row execute function app.tg_seed_commission_defaults();



-- >>> 20260803002100_restore_project_defaults.sql

-- =============================================================================
-- 002100 — Re-assert the projects defaults
-- =============================================================================
-- 001200 swapped projects.stage onto the manual-version enum in three steps:
-- drop default, change type, set default 'survey'. A database where that file
-- was applied in pieces (a console paste that stopped part-way) can end up
-- with the type changed but the default gone — and since the column is NOT
-- NULL, every insert that relies on the default fails with 23502.
--
-- The application now names stage explicitly on insert, so this is belt and
-- braces; re-asserting the defaults is harmless where they are already right.

alter table public.projects alter column stage  set default 'survey';
alter table public.projects alter column status set default 'active';



-- >>> 20260803002200_report_builder.sql

-- =============================================================================
-- 002200 — Report builder (saved reports, schedules, run history, indexes)
-- =============================================================================
-- Implements the "Report builder" spec's persistence. A report is a JSON
-- definition, never SQL: the generator turns it into a parameterised query
-- from whitelisted columns, so nothing user-authored is ever executed.
-- Visibility follows the spec: private, shared with a role, or shared with
-- named users; recipients get read-only access unless they duplicate it.

create table if not exists public.report_definitions (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  description  text,
  definition   jsonb not null default '{}'::jsonb,
  owner_id     uuid not null references public.profiles (id) on delete cascade,
  visibility   text not null default 'private'
    check (visibility in ('private', 'role', 'users')),
  /** Roles the report is shared with when visibility = 'role'. */
  shared_roles text[] not null default '{}',
  /** Profile ids the report is shared with when visibility = 'users'. */
  shared_users uuid[] not null default '{}',
  /** Set on the shipped templates; they are visible to every staff user. */
  is_template  boolean not null default false,
  last_run_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists report_definitions_owner_idx on public.report_definitions (owner_id);
create index if not exists report_definitions_template_idx on public.report_definitions (is_template)
  where is_template;

create table if not exists public.report_schedules (
  id          uuid primary key default gen_random_uuid(),
  report_id   uuid not null references public.report_definitions (id) on delete cascade,
  created_by  uuid not null references public.profiles (id),
  cadence     text not null check (cadence in ('daily', 'weekly', 'monthly')),
  /** 0–6 (Sunday–Saturday) for weekly. */
  days_of_week integer[] not null default '{}',
  /** 1–28 for monthly. */
  day_of_month integer check (day_of_month between 1 and 28),
  /** Minutes past midnight UTC. */
  send_at_minutes integer not null default 420 check (send_at_minutes between 0 and 1439),
  format      text not null default 'xlsx' check (format in ('xlsx', 'csv')),
  recipients  text not null,
  is_active   boolean not null default true,
  last_sent_at timestamptz,
  last_error  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists report_schedules_active_idx on public.report_schedules (is_active)
  where is_active;

-- Run history: who ran or exported which report and when — the record to
-- reach for when a number is disputed.
create table if not exists public.report_runs (
  id         bigint generated always as identity primary key,
  report_id  uuid references public.report_definitions (id) on delete set null,
  report_name text not null,
  ran_by     uuid references public.profiles (id),
  format     text not null check (format in ('preview', 'xlsx', 'csv', 'print', 'schedule')),
  row_count  integer not null default 0,
  duration_ms integer,
  ran_at     timestamptz not null default now()
);

create index if not exists report_runs_report_idx on public.report_runs (report_id, ran_at desc);

-- RLS ------------------------------------------------------------------------
-- Reports are staff furniture: admin/ops/finance read what is theirs, shared
-- with their role, shared with them by name, or shipped as a template.
alter table public.report_definitions enable row level security;
grant select, insert, update, delete on public.report_definitions to authenticated;

drop policy if exists report_definitions_select on public.report_definitions;
create policy report_definitions_select on public.report_definitions
  for select to authenticated
  using (
    (select app.is_admin())
    or owner_id = (select auth.uid())
    or is_template
    or (visibility = 'role' and (select app.current_user_role())::text = any (shared_roles))
    or (visibility = 'users' and (select auth.uid()) = any (shared_users))
  );

drop policy if exists report_definitions_insert on public.report_definitions;
create policy report_definitions_insert on public.report_definitions
  for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and (select app.current_user_role()) in ('admin', 'ops', 'finance')
    and (not is_template or (select app.is_admin()))
  );

-- Shared reports are read-only to recipients: only the owner (or an admin)
-- may change or delete one.
drop policy if exists report_definitions_update on public.report_definitions;
create policy report_definitions_update on public.report_definitions
  for update to authenticated
  using ((select app.is_admin()) or owner_id = (select auth.uid()))
  with check ((select app.is_admin()) or owner_id = (select auth.uid()));

drop policy if exists report_definitions_delete on public.report_definitions;
create policy report_definitions_delete on public.report_definitions
  for delete to authenticated
  using ((select app.is_admin()) or owner_id = (select auth.uid()));

drop trigger if exists set_updated_at on public.report_definitions;
create trigger set_updated_at before update on public.report_definitions
  for each row execute function app.tg_set_updated_at();
drop trigger if exists audit_row on public.report_definitions;
create trigger audit_row after insert or update or delete on public.report_definitions
  for each row execute function app.tg_audit_row();

alter table public.report_schedules enable row level security;
grant select, insert, update, delete on public.report_schedules to authenticated;

drop policy if exists report_schedules_select on public.report_schedules;
create policy report_schedules_select on public.report_schedules
  for select to authenticated
  using (
    (select app.is_admin())
    or created_by = (select auth.uid())
    or exists (select 1 from public.report_definitions r
               where r.id = report_id and r.owner_id = (select auth.uid()))
  );

drop policy if exists report_schedules_write_i on public.report_schedules;
create policy report_schedules_write_i on public.report_schedules
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (select app.current_user_role()) in ('admin', 'ops', 'finance')
  );

drop policy if exists report_schedules_write_u on public.report_schedules;
create policy report_schedules_write_u on public.report_schedules
  for update to authenticated
  using ((select app.is_admin()) or created_by = (select auth.uid()))
  with check ((select app.is_admin()) or created_by = (select auth.uid()));

drop policy if exists report_schedules_delete on public.report_schedules;
create policy report_schedules_delete on public.report_schedules
  for delete to authenticated
  using ((select app.is_admin()) or created_by = (select auth.uid()));

drop trigger if exists set_updated_at on public.report_schedules;
create trigger set_updated_at before update on public.report_schedules
  for each row execute function app.tg_set_updated_at();
drop trigger if exists audit_row on public.report_schedules;
create trigger audit_row after insert or update or delete on public.report_schedules
  for each row execute function app.tg_audit_row();

-- Run history is append-only for staff and readable alongside the report.
alter table public.report_runs enable row level security;
grant select, insert on public.report_runs to authenticated;

drop policy if exists report_runs_select on public.report_runs;
create policy report_runs_select on public.report_runs
  for select to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops', 'finance'));

drop policy if exists report_runs_insert on public.report_runs;
create policy report_runs_insert on public.report_runs
  for insert to authenticated
  with check ((select app.current_user_role()) in ('admin', 'ops', 'finance', 'dealer'));

-- Indexes for what reports group by (spec §9: 'index what people group by').
create index if not exists projects_sales_rep_idx on public.projects (sales_rep_id);
create index if not exists projects_assigned_pm_idx on public.projects (assigned_pm);
create index if not exists projects_status_stage_idx on public.projects (status, stage);
create index if not exists projects_created_at_idx on public.projects (created_at desc);
create index if not exists stage7_completion_date_idx on public.stage7_complete (completion_date);
create index if not exists stage6_pto_received_idx on public.stage6_inspection (pto_received_date);
create index if not exists stage3_permit_dates_idx on public.stage3_permit (permit_applied_date, permit_received_date);
create index if not exists stage5_install_completed_idx on public.stage5_install (install_completed_date);
create index if not exists project_stage_events_to_stage_idx on public.project_stage_events (to_stage, changed_at desc);
create index if not exists commissions_status_idx on public.commissions (status);

-- The shipped templates live in the app's registry (src/lib/reports/templates.ts)
-- so they version with the code; they are offered to every staff user from the
-- library screen and become saved reports only when someone saves one.



-- >>> 20260803002300_customer_portal.sql

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



-- >>> 20260803002400_customer_management.sql

-- =============================================================================
-- 002400 — Managing customers (identity, merge, archive, anonymise)
-- =============================================================================
-- Implements the "Managing customers" spec. The customer is a person and the
-- project is a job: one client row can carry several projects, so this module
-- is about finding, correcting, merging and controlling portal access for
-- records that already exist — not primarily about adding them.
--
-- Two rules are enforced in the database rather than the UI: a customer with
-- projects or leads cannot be deleted (the foreign keys are NO ACTION), and
-- destructive operations run through definer functions that check the caller
-- is an admin.

alter table public.clients
  add column if not exists alternate_phone   text,
  add column if not exists preferred_language text,
  add column if not exists mailing_address   text,
  /** Admin/PM only — never crosses to the customer portal. */
  add column if not exists internal_notes    text,
  /** Archived customers drop out of default search; projects are untouched. */
  add column if not exists is_archived       boolean not null default false,
  add column if not exists anonymised_at     timestamptz;

-- Email is the portal login identity, so it must be unique — case-insensitively
-- and trimmed, because the commonest mess is the same address stored twice with
-- different capitalisation or a trailing space.
update public.clients set email = nullif(btrim(email), '') where email is not null;

create unique index if not exists clients_email_ci_key
  on public.clients (lower(btrim(email))) where email is not null;

create index if not exists clients_phone_idx on public.clients (phone) where phone is not null;
create index if not exists clients_archived_idx on public.clients (is_archived);

-- PMs may edit contact details and internal notes; only admins reach the
-- destructive functions below (RLS keeps deletes admin-only already).
drop policy if exists clients_update on public.clients;
create policy clients_update on public.clients
  for update to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops'))
  with check ((select app.current_user_role()) in ('admin', 'ops'));

drop trigger if exists audit_row on public.clients;
create trigger audit_row after insert or update or delete on public.clients
  for each row execute function app.tg_audit_row();

-- Likely duplicates: same email, same phone, or the same site address with a
-- similar name. Surfaced proactively in the admin list so they get merged
-- before they multiply.
create or replace view public.customer_duplicate_candidates as
select
  least(a.id, b.id)  as customer_a,
  greatest(a.id, b.id) as customer_b,
  case
    when lower(btrim(a.email)) = lower(btrim(b.email)) then 'same email'
    when a.phone is not null and a.phone = b.phone then 'same phone'
    else 'same site address'
  end as reason
from public.clients a
join public.clients b
  on b.id <> a.id
 and (
   (a.email is not null and b.email is not null
    and lower(btrim(a.email)) = lower(btrim(b.email)))
   or (a.phone is not null and b.phone is not null and a.phone = b.phone)
   or exists (
     select 1
     from public.projects pa
     join public.projects pb on lower(btrim(pb.address)) = lower(btrim(pa.address))
     where pa.client_id = a.id and pb.client_id = b.id
       and pa.address is not null
       and lower(a.last_name) = lower(b.last_name)
   )
 )
where not a.is_archived and not b.is_archived
group by 1, 2, 3;

grant select on public.customer_duplicate_candidates to authenticated;

-- -----------------------------------------------------------------------------
-- Portal access for customers. The staff auth panel is admin-only by design,
-- but inviting a homeowner to watch their own job is everyday PM work — and
-- auth.admin_create_user deliberately issues no invite token for the customer
-- role, which predates the portal. So customer logins get their own three
-- functions here: read the state, invite, resend. Setting a password,
-- disabling access and forcing a logout stay on the admin-only auth engine.
-- -----------------------------------------------------------------------------

-- The list needs each customer's login state, and auth.users is not readable
-- by the authenticated role. Definer, and admin/PM only.
create or replace function public.customer_login_state()
returns table (
  client_id       uuid,
  user_id         uuid,
  login_email     text,
  is_active       boolean,
  last_sign_in_at timestamptz,
  invite_pending  boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'admin or PM only' using errcode = '42501';
  end if;
  return query
    select c.id, u.id, u.email, p.is_active, u.last_sign_in_at,
           exists (select 1 from auth.one_time_tokens t
                   where t.user_id = u.id and t.purpose = 'invite'
                     and t.consumed_at is null and t.expires_at > now())
    from public.clients c
    join auth.users u on u.id = c.user_id
    left join public.profiles p on p.id = u.id;
end;
$$;

revoke execute on function public.customer_login_state() from public, anon;
grant execute on function public.customer_login_state() to authenticated;

/**
 * Create the customer's portal login and return a one-time invite token. The
 * customer record and the login stay separate facts — the login points at the
 * customer — so this links them and leaves everything else alone.
 */
create or replace function public.customer_portal_invite(p_customer uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_name  text;
  v_user  uuid;
  v_token text;
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'admin or PM only' using errcode = '42501';
  end if;

  select nullif(btrim(c.email), ''), c.first_name || ' ' || c.last_name, c.user_id
  into v_email, v_name, v_user
  from public.clients c where c.id = p_customer;

  if not found then
    raise exception 'customer not found';
  end if;
  if v_email is null then
    raise exception 'customer has no email address' using errcode = '22023';
  end if;
  if v_user is not null then
    raise exception 'customer already has a login' using errcode = '23505';
  end if;

  insert into auth.users (email, raw_app_meta_data, raw_user_meta_data)
  values (lower(v_email), jsonb_build_object('user_role', 'customer'),
          jsonb_build_object('full_name', v_name))
  returning id into v_user;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into auth.one_time_tokens (user_id, purpose, token_hash, expires_at)
  values (v_user, 'invite', auth.hash_token(v_token), now() + interval '7 days');

  update public.clients set user_id = v_user where id = p_customer;

  perform app.write_audit('customer.portal_invited', 'clients', p_customer::text,
    null, null, null, jsonb_build_object('login', v_user));
  return v_token;
end;
$$;

revoke execute on function public.customer_portal_invite(uuid) from public, anon;
grant execute on function public.customer_portal_invite(uuid) to authenticated;

/** A fresh invite token; any earlier one stops working. */
create or replace function public.customer_portal_resend(p_customer uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user  uuid;
  v_token text;
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'admin or PM only' using errcode = '42501';
  end if;

  select c.user_id into v_user from public.clients c where c.id = p_customer;
  if v_user is null then
    raise exception 'customer has no login' using errcode = '22023';
  end if;
  if (select u.encrypted_password from auth.users u where u.id = v_user) is not null then
    raise exception 'customer has already set a password' using errcode = '22023';
  end if;

  update auth.one_time_tokens t set consumed_at = now()
  where t.user_id = v_user and t.purpose = 'invite' and t.consumed_at is null;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into auth.one_time_tokens (user_id, purpose, token_hash, expires_at)
  values (v_user, 'invite', auth.hash_token(v_token), now() + interval '7 days');

  perform app.write_audit('customer.portal_invite_resent', 'clients', p_customer::text);
  return v_token;
end;
$$;

revoke execute on function public.customer_portal_resend(uuid) from public, anon;
grant execute on function public.customer_portal_resend(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Merge. Everything that references the losing records is re-pointed to the
-- survivor; nothing is deleted. The caller has already chosen, field by field,
-- which values survive — they arrive as an explicit patch.
-- -----------------------------------------------------------------------------
create or replace function public.merge_customers(
  p_survivor uuid,
  p_merged   uuid[],
  /** Field values the admin chose to keep, as a jsonb object. */
  p_fields   jsonb default '{}'::jsonb,
  /** Which record's login remains (null = keep the survivor's). */
  p_keep_login uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_login    uuid;
  v_projects int;
  v_requests int;
  v_documents int;
  v_leads    int;
begin
  if not app.is_admin() then
    raise exception 'only an admin may merge customers' using errcode = '42501';
  end if;
  if p_survivor is null or coalesce(array_length(p_merged, 1), 0) = 0 then
    raise exception 'a survivor and at least one record to merge are required';
  end if;
  if p_survivor = any (p_merged) then
    raise exception 'the survivor cannot also be merged away';
  end if;
  if not exists (select 1 from public.clients where id = p_survivor) then
    raise exception 'surviving customer not found';
  end if;

  -- The login that remains: one carried across, or the survivor's own.
  v_login := coalesce(p_keep_login, (select user_id from public.clients where id = p_survivor));

  -- Clear the merged records' email and login FIRST, so the survivor can take
  -- either without tripping the case-insensitive unique email index.
  update public.clients
  set email = null,
      user_id = null,
      is_archived = true
  where id = any (p_merged);

  -- Apply the field-by-field choices, then the chosen email and login.
  update public.clients set
    first_name         = coalesce(p_fields ->> 'first_name', first_name),
    last_name          = coalesce(p_fields ->> 'last_name', last_name),
    email              = coalesce(p_fields ->> 'email', email),
    phone              = coalesce(p_fields ->> 'phone', phone),
    alternate_phone    = coalesce(p_fields ->> 'alternate_phone', alternate_phone),
    mailing_address    = coalesce(p_fields ->> 'mailing_address', mailing_address),
    preferred_contact  = coalesce(p_fields ->> 'preferred_contact', preferred_contact),
    preferred_language = coalesce(p_fields ->> 'preferred_language', preferred_language),
    internal_notes     = coalesce(p_fields ->> 'internal_notes', internal_notes),
    user_id            = v_login
  where id = p_survivor;

  -- Re-point everything the merged records own. Nothing is deleted.
  update public.projects set client_id = p_survivor where client_id = any (p_merged);
  update public.customer_requests set client_id = p_survivor where client_id = any (p_merged);

  -- Any customer login that no longer identifies a customer is disabled rather
  -- than deleted: a Customer login must never point at nothing.
  update public.profiles pr
  set is_active = false
  where pr.role = 'customer'
    and pr.id <> coalesce(v_login, '00000000-0000-0000-0000-000000000000'::uuid)
    and not exists (select 1 from public.clients c where c.user_id = pr.id);

  select count(*) into v_projects from public.projects where client_id = p_survivor;
  select count(*) into v_requests from public.customer_requests where client_id = p_survivor;
  select count(*) into v_documents
  from public.documents d
  join public.projects p on p.id = d.project_id
  where p.client_id = p_survivor;
  select count(*) into v_leads
  from public.leads l
  where l.converted_project_id in (select id from public.projects where client_id = p_survivor);

  return jsonb_build_object(
    'survivor', p_survivor,
    'merged', to_jsonb(p_merged),
    'projects', v_projects,
    'requests', v_requests,
    'documents', v_documents,
    'leads', v_leads,
    'login', v_login
  );
end;
$$;

revoke execute on function public.merge_customers(uuid, uuid[], jsonb, uuid) from public, anon;
grant execute on function public.merge_customers(uuid, uuid[], jsonb, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Anonymise. The right answer when a customer asks for their personal data to
-- be removed but projects exist: redact the person, keep the permit record,
-- the install date and the payment history the business must legally retain.
-- -----------------------------------------------------------------------------
create or replace function public.anonymise_customer(p_customer uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_login uuid;
begin
  if not app.is_admin() then
    raise exception 'only an admin may anonymise a customer' using errcode = '42501';
  end if;

  select user_id into v_login from public.clients where id = p_customer;

  update public.clients set
    first_name = 'Redacted',
    last_name  = 'Customer',
    email = null,
    phone = null,
    alternate_phone = null,
    mailing_address = null,
    internal_notes = null,
    address = '{}'::jsonb,
    user_id = null,
    is_archived = true,
    anonymised_at = now()
  where id = p_customer;

  -- The project keeps its site address and history; only the person's name is
  -- replaced where it was copied onto the project.
  update public.projects set name = 'Redacted Customer' where client_id = p_customer;

  -- The portal login is scrubbed through the auth engine's own path.
  if v_login is not null then
    perform auth.admin_delete_user(v_login);
  end if;
end;
$$;

revoke execute on function public.anonymise_customer(uuid) from public, anon;
grant execute on function public.anonymise_customer(uuid) to authenticated;



-- >>> 20260803002500_mobile_app.sql

-- =============================================================================
-- 002500 — Customer mobile app (installable portal, push, PM asks)
-- =============================================================================
-- Implements the "Customer mobile app" spec. Its section 0 is the whole
-- architecture: ONE database, ONE API, ONE set of RLS policies. There is no
-- mobile database, no mobile-specific table for project data, and nothing is
-- copied or synced. Everything added here is a shared concept the web portal
-- uses too:
--
--   * push_subscriptions / notification_preferences / push_deliveries — where a
--     device is reachable, what the customer agreed to receive, and what was
--     actually sent (so "under ten pushes per project" is measurable rather
--     than aspirational).
--   * customer_asks — the PM asking the customer for something. The portal's
--     "Needs your attention" card and the app's Photos upload prompt are two
--     renderings of the same rows.
--   * app_settings gains the store URLs, the minimum supported app version and
--     the public legal URLs both stores require.
--
-- Offline caching lives on the device as a read cache with a visible
-- 'last updated' stamp. The server stays the only authoritative copy.

-- -----------------------------------------------------------------------------
-- 1. Push subscriptions — one row per device, owned by the person using it
-- -----------------------------------------------------------------------------

create table if not exists public.push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  /** The push service URL. Unique: re-subscribing the same device updates. */
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,
  /** 'web' | 'ios' | 'android' — which shell registered it. */
  platform      text not null default 'web',
  user_agent    text,
  /** Consecutive send failures; a gone endpoint is pruned, not retried forever. */
  failure_count integer not null default 0,
  disabled_at   timestamptz,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id) where disabled_at is null;

alter table public.push_subscriptions enable row level security;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- Your own devices, nobody else's. Admins may look for support purposes.
drop policy if exists push_subscriptions_select on public.push_subscriptions;
create policy push_subscriptions_select on public.push_subscriptions
  for select to authenticated
  using (user_id = (select auth.uid()) or (select app.is_admin()));

drop policy if exists push_subscriptions_insert on public.push_subscriptions;
create policy push_subscriptions_insert on public.push_subscriptions
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists push_subscriptions_update on public.push_subscriptions;
create policy push_subscriptions_update on public.push_subscriptions
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists push_subscriptions_delete on public.push_subscriptions;
create policy push_subscriptions_delete on public.push_subscriptions
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- 2. Notification preferences — per category, matching the portal (spec §3.5)
-- -----------------------------------------------------------------------------

create table if not exists public.notification_preferences (
  user_id  uuid not null references public.profiles (id) on delete cascade,
  category text not null check (category in
    ('stage_advanced', 'appointment', 'action_needed', 'on_hold', 'power_on')),
  push     boolean not null default true,
  email    boolean not null default true,
  primary key (user_id, category)
);

alter table public.notification_preferences enable row level security;
grant select, insert, update, delete on public.notification_preferences to authenticated;

drop policy if exists notification_preferences_select on public.notification_preferences;
create policy notification_preferences_select on public.notification_preferences
  for select to authenticated
  using (user_id = (select auth.uid()) or (select app.is_admin()));

drop policy if exists notification_preferences_insert on public.notification_preferences;
create policy notification_preferences_insert on public.notification_preferences
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists notification_preferences_update on public.notification_preferences;
create policy notification_preferences_update on public.notification_preferences
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists notification_preferences_delete on public.notification_preferences;
create policy notification_preferences_delete on public.notification_preferences
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- 3. Delivery log — restraint you can audit, and duplicate suppression
-- -----------------------------------------------------------------------------

create table if not exists public.push_deliveries (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  project_id uuid references public.projects (id) on delete cascade,
  category   text not null,
  /** 'stage_advanced:permits' — sent at most once per project per person. */
  dedupe_key text,
  title      text not null,
  body       text not null,
  url        text not null,
  devices    integer not null default 0,
  failures   integer not null default 0,
  sent_at    timestamptz not null default now()
);

create unique index if not exists push_deliveries_dedupe_key
  on public.push_deliveries (user_id, project_id, dedupe_key)
  where dedupe_key is not null;

create index if not exists push_deliveries_project_idx
  on public.push_deliveries (project_id, sent_at desc);

alter table public.push_deliveries enable row level security;
grant select on public.push_deliveries to authenticated;

drop policy if exists push_deliveries_select on public.push_deliveries;
create policy push_deliveries_select on public.push_deliveries
  for select to authenticated
  using (user_id = (select auth.uid())
         or (select app.current_user_role()) in ('admin', 'ops'));

-- -----------------------------------------------------------------------------
-- 4. What the PM has asked the customer for
-- -----------------------------------------------------------------------------
-- The portal's 'Anything needed from you' card and the app's upload prompt are
-- the same rows. Fulfilment is recorded, so the card empties itself when the
-- photo arrives rather than nagging a customer who has already done it.

create table if not exists public.customer_asks (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  kind         text not null default 'photo'
                 check (kind in ('photo', 'document', 'information')),
  /** Customer-facing wording: 'A photo of your electricity meter'. */
  label        text not null,
  detail       text,
  requested_by uuid references public.profiles (id),
  created_at   timestamptz not null default now(),
  fulfilled_at timestamptz,
  fulfilled_document_id uuid references public.documents (id) on delete set null,
  cancelled_at timestamptz
);

create index if not exists customer_asks_open_idx
  on public.customer_asks (project_id)
  where fulfilled_at is null and cancelled_at is null;

alter table public.customer_asks enable row level security;
grant select, insert, update, delete on public.customer_asks to authenticated;

drop policy if exists customer_asks_select on public.customer_asks;
create policy customer_asks_select on public.customer_asks
  for select to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops')
         or app.can_access_project(project_id));

drop policy if exists customer_asks_insert on public.customer_asks;
create policy customer_asks_insert on public.customer_asks
  for insert to authenticated
  with check ((select app.current_user_role()) in ('admin', 'ops'));

drop policy if exists customer_asks_update on public.customer_asks;
create policy customer_asks_update on public.customer_asks
  for update to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops'))
  with check ((select app.current_user_role()) in ('admin', 'ops'));

drop policy if exists customer_asks_delete on public.customer_asks;
create policy customer_asks_delete on public.customer_asks
  for delete to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops'));

drop trigger if exists audit_row on public.customer_asks;
create trigger audit_row after insert or update or delete on public.customer_asks
  for each row execute function app.tg_audit_row();

-- -----------------------------------------------------------------------------
-- 5. Account deletion requests (spec §7 — both stores require an in-app route)
-- -----------------------------------------------------------------------------
-- Wired to the anonymise flow in the customer-management module: the customer
-- asks from the app, an admin carries it out, and the permit/install/payment
-- record the business must retain survives.

alter table public.customer_requests drop constraint if exists customer_requests_kind_check;
alter table public.customer_requests add constraint customer_requests_kind_check
  check (kind in ('availability', 'question', 'contact_update', 'document', 'account_deletion'));

-- -----------------------------------------------------------------------------
-- 6. App settings: store URLs, forced-update floor, public legal URLs
-- -----------------------------------------------------------------------------

alter table public.app_settings
  /** Below this version the shell shows a blocking update prompt (spec §8). */
  add column if not exists min_app_version   text,
  add column if not exists latest_app_version text,
  add column if not exists app_store_url     text,
  add column if not exists play_store_url    text,
  add column if not exists privacy_policy_url text,
  add column if not exists terms_url         text,
  add column if not exists support_email     text,
  add column if not exists support_phone     text;

-- app_settings is admin/ops-only, and rightly so. The handful of fields a
-- customer's device legitimately needs — the legal URLs both stores require,
-- and the version floor the shell checks before showing anything — come
-- through this definer function instead of widening that policy.
create or replace function public.app_public_settings()
returns table (
  company_name       text,
  min_app_version    text,
  latest_app_version text,
  app_store_url      text,
  play_store_url     text,
  privacy_policy_url text,
  terms_url          text,
  support_email      text,
  support_phone      text
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.company_name, s.min_app_version, s.latest_app_version,
         s.app_store_url, s.play_store_url, s.privacy_policy_url, s.terms_url,
         s.support_email, s.support_phone
  from public.app_settings s
  where s.id;
$$;

grant execute on function public.app_public_settings() to authenticated, anon;

-- -----------------------------------------------------------------------------
-- 7. Recording a push send — one place, so the log cannot be bypassed
-- -----------------------------------------------------------------------------
-- Returns false when this exact notification has already gone out for this
-- project, which is how 'stage advanced to permits' stays one push even if the
-- PM moves the project back and forth while correcting a mistake.

create or replace function public.claim_push_delivery(
  p_user_id    uuid,
  p_project_id uuid,
  p_category   text,
  p_dedupe_key text,
  p_title      text,
  p_body       text,
  p_url        text,
  p_devices    integer default 0
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'only staff may send notifications' using errcode = '42501';
  end if;

  insert into public.push_deliveries
    (user_id, project_id, category, dedupe_key, title, body, url, devices)
  values (p_user_id, p_project_id, p_category, p_dedupe_key, p_title, p_body, p_url, p_devices)
  on conflict (user_id, project_id, dedupe_key) where dedupe_key is not null
  do nothing
  returning id into v_id;

  return v_id;  -- null when it was already sent
end;
$$;

revoke execute on function
  public.claim_push_delivery(uuid, uuid, text, text, text, text, text, integer) from public, anon;
grant execute on function
  public.claim_push_delivery(uuid, uuid, text, text, text, text, text, integer) to authenticated;

-- Who to notify about a project, with their per-category choice already
-- applied. Definer because sending happens on the server on behalf of the
-- customer, and push_subscriptions is deliberately self-only for everyone else.
create or replace function public.push_targets_for_project(
  p_project_id uuid,
  p_category   text
)
returns table (
  user_id  uuid,
  endpoint text,
  p256dh   text,
  auth     text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'only staff may send notifications' using errcode = '42501';
  end if;
  return query
    select s.user_id, s.endpoint, s.p256dh, s.auth
    from public.push_subscriptions s
    join public.clients c on c.user_id = s.user_id
    join public.profiles pr on pr.id = s.user_id
    left join public.notification_preferences np
      on np.user_id = s.user_id and np.category = p_category
    where s.disabled_at is null
      and pr.is_active
      and c.id = (select p.client_id from public.projects p where p.id = p_project_id)
      -- No row means not yet chosen, and the default is on.
      and coalesce(np.push, true);
end;
$$;

revoke execute on function public.push_targets_for_project(uuid, text) from public, anon;
grant execute on function public.push_targets_for_project(uuid, text) to authenticated;

-- A dead endpoint (the push service answered 404/410) is retired rather than
-- retried forever. Definer for the same reason as above.
create or replace function public.retire_push_endpoint(p_endpoint text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'only staff may retire endpoints' using errcode = '42501';
  end if;
  update public.push_subscriptions
  set disabled_at = now(), failure_count = failure_count + 1
  where endpoint = p_endpoint;
end;
$$;

revoke execute on function public.retire_push_endpoint(text) from public, anon;
grant execute on function public.retire_push_endpoint(text) to authenticated;

-- -----------------------------------------------------------------------------
-- 8. Fulfilling an ask from the customer's upload
-- -----------------------------------------------------------------------------
-- The customer taps 'Take photo' against a specific ask; the upload closes it.
-- Definer, because customer_asks is staff-writable only — the homeowner may
-- satisfy an ask, not invent or reword one.

create or replace function public.fulfil_customer_ask(
  p_ask_id      uuid,
  p_document_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
begin
  select a.project_id into v_project
  from public.customer_asks a
  where a.id = p_ask_id and a.fulfilled_at is null and a.cancelled_at is null;
  if v_project is null then
    return;  -- already done, cancelled, or gone: nothing to close
  end if;

  if app.current_user_role() = 'customer'
     and v_project not in (select p.id from public.projects p
                           where p.client_id in (select app.current_client_ids())) then
    raise exception 'not your project' using errcode = '42501';
  end if;

  update public.customer_asks
  set fulfilled_at = now(), fulfilled_document_id = p_document_id
  where id = p_ask_id;
end;
$$;

revoke execute on function public.fulfil_customer_ask(uuid, uuid) from public, anon;
grant execute on function public.fulfil_customer_ask(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 9. Who to call — the most-used control on the Home screen (spec §3.1)
-- -----------------------------------------------------------------------------
-- profiles is self-or-admin by RLS, quite rightly: a customer has no business
-- reading the staff directory. But that also meant the portal could never show
-- the assigned PM's name or number, so 'Call my project manager' rendered as
-- 'being assigned' for everyone. This returns exactly three fields, for one
-- project the caller can already see, and nothing else about that person.

create or replace function public.project_contact(p_project_id uuid)
returns table (
  pm_name  text,
  pm_phone text,
  pm_email text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not app.can_access_project(p_project_id) then
    raise exception 'not your project' using errcode = '42501';
  end if;
  return query
    select coalesce(pr.full_name, pr.email), pr.phone, pr.email
    from public.projects p
    join public.profiles pr on pr.id = p.assigned_pm
    where p.id = p_project_id and pr.is_active and pr.deleted_at is null;
end;
$$;

revoke execute on function public.project_contact(uuid) from public, anon;
grant execute on function public.project_contact(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 10. Customer-facing wording for the new surfaces
-- -----------------------------------------------------------------------------

insert into public.customer_phrases (domain, value, phrase) values
  ('push_title', 'stage_advanced', 'Your project has moved forward'),
  ('push_title', 'appointment',    'Your appointment is confirmed'),
  ('push_title', 'action_needed',  'Something is needed from you'),
  ('push_title', 'on_hold',        'Your project is temporarily paused'),
  ('push_title', 'power_on',       'Your system is switched on'),
  ('notify_label', 'stage_advanced', 'When my project moves to a new stage'),
  ('notify_label', 'appointment',    'Survey and installation dates, plus reminders'),
  ('notify_label', 'action_needed',  'When you need something from me'),
  ('notify_label', 'on_hold',        'If my project is paused'),
  ('notify_label', 'power_on',       'When my system is switched on')
on conflict (domain, value) do nothing;



-- >>> 20260803002600_customer_passwords.sql

-- =============================================================================
-- 002600 — Homeowners sign in with a password
-- =============================================================================
-- The original design gave customers a one-time email code instead of a
-- password: nothing to remember, nothing to reset. In practice a homeowner
-- opening an app once a week does not want to fetch a code from their inbox
-- every time — they want the password their phone's keychain already filled in.
--
-- The auth engine already accepts a customer password (auth.login_with_password
-- has never cared about role) and 002400 gave admins the tools to set one. Two
-- things still encoded the old assumption:
--
--   1. auth.request_recovery returned nothing for a customer, so 'forgot my
--      password' was impossible for them — and the 'Send reset link' button in
--      Admin → Customers silently did nothing.
--   2. The homeowner door offered only the code form.
--
-- This migration fixes (1). The door is fixed in the app.

create or replace function auth.request_recovery(p_email text)
returns table (recovery_token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user auth.users%rowtype;
  v_active boolean;
  v_token text;
begin
  select u.* into v_user from auth.users u where lower(u.email) = lower(p_email);
  if not found then
    return;   -- no account oracle: the caller always sees the same answer
  end if;

  select p.is_active into v_active from public.profiles p where p.id = v_user.id;

  -- Every active account may reset a password, homeowners included. A customer
  -- who has never set one (mid-invitation) is deliberately allowed too: the
  -- token lets them finish, which is exactly what someone who lost the
  -- invitation email needs.
  if not coalesce(v_active, false) then
    return;
  end if;

  update auth.one_time_tokens t
  set consumed_at = now()
  where t.user_id = v_user.id and t.purpose = 'recovery' and t.consumed_at is null;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into auth.one_time_tokens (user_id, purpose, token_hash, expires_at)
  values (v_user.id, 'recovery', auth.hash_token(v_token), now() + interval '1 hour');

  return query select v_token;
end;
$$;

-- -----------------------------------------------------------------------------
-- Creating a homeowner's login with a password directly
-- -----------------------------------------------------------------------------
-- 002400 gave PMs an invite path (public.customer_portal_invite) where the
-- customer sets their own password from an emailed link. This is the other half,
-- for the customer who says 'just tell me a password on the phone': the admin
-- sets one now, and the customer is asked to change it on first sign-in.
--
-- Admin-only, because it hands out a working credential.

create or replace function public.customer_portal_set_initial_password(
  p_customer uuid,
  p_password text,
  /** Ask them to choose their own on first sign-in. Default yes. */
  p_force_change boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_name  text;
  v_user  uuid;
begin
  if not app.is_admin() then
    raise exception 'only an admin may set a customer password' using errcode = '42501';
  end if;
  if length(coalesce(p_password, '')) < 10 then
    raise exception 'password must be at least 10 characters' using errcode = '22023';
  end if;

  select nullif(btrim(c.email), ''), c.first_name || ' ' || c.last_name, c.user_id
  into v_email, v_name, v_user
  from public.clients c where c.id = p_customer;

  if not found then
    raise exception 'customer not found';
  end if;
  if v_email is null then
    raise exception 'customer has no email address' using errcode = '22023';
  end if;

  if v_user is null then
    -- No login yet: create one that works immediately.
    insert into auth.users (email, encrypted_password, email_confirmed_at,
                            force_password_change, raw_app_meta_data, raw_user_meta_data)
    values (lower(v_email),
            extensions.crypt(p_password, extensions.gen_salt('bf', 12)),
            now(),
            p_force_change,
            jsonb_build_object('user_role', 'customer'),
            jsonb_build_object('full_name', v_name))
    returning id into v_user;

    update public.clients set user_id = v_user where id = p_customer;
  else
    update auth.users u
    set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 12)),
        email_confirmed_at = coalesce(u.email_confirmed_at, now()),
        force_password_change = p_force_change,
        failed_attempts = 0, locked_until = null, updated_at = now()
    where u.id = v_user;

    -- Any outstanding invitation is spent: the password just set is the way in.
    update auth.one_time_tokens t set consumed_at = now()
    where t.user_id = v_user and t.purpose = 'invite' and t.consumed_at is null;

    -- Existing sessions die, exactly as they do for a staff password change.
    perform auth.revoke_all_sessions(v_user);
  end if;

  -- The profile must exist and be active for the login to be usable; the
  -- on_auth_user_created trigger creates it, this makes the role explicit.
  update public.profiles set role = 'customer', is_active = true where id = v_user;

  perform app.write_audit('customer.portal_password_set', 'clients', p_customer::text,
    null, null, null, jsonb_build_object('login', v_user, 'force_change', p_force_change));

  return v_user;
end;
$$;

revoke execute on function
  public.customer_portal_set_initial_password(uuid, text, boolean) from public, anon;
grant execute on function
  public.customer_portal_set_initial_password(uuid, text, boolean) to authenticated;



-- >>> 20260803002700_invite_customers_with_tokens.sql

-- =============================================================================
-- 002700 — Auto-invited homeowners get a set-password link
-- =============================================================================
-- Fallout from 002600, found while auditing the password surfaces.
--
-- auth.create_invited_user() skipped the invite token when the role was
-- 'customer', because in the original design homeowners had no password to set.
-- Project creation and lead conversion both call it to auto-invite the
-- homeowner — so after 002600 removed the code door, every automatically
-- invited customer got a login with no password and no way to obtain one. Locked
-- out, silently.
--
-- Now every role gets the same 7-day, single-use link.
--
-- (The one deliberate remaining path without a token is an admin setting a
-- password directly — public.customer_portal_set_initial_password — where the
-- password itself is the way in.)

create or replace function auth.create_invited_user(
  p_email     text,
  p_role      text,
  p_full_name text default null
)
returns table (user_id uuid, invite_token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id    uuid;
  v_token text;
begin
  -- The original guard, kept exactly: when a user context exists only admins
  -- may invite, but a call with no context is a trusted server-side bootstrap
  -- (scripts/create-admin.mjs, and the SQL test suite). require_admin() would
  -- reject those, which is not the same rule.
  if auth.uid() is not null and app.current_user_role() is distinct from 'admin' then
    raise exception 'only admins may invite users' using errcode = '42501';
  end if;

  if p_role not in ('admin', 'ops', 'designer', 'finance', 'dealer', 'customer') then
    raise exception 'invalid role %', p_role;
  end if;

  insert into auth.users (email, raw_app_meta_data, raw_user_meta_data)
  values (
    lower(p_email),
    jsonb_build_object('user_role', p_role),
    case when p_full_name is null then '{}'::jsonb
         else jsonb_build_object('full_name', p_full_name) end
  )
  returning id into v_id;

  -- Every role, homeowners included (002600).
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into auth.one_time_tokens (user_id, purpose, token_hash, expires_at)
  values (v_id, 'invite', auth.hash_token(v_token), now() + interval '7 days');

  return query select v_id, v_token;
end;
$$;

-- Same omission in the admin panel's creation function: with no password and a
-- customer role it produced a login nobody could ever use.
create or replace function auth.admin_create_user(
  p_email        text,
  p_role         text,
  p_full_name    text default null,
  p_phone        text default null,
  p_password     text default null,
  p_force_change boolean default true
)
returns table (user_id uuid, invite_token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_token text;
begin
  perform auth.require_admin();
  if p_role not in ('admin', 'ops', 'designer', 'finance', 'dealer', 'customer') then
    raise exception 'invalid role %', p_role;
  end if;
  if p_password is not null and length(p_password) < 8 then
    raise exception 'password must be at least 8 characters';
  end if;

  insert into auth.users (email, raw_app_meta_data, raw_user_meta_data,
                          encrypted_password, email_confirmed_at, force_password_change)
  values (
    lower(p_email),
    jsonb_build_object('user_role', p_role),
    case when p_full_name is null then '{}'::jsonb
         else jsonb_build_object('full_name', p_full_name) end,
    case when p_password is null then null
         else extensions.crypt(p_password, extensions.gen_salt('bf', 12)) end,
    case when p_password is null then null else now() end,
    p_password is not null and p_force_change
  )
  returning id into v_id;

  if p_phone is not null then
    update public.profiles set phone = p_phone where id = v_id;
  end if;

  -- No password means an invitation is the only way in — for every role.
  if p_password is null then
    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    insert into auth.one_time_tokens (user_id, purpose, token_hash, expires_at)
    values (v_id, 'invite', auth.hash_token(v_token), now() + interval '7 days');
  end if;

  perform app.write_audit('user.created', 'profiles', v_id::text, null, null, null,
    jsonb_build_object('role', p_role, 'method',
      case when p_password is null then 'invite' else 'password_set_by_admin' end));

  return query select v_id, v_token;
end;
$$;

-- -----------------------------------------------------------------------------
-- Close the emailed-code door in the database too
-- -----------------------------------------------------------------------------
-- 002600 removed the one-time-code login from the app and deleted its routes.
-- The engine functions were left in place, still granted to the app role — a
-- login path nothing exposes, nobody maintains, and which can mint tokens and
-- send nothing. Revoking execute makes 'homeowners use passwords' true at every
-- layer instead of only in the UI.
--
-- The functions themselves are kept, not dropped: they are referenced by the
-- 001000 grant block, and a future release that genuinely wants a code login
-- should re-grant deliberately rather than rediscover them by accident.

revoke execute on function auth.request_otp(text) from authenticated, anon, public;
revoke execute on function auth.verify_otp(text, text) from authenticated, anon, public;



-- >>> 20260803002800_dashboard.sql

-- =============================================================================
-- 002800 — Analytics dashboard
-- =============================================================================
-- Implements the Dashboard Module specification. The whole module rests on one
-- idea from spec §1: nothing is a hand-maintained list. Every figure is a live
-- aggregate over whatever exists in the database right now, grouped by
-- assigned_pm / dealer_id / stage — never by a chart configured with today's
-- five PMs. A new hire's projects therefore appear in the totals the first time
-- one is assigned to them, with no dashboard edit.
--
-- What this migration adds:
--   1. public.stage_thresholds — the per-stage ageing thresholds, in the
--      database rather than in code, because §7 and §10 both say they will be
--      re-tuned repeatedly in the first months.
--   2. public.project_metrics — ONE row per project carrying every figure the
--      dashboard derives: days in stage, hold days, the seven per-stage day
--      counters, total days with and without hold time, the age band, and
--      whether the project is past its stage's threshold. Every chart is a
--      `group by` over this view, which is what keeps §10's "aggregate in SQL,
--      not in the browser" honest.
--   3. Indexes on the columns those group-bys actually use.
--   4. Two app_settings fields: the on-hold amber threshold and whether the
--      ops role sees the financial cards (§8).
--
-- Not added, deliberately: a materialised view. §10 offers one "when needed"
-- for cycle-time aggregates, and it is not needed yet — but more to the point,
-- this deployment has no scheduler (everything is operated from a browser), so
-- a materialised view would go stale with nothing to refresh it and quietly
-- report last week's numbers. An ordinary view that is always right beats a
-- fast one that is sometimes wrong. Revisit when there is a cron and a few
-- thousand projects.

-- -----------------------------------------------------------------------------
-- 1. Per-stage ageing thresholds (admin config, spec §7)
-- -----------------------------------------------------------------------------
-- "A week in Procurement is fine, a week in Installation is not" — so this is
-- one row per stage, not one global number.

create table if not exists public.stage_thresholds (
  stage          public.project_stage primary key,
  attention_days integer not null check (attention_days between 1 and 3650),
  updated_at     timestamptz not null default now()
);

insert into public.stage_thresholds (stage, attention_days) values
  ('survey',         10),
  ('design',         14),
  ('permits',        30),
  ('procurement',    21),
  ('install',         7),
  ('inspection_pto', 30),
  -- Complete is terminal; it never ages. A real number rather than a null
  -- keeps every join inner and every comparison total.
  ('complete',     3650)
on conflict (stage) do nothing;

alter table public.stage_thresholds enable row level security;
grant select on public.stage_thresholds to authenticated;
grant insert, update on public.stage_thresholds to authenticated;

-- Readable by everyone signed in: the same threshold decides what appears in a
-- dealer's own ageing list, and the number itself reveals nothing.
drop policy if exists stage_thresholds_select on public.stage_thresholds;
create policy stage_thresholds_select on public.stage_thresholds
  for select to authenticated using (true);

drop policy if exists stage_thresholds_write on public.stage_thresholds;
create policy stage_thresholds_write on public.stage_thresholds
  for update to authenticated
  using ((select app.is_admin())) with check ((select app.is_admin()));

drop policy if exists stage_thresholds_insert on public.stage_thresholds;
create policy stage_thresholds_insert on public.stage_thresholds
  for insert to authenticated with check ((select app.is_admin()));

drop trigger if exists set_updated_at on public.stage_thresholds;
create trigger set_updated_at before update on public.stage_thresholds
  for each row execute function app.tg_set_updated_at();

drop trigger if exists audit_row on public.stage_thresholds;
create trigger audit_row after update on public.stage_thresholds
  for each row execute function app.tg_audit_row();

-- -----------------------------------------------------------------------------
-- 2. app_settings: the two dashboard-wide numbers
-- -----------------------------------------------------------------------------

alter table public.app_settings
  /** Projects-on-hold card turns amber above this (spec §3). */
  add column if not exists on_hold_alert_threshold integer not null default 5,
  /** §8: the PM/Ops view hides the financial cards unless this is granted.
      Note this is a presentation choice, not a new security boundary: ops can
      already read projects.contract_value directly through the projects table.
      It is honoured server-side (the query is not run at all) rather than by
      hiding a rendered chart, which §10 rules out. */
  add column if not exists ops_see_financials boolean not null default false;

-- -----------------------------------------------------------------------------
-- 3. public.project_metrics — the one row per project every chart groups over
-- -----------------------------------------------------------------------------
-- security_invoker = true is the important word in this file. It makes the view
-- run under the *caller's* privileges, so public.projects' own RLS policy
-- decides which rows they get: an admin sees the company, a dealer sees their
-- book, a customer sees their house. That is spec §8's "scoped by row-level
-- security, never a filter" — the dealer dashboard and the admin dashboard are
-- the same query, and there is no filter to forget to apply.
--
-- (Two joins are deliberately left to RLS as well. profiles is self-or-staff,
-- so pm_name comes back null for a dealer or a finance user — neither of whom
-- gets a by-PM chart. The absence is the policy working, not a bug.)
--
-- Dropped rather than replaced: create-or-replace cannot change a view's column
-- list, and this one will grow.

drop view if exists public.project_metrics;

create view public.project_metrics
with (security_invoker = true)
as
with stage_since as (
  select p.id as project_id,
         coalesce(
           (select max(e.changed_at) from public.project_stage_events e
             where e.project_id = p.id),
           p.created_at
         ) as since
  from public.projects p
),
holds as (
  -- Total days spent held, open holds counted to today. This is what "excluding
  -- hold time" (§5) subtracts: without it, one project parked for a month for a
  -- customer's holiday drags every timing figure on the page.
  select h.project_id,
         sum(coalesce(h.resume_date, current_date) - h.hold_start_date) as hold_days,
         count(*) as hold_count,
         max(h.expected_resume_date) filter (where h.resume_date is null) as expected_resume_date,
         max(h.hold_start_date) filter (where h.resume_date is null) as open_hold_started
  from public.project_holds h
  group by h.project_id
)
select
  p.id,
  p.code,
  p.name,
  p.address,
  p.dealer_id,
  dl.name                              as dealer_name,
  -- Carried so the dealer portal can honour a company's reps_see_own_only
  -- setting: without it, the dealer's own reduced dashboard would show a rep
  -- their colleagues' projects, which the rest of that portal does not.
  p.sales_rep_id,
  p.client_id,
  nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '') as client_name,
  p.assigned_pm,
  coalesce(pm.full_name, pm.email)     as pm_name,
  p.jurisdiction_id,
  j.name                               as jurisdiction_name,
  p.stage,
  p.status,
  p.system_size_kw,
  p.contract_value,
  p.created_at,
  date_trunc('month', p.created_at)::date as created_month,

  -- Where it is now, and for how long.
  ss.since                             as stage_since,
  greatest(0, (current_date - ss.since::date)) as days_in_stage,

  -- Age band for the funnel colouring (§4). A stage that is merely busy has to
  -- look different from one that is jammed, which needs the bands here rather
  -- than a count.
  case
    when (current_date - ss.since::date) <= 14 then '0-14'
    when (current_date - ss.since::date) <= 30 then '15-30'
    when (current_date - ss.since::date) <= 60 then '31-60'
    else '60+'
  end                                  as age_band,

  -- coalesce, and a LEFT join below, so that adding a stage to the enum without
  -- remembering to add its threshold row degrades to a default rather than
  -- silently dropping every project in that stage out of every chart.
  coalesce(th.attention_days, 21)      as attention_days,
  (p.status = 'active'
   and p.stage <> 'complete'
   and (current_date - ss.since::date) > coalesce(th.attention_days, 21)) as is_ageing,

  coalesce(h.hold_days, 0)             as hold_days,
  coalesce(h.hold_count, 0)            as hold_count,
  h.expected_resume_date,
  h.open_hold_started,
  -- Held with no expected resume date at all is the worse case of the two, and
  -- §7 wants both in the same list.
  (p.status = 'on_hold'
   and (h.expected_resume_date is null or h.expected_resume_date < current_date)) as hold_overdue,

  -- Completion.
  s7.completion_date,
  date_trunc('month', s7.completion_date)::date as completed_month,
  case when s7.completion_date is not null
       then greatest(0, s7.completion_date - p.created_at::date) end as total_days,
  case when s7.completion_date is not null
       then greatest(0, (s7.completion_date - p.created_at::date) - coalesce(h.hold_days, 0)) end
                                       as total_days_ex_hold,

  -- Cancellation: stage_cancelled_from is the single most useful figure for
  -- where projects are lost (§7's "recently cancelled" list).
  cx.cancellation_date,
  cx.stage_cancelled_from              as cancelled_from,
  cx.reason                            as cancel_reason,

  -- The date each stage finished. §5 averages "across projects completing that
  -- stage in the period", so the period filter needs the finishing date, not
  -- only the duration.
  s1.survey_completed_date             as survey_done_on,
  s2.design_received_date              as design_done_on,
  s3.permit_received_date              as permit_done_on,
  s4.material_delivered_date           as material_done_on,
  s5.install_completed_date            as install_done_on,
  s6.inspection_completed_date         as inspection_done_on,
  s6.pto_received_date                 as pto_done_on,

  -- The seven per-stage day counters of §5, read from the same date pairs the
  -- stage-field registry defines (src/lib/stages/fields.ts). Site Survey has no
  -- 'from' date in the registry, so it counts from project creation — which is
  -- also the honest measure of how long a homeowner waited for their survey.
  case when s1.survey_completed_date is not null
       then greatest(0, s1.survey_completed_date - p.created_at::date) end as survey_days,
  case when s2.design_received_date is not null and s2.design_requested_date is not null
       then greatest(0, s2.design_received_date - s2.design_requested_date) end as design_days,
  case when s3.permit_received_date is not null and s3.permit_applied_date is not null
       then greatest(0, s3.permit_received_date - s3.permit_applied_date) end as permit_days,
  case when s4.material_delivered_date is not null and s4.material_requested_date is not null
       then greatest(0, s4.material_delivered_date - s4.material_requested_date) end as material_days,
  case when s5.install_completed_date is not null and s5.install_requested_date is not null
       then greatest(0, s5.install_completed_date - s5.install_requested_date) end as install_days,
  case when s6.inspection_completed_date is not null and s6.inspection_requested_date is not null
       then greatest(0, s6.inspection_completed_date - s6.inspection_requested_date) end as inspection_days,
  case when s6.pto_received_date is not null and s6.pto_applied_date is not null
       then greatest(0, s6.pto_received_date - s6.pto_applied_date) end as pto_days
from public.projects p
join stage_since ss on ss.project_id = p.id
left join public.stage_thresholds th on th.stage = p.stage
left join holds h on h.project_id = p.id
left join public.dealers dl on dl.id = p.dealer_id
left join public.clients c on c.id = p.client_id
left join public.profiles pm on pm.id = p.assigned_pm
left join public.jurisdictions j on j.id = p.jurisdiction_id
left join public.stage1_survey s1 on s1.project_id = p.id
left join public.stage2_design s2 on s2.project_id = p.id
left join public.stage3_permit s3 on s3.project_id = p.id
left join public.stage4_procurement s4 on s4.project_id = p.id
left join public.stage5_install s5 on s5.project_id = p.id
left join public.stage6_inspection s6 on s6.project_id = p.id
left join public.stage7_complete s7 on s7.project_id = p.id
left join public.project_cancellation cx on cx.project_id = p.id and cx.reinstated_at is null;

grant select on public.project_metrics to authenticated;
revoke insert, update, delete on public.project_metrics from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. public.project_financial_metrics — the finance role's slice
-- -----------------------------------------------------------------------------
-- The finance role cannot read public.projects at all: its RLS policy admits
-- admin, ops, the assigned designer, the dealer and the customer, and finance is
-- deliberately none of those. Everything finance sees arrives through a
-- definer view whitelisting the financial columns — public.project_financials,
-- since 001200. project_metrics inherits that exclusion (security_invoker), so
-- it returns zero rows for finance, which is correct but useless.
--
-- So the finance dashboard reads this second view instead: the same shape of
-- gate as project_financials (owner's privileges, role checked in the WHERE),
-- carrying only what §8 grants finance — "pipeline value, completion volumes and
-- milestone-payment status; no workload or stage-detail charts". There is
-- deliberately no assigned_pm and no per-stage day counter here: the view
-- physically cannot answer a workload or cycle-time-by-stage question, so that
-- rule holds even if someone later writes the wrong query against it.
--
-- The payment-milestone statuses are the one addition beyond project_financials.
-- They are financial state — who has paid which milestone — which is the finance
-- role's own subject, and they carry no notes, costs or margins.

drop view if exists public.project_financial_metrics;

create view public.project_financial_metrics
with (security_barrier = true, security_invoker = false)
as
select
  p.id,
  p.code,
  p.name,
  p.dealer_id,
  dl.name                     as dealer_name,
  p.stage,
  p.status,
  p.system_size_kw,
  p.contract_value,
  p.dealer_fee,
  p.amount_invoiced,
  p.amount_paid,
  p.created_at,
  date_trunc('month', p.created_at)::date as created_month,
  s7.completion_date,
  date_trunc('month', s7.completion_date)::date as completed_month,
  case when s7.completion_date is not null
       then greatest(0, s7.completion_date - p.created_at::date) end as total_days,
  cx.cancellation_date,
  -- Milestone-payment status (§8).
  s1.down_payment_status,
  s1.cash_m1_status,
  s3.cash_m2_status,
  s5.cash_m3_status,
  fm.m1_status,
  fm.m2_status
from public.projects p
left join public.dealers dl on dl.id = p.dealer_id
left join public.stage1_survey s1 on s1.project_id = p.id
left join public.stage3_permit s3 on s3.project_id = p.id
left join public.stage5_install s5 on s5.project_id = p.id
left join public.stage7_complete s7 on s7.project_id = p.id
left join public.finance_milestones fm on fm.project_id = p.id
left join public.project_cancellation cx on cx.project_id = p.id and cx.reinstated_at is null
where (select app.current_user_role()) in ('finance', 'admin');

grant select on public.project_financial_metrics to authenticated;
revoke insert, update, delete on public.project_financial_metrics from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. Indexes — §10 says early, and it is right
-- -----------------------------------------------------------------------------
-- Almost every chart groups by stage, assigned_pm, dealer_id or status, or
-- filters on one of the three date fields. stage / assigned_pm / dealer_id /
-- client_id / jurisdiction_id are already indexed (000200, 001200); these are
-- the ones the dashboard adds.

create index if not exists projects_status_idx on public.projects (status);
create index if not exists projects_created_at_idx on public.projects (created_at);
-- The commonest dashboard shape: one dealer's or one PM's active book.
create index if not exists projects_dealer_status_idx on public.projects (dealer_id, status);
create index if not exists projects_pm_status_idx on public.projects (assigned_pm, status);
-- "Completed this period" and the completion-time trend both range-scan this.
create index if not exists stage7_complete_completion_date_idx
  on public.stage7_complete (completion_date);
create index if not exists project_cancellation_date_idx
  on public.project_cancellation (cancellation_date);
-- Hold days are summed per project on every dashboard render.
create index if not exists project_holds_project_idx
  on public.project_holds (project_id, hold_start_date);



-- >>> 20260803002900_project_chat.sql

-- =============================================================================
-- 002900 — Project chat (PM ↔ customer)
-- =============================================================================
-- Implements the Project Chat specification: one thread per project, between
-- the PM and that project's customer, living on the project record so the whole
-- history stays with the job.
--
-- Two rules in this file are load-bearing, and both are enforced in the
-- database rather than left to the application:
--
--  1. §6 — internal notes and customer messages are different things. A
--     customer's SELECT cannot return an internal note, whatever query the app
--     sends, and a customer's INSERT cannot create one. The UI puts them on two
--     separate tabs with different colours; this is the layer that makes the
--     mistake impossible rather than merely unlikely.
--
--  2. §2 — dealers have no access. app.can_access_project() admits dealers and
--     designers, so it is deliberately NOT the test used here: the thread is
--     visible to staff (admin/ops) and to the project's own customer, and to
--     nobody else. Getting this wrong would put the dealer inside a
--     conversation the customer believes is private with their PM.
--
-- Also deliberate: sender_role is derived from the caller's own role inside a
-- definer function, never accepted as a parameter. A posting API that takes
-- "who this is from" is one bug away from a customer message that claims to be
-- from the PM.

-- -----------------------------------------------------------------------------
-- 1. The thread
-- -----------------------------------------------------------------------------

create table if not exists public.project_messages (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id) on delete cascade,
  /** Null once a staff account is deleted; the message and its role remain. */
  sender_user_id uuid references public.profiles (id) on delete set null,
  sender_role    text not null check (sender_role in ('customer', 'staff', 'system')),
  body           text not null check (length(btrim(body)) > 0 and length(body) <= 8000),
  /** 'about: Permit' — set when the thread is opened from a stage (§3). */
  stage_ref      public.project_stage,
  is_internal    boolean not null default false,
  /**
   * When the *other* party read it. A customer message is read by staff; a
   * staff message is read by the customer. §3: the PM sees the customer's read
   * receipt, the customer never sees the PM's — so this column is only ever
   * shown to staff.
   */
  read_at        timestamptz,
  edited_at      timestamptz,
  created_at     timestamptz not null default now(),
  -- System lines are never internal and never have a human sender.
  constraint project_messages_system_shape
    check (sender_role <> 'system' or (not is_internal and sender_user_id is null)),
  -- A customer's message is a customer message; it cannot be an internal note.
  constraint project_messages_customer_not_internal
    check (sender_role <> 'customer' or not is_internal)
);

-- §8: index on (project_id, created_at). Newest-first, because that is how the
-- thread is read and paged.
create index if not exists project_messages_thread_idx
  on public.project_messages (project_id, created_at desc);
-- The unread badges the PM sees on every surface.
create index if not exists project_messages_unread_idx
  on public.project_messages (project_id)
  where read_at is null and sender_role = 'customer';

-- Attachments are a join to public.documents rather than a column of file
-- names, because §3 requires every attachment to be filed to the project's
-- documents as well — "so nothing sent in conversation goes missing from the
-- record". One row here means one real document row, with a foreign key to
-- prove it, instead of two places that can disagree.
create table if not exists public.message_attachments (
  message_id  uuid not null references public.project_messages (id) on delete cascade,
  document_id uuid not null references public.documents (id) on delete cascade,
  primary key (message_id, document_id)
);

create index if not exists message_attachments_document_idx
  on public.message_attachments (document_id);

-- A PM can flag a thread to come back to (§5). One row per project, because
-- the flag belongs to the thread rather than to a person: whoever is covering
-- needs to see it.
create table if not exists public.project_chat_flags (
  project_id uuid primary key references public.projects (id) on delete cascade,
  flagged_at timestamptz not null default now(),
  flagged_by uuid references public.profiles (id) on delete set null,
  note       text
);

-- -----------------------------------------------------------------------------
-- 2. Who may see and post
-- -----------------------------------------------------------------------------

-- The project's own homeowner. Not app.can_access_project(), which also admits
-- the dealer and the assigned designer — see the header.
create or replace function app.is_project_customer(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.projects p
    where p.id = pid
      and p.client_id in (select app.current_client_ids())
  );
$$;

grant execute on function app.is_project_customer(uuid) to authenticated;

alter table public.project_messages enable row level security;
alter table public.message_attachments enable row level security;
alter table public.project_chat_flags enable row level security;

grant select on public.project_messages to authenticated;
grant select on public.message_attachments to authenticated;
grant select, insert, update, delete on public.project_chat_flags to authenticated;

-- Reads. Staff see everything including internal notes; the homeowner sees
-- their own project's customer-visible messages and nothing else. There is no
-- branch here that a dealer or a designer can satisfy.
drop policy if exists project_messages_select on public.project_messages;
create policy project_messages_select on public.project_messages
  for select to authenticated
  using (
    (select app.current_user_role()) in ('admin', 'ops')
    or (not is_internal and app.is_project_customer(project_id))
  );

-- Writes go through public.post_project_message() only: sender_role and
-- is_internal must be derived from the caller, not supplied by them. No insert,
-- update or delete policy exists, so even a compromised app role cannot write a
-- message that claims to be from someone else — and nobody can delete one,
-- which §3 requires ("this is a business record, not a chat app").
revoke insert, update, delete on public.project_messages from authenticated;
revoke insert, update, delete on public.message_attachments from authenticated;

drop policy if exists message_attachments_select on public.message_attachments;
create policy message_attachments_select on public.message_attachments
  for select to authenticated
  using (
    exists (
      select 1 from public.project_messages m
      where m.id = message_id
        and (
          (select app.current_user_role()) in ('admin', 'ops')
          or (not m.is_internal and app.is_project_customer(m.project_id))
        )
    )
  );

-- The needs-reply flag is a staff tool; the customer must not see it at all.
drop policy if exists project_chat_flags_select on public.project_chat_flags;
create policy project_chat_flags_select on public.project_chat_flags
  for select to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops'));

drop policy if exists project_chat_flags_write on public.project_chat_flags;
create policy project_chat_flags_write on public.project_chat_flags
  for all to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops'))
  with check ((select app.current_user_role()) in ('admin', 'ops'));

-- -----------------------------------------------------------------------------
-- 3. Posting
-- -----------------------------------------------------------------------------
-- One function for both parties. It decides who the sender is from the session,
-- refuses an internal note from a customer, and refuses either of them on a
-- project that is not theirs.

create or replace function public.post_project_message(
  p_project_id uuid,
  p_body       text,
  p_internal   boolean default false,
  p_stage_ref  text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := app.current_user_role();
  v_sender_role text;
  v_id uuid;
  v_stage public.project_stage;
begin
  if p_body is null or length(btrim(p_body)) = 0 then
    raise exception 'a message cannot be empty';
  end if;
  if length(p_body) > 8000 then
    raise exception 'a message must be 8000 characters or fewer';
  end if;

  if v_role in ('admin', 'ops') then
    v_sender_role := 'staff';
  elsif v_role = 'customer' and app.is_project_customer(p_project_id) then
    v_sender_role := 'customer';
    -- Belt and braces: the check constraint says the same thing, but an
    -- explicit refusal here is the one a caller can read in the error.
    if coalesce(p_internal, false) then
      raise exception 'a customer cannot write an internal note' using errcode = '42501';
    end if;
  else
    -- Dealers, designers, finance and anyone else: not part of this conversation.
    raise exception 'you are not part of this conversation' using errcode = '42501';
  end if;

  if v_sender_role = 'staff' and not exists (select 1 from public.projects where id = p_project_id) then
    raise exception 'project not found';
  end if;

  if p_stage_ref is not null and btrim(p_stage_ref) <> '' then
    begin
      v_stage := btrim(p_stage_ref)::public.project_stage;
    exception when invalid_text_representation then
      -- An unrecognised stage reference is dropped rather than losing the
      -- message it was attached to.
      v_stage := null;
    end;
  end if;

  insert into public.project_messages
    (project_id, sender_user_id, sender_role, body, stage_ref, is_internal)
  values
    (p_project_id, auth.uid(), v_sender_role, btrim(p_body), v_stage,
     v_sender_role = 'staff' and coalesce(p_internal, false))
  returning id into v_id;

  -- A customer message re-opens the thread's attention; a staff reply clears it
  -- (§5: the flag "stays in the inbox's attention list until answered").
  if v_sender_role = 'customer' then
    insert into public.project_chat_flags (project_id, flagged_at, note)
    values (p_project_id, now(), 'Awaiting reply')
    on conflict (project_id) do update
      set flagged_at = now(),
          -- Keep a note a PM wrote themselves; only fill in the default.
          note = coalesce(project_chat_flags.note, 'Awaiting reply');
  elsif v_sender_role = 'staff' and not coalesce(p_internal, false) then
    delete from public.project_chat_flags where project_id = p_project_id;
  end if;

  perform app.write_audit(
    case when v_sender_role = 'customer' then 'chat.customer_message'
         when coalesce(p_internal, false) then 'chat.internal_note'
         else 'chat.staff_message' end,
    'project_messages', v_id::text, p_project_id, null, null,
    jsonb_build_object('internal', coalesce(p_internal, false),
                       'stage', v_stage,
                       'length', length(btrim(p_body))));

  return v_id;
end;
$$;

revoke execute on function public.post_project_message(uuid, text, boolean, text) from public, anon;
grant execute on function public.post_project_message(uuid, text, boolean, text) to authenticated;

-- System lines: stage advances, PM handovers, appointment confirmations (§3).
-- Neutral, never notified, never internal, no human sender. Staff-only to call
-- because the app raises them as a side effect of staff actions.
create or replace function public.post_system_message(
  p_project_id uuid,
  p_body       text,
  /** Skip if this exact line is already in the thread. */
  p_dedupe     boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'only staff actions raise system messages' using errcode = '42501';
  end if;
  if p_body is null or length(btrim(p_body)) = 0 then
    return null;
  end if;

  -- Moving a project back and forth to correct a mistake must not litter the
  -- customer's thread with the same line twice.
  if coalesce(p_dedupe, true) and exists (
    select 1 from public.project_messages
    where project_id = p_project_id and sender_role = 'system' and body = btrim(p_body)
  ) then
    return null;
  end if;

  insert into public.project_messages (project_id, sender_role, body)
  values (p_project_id, 'system', btrim(p_body))
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.post_system_message(uuid, text, boolean) from public, anon;
grant execute on function public.post_system_message(uuid, text, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Editing — five minutes, staff, own message, marked (§3)
-- -----------------------------------------------------------------------------

create or replace function public.edit_project_message(p_id uuid, p_body text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_msg public.project_messages%rowtype;
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'only staff may edit a message' using errcode = '42501';
  end if;
  select * into v_msg from public.project_messages where id = p_id;
  if not found then return false; end if;
  if v_msg.sender_user_id is distinct from auth.uid() then
    raise exception 'you can only edit your own message' using errcode = '42501';
  end if;
  if v_msg.sender_role <> 'staff' then
    raise exception 'only a staff message can be edited' using errcode = '42501';
  end if;
  if v_msg.created_at < now() - interval '5 minutes' then
    raise exception 'a message can only be edited within five minutes of sending';
  end if;
  if p_body is null or length(btrim(p_body)) = 0 or length(p_body) > 8000 then
    raise exception 'a message cannot be empty';
  end if;

  update public.project_messages
  set body = btrim(p_body), edited_at = now()
  where id = p_id;

  perform app.write_audit('chat.message_edited', 'project_messages', p_id::text,
    v_msg.project_id, null, null, jsonb_build_object('internal', v_msg.is_internal));
  return true;
end;
$$;

revoke execute on function public.edit_project_message(uuid, text) from public, anon;
grant execute on function public.edit_project_message(uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 5. Read receipts
-- -----------------------------------------------------------------------------
-- Each party marks the OTHER party's messages read. A customer opening their
-- thread stamps the staff messages; a PM opening the panel stamps the customer's.
-- Internal notes are never part of this — they have no second party.

create or replace function public.mark_thread_read(p_project_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := app.current_user_role();
  v_marked integer;
begin
  if v_role in ('admin', 'ops') then
    update public.project_messages
    set read_at = now()
    where project_id = p_project_id and sender_role = 'customer' and read_at is null;
  elsif v_role = 'customer' and app.is_project_customer(p_project_id) then
    update public.project_messages
    set read_at = now()
    where project_id = p_project_id and sender_role = 'staff'
      and not is_internal and read_at is null;
  else
    raise exception 'you are not part of this conversation' using errcode = '42501';
  end if;
  get diagnostics v_marked = row_count;
  return v_marked;
end;
$$;

revoke execute on function public.mark_thread_read(uuid) from public, anon;
grant execute on function public.mark_thread_read(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 6. Attachments
-- -----------------------------------------------------------------------------
-- Stores the bytes, files the document against the project, and links it to the
-- message — in one transaction, so an attachment cannot exist without its
-- document row or vice versa.
--
-- The customer_visible flag follows the message: an attachment on an internal
-- note must not appear in the customer's documents list. That is the same
-- mistake §6 is about, one layer down, and it is easy to miss.

create or replace function public.record_chat_attachment(
  p_message_id uuid,
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
  v_msg public.project_messages%rowtype;
  v_role text := app.current_user_role();
  v_name text;
  v_path text;
  v_bucket text;
  v_object_id uuid;
  v_document_id uuid;
begin
  select * into v_msg from public.project_messages where id = p_message_id;
  if not found then
    raise exception 'message not found';
  end if;

  -- Only the sender may attach to their own message, and only immediately —
  -- this is the composer finishing its upload, not a way to alter history.
  if v_msg.sender_user_id is distinct from auth.uid() then
    raise exception 'you can only attach to your own message' using errcode = '42501';
  end if;
  if v_msg.created_at < now() - interval '15 minutes' then
    raise exception 'attachments must accompany the message';
  end if;
  if v_role not in ('admin', 'ops')
     and not (v_role = 'customer' and app.is_project_customer(v_msg.project_id)) then
    raise exception 'you are not part of this conversation' using errcode = '42501';
  end if;

  -- §3: images and PDFs, default cap 10 MB.
  if p_mime not in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
                    'application/pdf') then
    raise exception 'only photos and PDFs can be attached';
  end if;
  if p_data is null or octet_length(p_data) = 0 or octet_length(p_data) > 10485760 then
    raise exception 'attachments must be between 1 byte and 10 MB';
  end if;

  v_name := coalesce(nullif(regexp_replace(coalesce(p_filename, ''), '[^\w.\-]+', '_', 'g'), ''), 'file');
  v_name := right(v_name, 100);
  v_bucket := case when p_mime = 'application/pdf' then 'project-deliverables' else 'project-photos' end;
  v_path := v_msg.project_id || '/chat/' || p_message_id || '/'
            || floor(extract(epoch from clock_timestamp()) * 1000)::bigint || '-' || v_name;

  insert into storage.objects (bucket_id, name, owner)
  values (v_bucket, v_path, auth.uid())
  returning id into v_object_id;

  insert into storage.object_data (object_id, data) values (v_object_id, p_data);

  insert into public.documents
    (project_id, bucket, object_path, kind, category, title, mime_type, size_bytes,
     customer_visible, uploaded_by)
  values
    (v_msg.project_id, v_bucket, v_path,
     (case when p_mime = 'application/pdf' then 'pdf' else 'photo' end)::public.document_kind,
     -- §3: "filed to the project's documents with the source marked as chat".
     'chat',
     p_filename, p_mime, octet_length(p_data),
     not v_msg.is_internal,
     auth.uid())
  returning id into v_document_id;

  insert into public.message_attachments (message_id, document_id)
  values (p_message_id, v_document_id);

  perform app.write_audit('chat.attachment_added', 'documents', v_document_id::text,
    v_msg.project_id, null, null,
    jsonb_build_object('internal', v_msg.is_internal, 'bytes', octet_length(p_data)));

  return v_document_id;
end;
$$;

revoke execute on function public.record_chat_attachment(uuid, text, text, bytea) from public, anon;
grant execute on function public.record_chat_attachment(uuid, text, text, bytea) to authenticated;

-- -----------------------------------------------------------------------------
-- 7. The unread badges and the global inbox
-- -----------------------------------------------------------------------------
-- §1: "A PM should never have to open a project to discover a customer wrote
-- three days ago." Both of these are aggregates over the thread, so they belong
-- in SQL rather than in a loop over projects in the application.

create or replace view public.project_chat_summary
with (security_invoker = true)
as
select
  p.id as project_id,
  count(m.id) filter (where m.sender_role = 'customer' and m.read_at is null) as unread,
  count(m.id) filter (where not m.is_internal) as messages,
  max(m.created_at) filter (where not m.is_internal) as last_message_at,
  max(m.created_at) filter (where m.sender_role = 'customer') as last_customer_at,
  max(m.created_at) filter (where m.sender_role = 'staff' and not m.is_internal) as last_staff_at,
  (f.project_id is not null) as flagged,
  f.note as flag_note
from public.projects p
left join public.project_messages m on m.project_id = p.id
left join public.project_chat_flags f on f.project_id = p.id
-- Staff only: 'unread' here means "unread by us", which is precisely the read
-- receipt §3 says the customer must not be shown.
where (select app.current_user_role()) in ('admin', 'ops')
group by p.id, f.project_id, f.note;

grant select on public.project_chat_summary to authenticated;

-- -----------------------------------------------------------------------------
-- 7b. Who is talking — resolved for the customer too
-- -----------------------------------------------------------------------------
-- public.profiles is self-or-staff by policy, so a homeowner joining it gets
-- nothing: their thread would show every reply as coming from nobody. §2 is
-- explicit that this is not acceptable — the PM is "named and pictured at the
-- top of the thread so the customer knows who they are talking to", and any
-- staff member who posts appears "with their own name … the customer should
-- always know who actually wrote".
--
-- So the names come through a definer function, narrowly: only the display names
-- of staff who have actually posted a customer-visible message on this one
-- project, and only to that project's customer or to staff. No email, no phone,
-- no other project's people.
--
-- (This is the same trap that made 'call my project manager' return nothing in
-- the mobile module until public.project_contact() was added. Worth naming twice.)

create or replace function public.chat_participants(p_project_id uuid)
returns table (user_id uuid, display_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if app.current_user_role() not in ('admin', 'ops')
     and not app.is_project_customer(p_project_id) then
    raise exception 'not your conversation' using errcode = '42501';
  end if;

  return query
    select distinct pr.id, coalesce(pr.full_name, pr.email)
    from public.project_messages m
    join public.profiles pr on pr.id = m.sender_user_id
    where m.project_id = p_project_id
      and m.sender_role = 'staff'
      and not m.is_internal;
end;
$$;

revoke execute on function public.chat_participants(uuid) from public, anon;
grant execute on function public.chat_participants(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 8. Canned replies (§5) — "what makes chat survivable at forty projects"
-- -----------------------------------------------------------------------------

create table if not exists public.canned_replies (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  body       text not null,
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.canned_replies enable row level security;
grant select, insert, update, delete on public.canned_replies to authenticated;

drop policy if exists canned_replies_select on public.canned_replies;
create policy canned_replies_select on public.canned_replies
  for select to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops'));

drop policy if exists canned_replies_write on public.canned_replies;
create policy canned_replies_write on public.canned_replies
  for all to authenticated
  using ((select app.is_admin())) with check ((select app.is_admin()));

drop trigger if exists set_updated_at on public.canned_replies;
create trigger set_updated_at before update on public.canned_replies
  for each row execute function app.tg_set_updated_at();

-- The three the spec names, so the library is useful on day one rather than
-- being an empty admin screen nobody fills in.
insert into public.canned_replies (title, body, sort_order)
select * from (values
  ('Permit timelines',
   E'Your permit application is with the city now. Most permits in your area come back within two to four weeks, and there is unfortunately no way to speed that up from our side.\n\nAs soon as it is approved I will let you know here, and we will book your installation date straight away.',
   10),
  ('What happens on install day',
   E'Here is what to expect on installation day:\n\n• Our crew arrives in the morning and will be with you most of the day.\n• We need clear access to your roof and to your electrical panel, so please move any vehicles off the driveway.\n• Your power will be off for a short period while we connect the system.\n• You do not need to be home the whole time, but someone should be there at the start and the end.\n\nAnything you are unsure about, just ask here.',
   20),
  ('How to read your monitoring app',
   E'Now that your system is on, you can see what it is producing:\n\n• Download the monitoring app for your inverter and sign in with the details we sent you.\n• The main figure is today''s production in kWh.\n• Production drops on cloudy days and in winter — that is normal, not a fault.\n\nIf a panel or the whole system shows nothing for a full sunny day, tell us here and we will look into it.',
   30)
) as seed(title, body, sort_order)
where not exists (select 1 from public.canned_replies);

-- -----------------------------------------------------------------------------
-- 9. Settings
-- -----------------------------------------------------------------------------

alter table public.app_settings
  /**
   * §4's aside: the biggest risk with in-product chat is that it feels like
   * instant messaging while the PM treats it like email. This line sits at the
   * top of the customer's thread, and it is a setting because it is a promise
   * the business makes and will want to change.
   */
  add column if not exists chat_reply_promise text
    default 'We usually reply within one business day.',
  /** Quiet hours are local to the company; the customer's own zone is unknown. */
  add column if not exists company_timezone text default 'America/Chicago',
  /** §4: unanswered customer messages summarised twice a day by default. */
  add column if not exists chat_digest_hours text default '9,15';

-- §4: "An immediate email per message is optional per PM — some want it, most
-- want the digest."
alter table public.profiles
  add column if not exists chat_email_each_message boolean not null default false;

-- A sixth notification category, so a customer can turn chat pushes off in the
-- app's notification settings like any other kind. The check constraint is
-- rebuilt rather than added to, because a constraint cannot be extended in place.
alter table public.notification_preferences
  drop constraint if exists notification_preferences_category_check;
alter table public.notification_preferences
  add constraint notification_preferences_category_check
  check (category in ('stage_advanced', 'appointment', 'action_needed', 'on_hold',
                      'power_on', 'chat_message'));

-- Customers may silence chat email without losing the thread (the existing
-- email_opt_out already covers all portal email, so nothing new is needed here
-- — noted so the next reader does not add a second, conflicting flag).

-- -----------------------------------------------------------------------------
-- 10. Notifications that must wait for the morning (§4 quiet hours)
-- -----------------------------------------------------------------------------
-- No customer push between 9pm and 8am local; queued to the morning. Queued
-- rather than dropped, because a message sent at 10pm is exactly the one a
-- customer wants to see at 8am — and dropped notifications are how people learn
-- not to trust the app.
--
-- Flushed by the same authenticated cron endpoint that sends appointment
-- reminders, so this needs no new scheduler.

create table if not exists public.chat_notification_queue (
  id         bigint generated always as identity primary key,
  message_id uuid not null references public.project_messages (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  send_after timestamptz not null,
  sent_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists chat_notification_queue_due_idx
  on public.chat_notification_queue (send_after)
  where sent_at is null;

alter table public.chat_notification_queue enable row level security;
grant select on public.chat_notification_queue to authenticated;

-- Staff-visible only, and written exclusively by the definer functions below:
-- a customer must not be able to read or forge their own notification schedule.
drop policy if exists chat_notification_queue_select on public.chat_notification_queue;
create policy chat_notification_queue_select on public.chat_notification_queue
  for select to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops'));

/**
 * Is it currently quiet hours at the company's local time? 21:00–07:59.
 * Returns the moment a notification may be sent, or null for "send now".
 */
create or replace function public.chat_quiet_until()
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_local timestamp;
  v_hour integer;
begin
  select coalesce(nullif(btrim(company_timezone), ''), 'America/Chicago')
    into v_tz from public.app_settings where id;
  v_tz := coalesce(v_tz, 'America/Chicago');

  begin
    v_local := now() at time zone v_tz;
  exception when others then
    -- An invalid timezone name must not stop a notification going out.
    return null;
  end;

  v_hour := extract(hour from v_local);
  if v_hour >= 21 then
    -- Tonight: hold until 8am tomorrow, local.
    return ((date_trunc('day', v_local) + interval '1 day' + interval '8 hours')
            at time zone v_tz);
  elsif v_hour < 8 then
    return ((date_trunc('day', v_local) + interval '8 hours') at time zone v_tz);
  end if;
  return null;
end;
$$;

grant execute on function public.chat_quiet_until() to authenticated;

/** Queue a customer notification for after quiet hours. Staff-only. */
create or replace function public.queue_chat_notification(
  p_message_id uuid,
  p_send_after timestamptz
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_id bigint;
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'only staff queue notifications' using errcode = '42501';
  end if;
  select project_id into v_project from public.project_messages where id = p_message_id;
  if v_project is null then return null; end if;
  insert into public.chat_notification_queue (message_id, project_id, send_after)
  values (p_message_id, v_project, p_send_after)
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.queue_chat_notification(uuid, timestamptz) from public, anon;
grant execute on function public.queue_chat_notification(uuid, timestamptz) to authenticated;

/** Claim the due queue entries, so two overlapping cron runs cannot double-send. */
create or replace function public.claim_due_chat_notifications(p_limit integer default 100)
returns table (q_id bigint, q_message uuid, q_project uuid, q_body text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if app.current_user_role() not in ('admin', 'ops') then
    raise exception 'only staff flush the queue' using errcode = '42501';
  end if;

  return query
    with due as (
      select q.id
      from public.chat_notification_queue q
      where q.sent_at is null and q.send_after <= now()
      order by q.send_after
      limit greatest(1, least(coalesce(p_limit, 100), 500))
      for update skip locked
    )
    update public.chat_notification_queue q
    set sent_at = now()
    from due, public.project_messages m
    where q.id = due.id and m.id = q.message_id
    returning q.id, q.message_id, q.project_id, m.body;
end;
$$;

revoke execute on function public.claim_due_chat_notifications(integer) from public, anon;
grant execute on function public.claim_due_chat_notifications(integer) to authenticated;

-- -----------------------------------------------------------------------------
-- 11. Response time (§5) — informs staffing, does not rank people
-- -----------------------------------------------------------------------------
-- First response to each customer message that had one: the gap between the
-- customer's message and the next staff reply on that project. Exposed as a
-- view so the dashboard can average it per PM without the application walking
-- the thread.

create or replace view public.chat_response_times
with (security_invoker = true)
as
select
  m.project_id,
  p.assigned_pm,
  m.id as message_id,
  m.created_at as asked_at,
  reply.created_at as replied_at,
  extract(epoch from (reply.created_at - m.created_at)) / 3600.0 as hours_to_reply
from public.project_messages m
join public.projects p on p.id = m.project_id
left join lateral (
  select r.created_at
  from public.project_messages r
  where r.project_id = m.project_id
    and r.sender_role = 'staff'
    and not r.is_internal
    and r.created_at > m.created_at
  order by r.created_at
  limit 1
) reply on true
where m.sender_role = 'customer'
  and (select app.current_user_role()) in ('admin', 'ops');

grant select on public.chat_response_times to authenticated;

-- -----------------------------------------------------------------------------
-- 12. Audit
-- -----------------------------------------------------------------------------
-- Sends, edits and attachment uploads are audited inside the functions above
-- (write_audit carries the actor from the JWT, so it cannot be spoofed). The
-- flag table gets the generic row auditor; the message table deliberately does
-- not, because every write already logs a purposeful action and a second row
-- per message would double the audit volume for no new information.

drop trigger if exists audit_row on public.project_chat_flags;
create trigger audit_row after insert or update or delete on public.project_chat_flags
  for each row execute function app.tg_audit_row();



-- >>> 20260803003000_sign_in.sql

-- =============================================================================
-- 003000 — Sign-in & role entry
-- =============================================================================
-- Implements the Sign-in Screens specification. Most of that document is about
-- pixels; this file is the part that cannot live in a page.
--
-- §5: "one login endpoint, one validation path, one rate limiter and one
-- role-routing function — three separate implementations is how you end up with
-- a security fix applied to two of them." The three pages therefore call one
-- database function, auth.sign_in(), which is the only place credentials are
-- checked from now on.
--
-- What is new here beyond a wrapper:
--
--  1. Rate limiting per account AND per IP (§5). The auth engine already locked
--     an account after ten failures; that alone does nothing about one host
--     spraying one password across a thousand addresses, which is what
--     credential stuffing actually looks like. The IP counter is the half that
--     was missing.
--
--  2. A progressive delay before the lockout. Ten free guesses then a wall is
--     worse for both sides than a delay that grows: an attacker's throughput
--     collapses after three attempts, while a person who mistyped their own
--     password twice notices nothing at all.
--
--  3. An outcome code rather than an empty result. The old function returned no
--     rows for "no such user", "wrong password", "locked" and "deleted profile"
--     alike, so the route could not tell a rate-limited caller they were rate
--     limited. The pages still show one generic message for wrong credentials —
--     never revealing whether an address exists, and never which role it
--     belongs to — but "too many attempts, try again in 12 minutes" is a
--     different fact and the person typing needs it.
--
-- The counters are keyed by email address, not by user id, so an unknown
-- address is throttled exactly like a known one. Counting only real accounts
-- would turn the rate limiter itself into the account oracle the login page is
-- careful not to be.

-- -----------------------------------------------------------------------------
-- 1. The counters
-- -----------------------------------------------------------------------------

create table if not exists auth.login_throttle (
  /** 'email' — one address being guessed at. 'ip' — one host guessing. */
  scope            text not null check (scope in ('email', 'ip')),
  key              text not null,
  failures         integer not null default 0,
  first_failure_at timestamptz not null default now(),
  last_failure_at  timestamptz not null default now(),
  locked_until     timestamptz,
  primary key (scope, key)
);

-- Housekeeping: rows are worthless once their window has passed, and this table
-- would otherwise grow one row per address anybody ever mistyped.
create index if not exists login_throttle_last_failure_idx
  on auth.login_throttle (last_failure_at);

-- Nothing outside the definer functions below touches this table. It is in the
-- auth schema, which the application role has no blanket grant on, but say it
-- explicitly: a table that records "this address is being guessed at" is not one
-- to leave readable.
revoke all on auth.login_throttle from public;

-- -----------------------------------------------------------------------------
-- 2. The policy, in one place
-- -----------------------------------------------------------------------------
-- Named constants as a function rather than magic numbers spread through the
-- logic, so the shape of the policy can be read in one screen:
--
--   * failures inside a 15-minute window count together; a quiet 15 minutes
--     forgets everything, so a person who gets it right tomorrow starts clean;
--   * from the third failure a delay applies, doubling to a cap of 8 seconds;
--   * ten failures on one address, or forty from one host, close the door for
--     15 minutes.
--
-- Forty rather than ten for the IP: a family, an office or a mobile carrier's
-- NAT shares one address, and locking a whole office out because one person
-- forgot their password is a self-inflicted outage.

create or replace function auth.throttle_window() returns interval
  language sql immutable as $$ select interval '15 minutes' $$;

create or replace function auth.throttle_lockout() returns interval
  language sql immutable as $$ select interval '15 minutes' $$;

create or replace function auth.throttle_limit(p_scope text) returns integer
  language sql immutable as $$ select case when p_scope = 'ip' then 40 else 10 end $$;

/** The pause to apply before answering a failed attempt, in milliseconds. */
create or replace function auth.throttle_delay_ms(p_failures integer)
returns integer
language sql
immutable
as $$
  select case
    when coalesce(p_failures, 0) < 3 then 0
    else least(8000, (250 * power(2, p_failures - 2))::integer)
  end
$$;

-- -----------------------------------------------------------------------------
-- 3. Recording a failure and asking whether the door is shut
-- -----------------------------------------------------------------------------

/**
 * Note one failed attempt against one counter and return the state it leaves.
 *
 * The upsert resets the count when the previous failure is older than the
 * window: a sliding window without a background job to expire rows.
 */
create or replace function auth.throttle_fail(p_scope text, p_key text)
returns table (f_failures integer, f_locked_until timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_key is null or btrim(p_key) = '' then
    return query select 0, null::timestamptz;
    return;
  end if;

  insert into auth.login_throttle as t (scope, key, failures)
  values (p_scope, lower(btrim(p_key)), 1)
  on conflict (scope, key) do update
  set failures = case
        when t.last_failure_at < now() - auth.throttle_window() then 1
        else t.failures + 1
      end,
      first_failure_at = case
        when t.last_failure_at < now() - auth.throttle_window() then now()
        else t.first_failure_at
      end,
      last_failure_at = now(),
      locked_until = case
        when (case
                when t.last_failure_at < now() - auth.throttle_window() then 1
                else t.failures + 1
              end) >= auth.throttle_limit(p_scope)
        then now() + auth.throttle_lockout()
      end
  -- The OUT parameters are named f_* because a RETURNING clause resolves
  -- unqualified names to the table's columns first: OUT parameters called
  -- `failures` and `locked_until` would be ambiguous with the very columns being
  -- returned, and the function would not compile.
  returning t.failures, t.locked_until
  into f_failures, f_locked_until;

  return query select f_failures, f_locked_until;
end;
$$;

/** Seconds until this counter reopens, or 0 when it is not locked. */
create or replace function auth.throttle_retry_after(p_scope text, p_key text)
returns integer
language sql
security definer
set search_path = ''
as $$
  select coalesce(
    (select greatest(0, ceil(extract(epoch from (t.locked_until - now())))::integer)
     from auth.login_throttle t
     where t.scope = p_scope and t.key = lower(btrim(coalesce(p_key, '')))
       and t.locked_until is not null and t.locked_until > now()),
    0)
$$;

/**
 * Forget the counters for an address (and optionally the host that got it
 * right). Called on a successful sign-in, and after a password reset — a person
 * who has just proved control of their inbox should not then be told to wait
 * out a lockout they no longer deserve.
 */
create or replace function auth.throttle_clear(p_email text, p_ip text default null)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from auth.login_throttle
  where (scope = 'email' and key = lower(btrim(coalesce(p_email, ''))))
     or (scope = 'ip' and p_ip is not null and key = lower(btrim(p_ip)));
$$;

-- Note what is deliberately NOT here: a "clear the lock for this user id"
-- function the application could call. It looks harmless — it holds no secret
-- and returns nothing — but any caller who could reach it could guess nine
-- times, clear the counter, and guess nine more, for ever. The lockout would
-- become decoration. The only thing that clears a counter is proving you are the
-- account holder, which is what the two paths below do.

-- Old rows serve no purpose once their window has passed. Called from sign_in on
-- a small sample of attempts, so the table stays flat with no scheduler — there
-- is no cron in this deployment and adding one for housekeeping would be a
-- moving part to maintain for the rest of the product's life.
create or replace function auth.throttle_sweep()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from auth.login_throttle
  where last_failure_at < now() - interval '1 day'
    and (locked_until is null or locked_until < now())
$$;

-- -----------------------------------------------------------------------------
-- 4. The one authentication path
-- -----------------------------------------------------------------------------

/**
 * Check credentials once, for all three sign-in pages.
 *
 * Outcomes:
 *   'locked'   — rate limited. retry_after says for how long.
 *   'invalid'  — no such address, or the wrong password. Identical either way;
 *                delay_ms is how long the caller should wait before answering.
 *   'disabled' — the password was right and the account is deactivated. §5 wants
 *                this said plainly: "the user needs to know it is not their
 *                typing". It reveals nothing to a guesser, because reaching it
 *                requires the correct password.
 *   'ok'       — signed in. session_token is set; the caller decides where the
 *                role lands, which is the one thing this function deliberately
 *                does not know.
 *
 * The role is returned but never checked against the page that was used. A
 * homeowner who types their details into the staff form has proved who they are;
 * §5's answer is to take them to their own surface, not to refuse them.
 */
create or replace function auth.sign_in(p_email text, p_password text, p_ip text default null)
returns table (
  outcome               text,
  user_id               uuid,
  session_token         text,
  user_role             public.user_role,
  full_name             text,
  force_password_change boolean,
  delay_ms              integer,
  retry_after           integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email   text := lower(btrim(coalesce(p_email, '')));
  v_ip      text := nullif(btrim(coalesce(p_ip, '')), '');
  v_wait    integer;
  v_login   record;
  v_fail    record;
begin
  -- One attempt in fifty pays for the housekeeping.
  if random() < 0.02 then
    perform auth.throttle_sweep();
  end if;

  v_wait := greatest(
    auth.throttle_retry_after('email', v_email),
    case when v_ip is null then 0 else auth.throttle_retry_after('ip', v_ip) end
  );
  if v_wait > 0 then
    return query select 'locked'::text, null::uuid, null::text, null::public.user_role,
                        null::text, false, 0, v_wait;
    return;
  end if;

  select * into v_login from auth.login_with_password(v_email, p_password);

  -- No row means unknown address, wrong password, or an account the engine has
  -- locked. All three answer identically; only the delay differs, and it grows
  -- with the number of failures rather than with anything about the account.
  if not found then
    select * into v_fail from auth.throttle_fail('email', v_email);
    if v_ip is not null then
      perform auth.throttle_fail('ip', v_ip);
    end if;
    return query select 'invalid'::text, null::uuid, null::text, null::public.user_role,
                        null::text, false,
                        auth.throttle_delay_ms(v_fail.f_failures),
                        greatest(0, coalesce(
                          ceil(extract(epoch from (v_fail.f_locked_until - now())))::integer, 0));
    return;
  end if;

  -- Right password: the counters have done their job either way.
  perform auth.throttle_clear(v_email, v_ip);

  if not v_login.is_active or v_login.session_token is null then
    return query select 'disabled'::text, v_login.user_id, null::text, v_login.user_role,
                        v_login.full_name, false, 0, 0;
    return;
  end if;

  return query select 'ok'::text, v_login.user_id, v_login.session_token, v_login.user_role,
                      v_login.full_name, v_login.force_password_change, 0, 0;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Setting a password releases the lock
-- -----------------------------------------------------------------------------
-- §7: an expired link "offers to send a new one rather than dead-ending". The
-- same principle applies one step further along: somebody who has just proved
-- control of their inbox and chosen a new password must not then be told to wait
-- out a fifteen-minute lockout earned by forgetting the old one. That is the
-- dead end the whole reset flow exists to avoid.
--
-- The function is restated in full rather than patched from the application,
-- because the alternative — a clear-the-lock call the app makes after a reset —
-- is the escalation ruled out above. Here the release is welded to the one act
-- that proves identity, and cannot be invoked on its own.
--
-- Restated from the 001300 version, NOT the original in 001000: 001300 lowered
-- the minimum length and added the force_password_change clear, and copying the
-- older body would have silently undone both. When replacing a function an
-- earlier migration has already replaced, the last definition is the one to
-- start from.

create or replace function auth.set_password_with_token(p_token text, p_password text)
returns table (
  user_id       uuid,
  session_token text,
  user_role     public.user_role,
  full_name     text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token auth.one_time_tokens%rowtype;
  v_email text;
begin
  if length(coalesce(p_password, '')) < 8 then
    raise exception 'password must be at least 8 characters';
  end if;

  select t.* into v_token
  from auth.one_time_tokens t
  where t.token_hash = auth.hash_token(p_token)
    and t.purpose in ('invite', 'recovery')
    and t.consumed_at is null
    and t.expires_at > now();
  if not found then
    return;
  end if;

  update auth.one_time_tokens t set consumed_at = now() where t.id = v_token.id;

  update auth.users u
  set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 12)),
      email_confirmed_at = coalesce(u.email_confirmed_at, now()),
      force_password_change = false,
      failed_attempts = 0, locked_until = null, updated_at = now()
  where u.id = v_token.user_id
  returning u.email into v_email;

  perform auth.revoke_all_sessions(v_token.user_id);

  -- The one new line: forget the rate-limit counters for this address too, so
  -- the new password works immediately rather than in a quarter of an hour.
  perform auth.throttle_clear(v_email, null);

  return query
    select v_token.user_id, auth.new_session(v_token.user_id), p.role, p.full_name
    from public.profiles p
    where p.id = v_token.user_id and p.is_active;
end;
$$;

revoke execute on function auth.set_password_with_token(text, text) from public, anon;
grant execute on function auth.set_password_with_token(text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 6. Grants
-- -----------------------------------------------------------------------------
-- The application signs in as `authenticated` with no claims (withAnon), so
-- that is the role that needs execute. Everything else stays shut: the throttle
-- primitives are internal, and letting a caller reach throttle_fail directly
-- would hand them a way to lock any address out of the product.

revoke execute on function
  auth.throttle_window(),
  auth.throttle_lockout(),
  auth.throttle_limit(text),
  auth.throttle_delay_ms(integer),
  auth.throttle_fail(text, text),
  auth.throttle_retry_after(text, text),
  auth.throttle_clear(text, text),
  auth.throttle_sweep(),
  auth.sign_in(text, text, text)
from public, anon;

grant execute on function auth.sign_in(text, text, text) to authenticated;



-- >>> 20260803003100_typical_durations.sql

-- =============================================================================
-- 003100 — Typical stage durations (customer portal redesign §5, §7)
-- =============================================================================
-- The redesigned home screen tells a homeowner how long the stage they are in
-- usually takes: 'Typical 15–30 days' on the permit card, 'Up next: Design ·
-- 7–10 days' on the row below it. That single sentence answers the question
-- behind most status phone calls — "is this taking too long?" — before anybody
-- picks up a phone.
--
-- It has to be configuration, not a constant in the code. Permit times are a
-- fact about a jurisdiction, not about this product: a company working in one
-- county wants numbers that match that county, and §7 asks for these to be
-- seeded from the business's own historical averages once the dashboard has
-- enough completed projects to compute them.
--
-- They live on stage_thresholds, next to the attention threshold that the
-- dashboard already uses, because both answer the same question at different
-- volumes: what is normal for this stage, and when has this project stopped
-- being normal. One table, one admin panel, one number to keep in step.
--
-- The range is deliberately a range. A single '10 days' would be read as a
-- promise, and a permit office that takes three weeks would make the product a
-- liar. §7: "Label them as typical, never as a promise."

-- Everything below is wrapped in one guard, because a plain `alter table` on a
-- table that is not there yet is a hard error rather than a skip. That case is
-- real: the deployment applies these files in name order, and an operator who
-- ran the dashboard module's SQL late — or skipped it — would otherwise hit an
-- error on this file and reasonably conclude the whole catch-up had failed. It
-- says what to run instead and changes nothing.
do $$
begin
  if to_regclass('public.stage_thresholds') is null then
    raise notice '003100 skipped: public.stage_thresholds does not exist yet. Run the dashboard migration (002800) first — or db/dist/catch-up-1.sql then catch-up-2.sql, which include both.';
    return;
  end if;

  execute 'alter table public.stage_thresholds
             add column if not exists typical_min_days integer,
             add column if not exists typical_max_days integer';

  -- Added separately from the columns so a re-run over a table that already has
  -- the constraint does not fail: there is no `add constraint if not exists`.
  if not exists (
    select 1 from pg_constraint where conname = 'stage_thresholds_typical_range'
  ) then
    execute $c$
      alter table public.stage_thresholds
        add constraint stage_thresholds_typical_range
        check (
          (typical_min_days is null and typical_max_days is null)
          or (typical_min_days between 1 and 3650
              and typical_max_days between 1 and 3650
              and typical_min_days <= typical_max_days)
        )
    $c$;
  end if;

  -- Seeded from the specification's own figures (§5), which are ordinary
  -- residential-solar durations. An update rather than an insert: the rows
  -- already exist from 002800, and their attention thresholds must not be
  -- touched. Only rows nobody has set a range on are filled, so a company that
  -- has tuned these keeps its own numbers when this file is run again.
  execute $u$
    update public.stage_thresholds set typical_min_days = v.min_days,
                                       typical_max_days = v.max_days
    from (values
      ('survey',          7, 14),
      ('design',          7, 10),
      ('permits',        15, 30),
      ('procurement',     7, 14),
      ('install',         1,  3),
      ('inspection_pto', 10, 21)
    ) as v (stage, min_days, max_days)
    where stage_thresholds.stage = v.stage::public.project_stage
      and stage_thresholds.typical_min_days is null
  $u$;
end
$$;

-- Complete is deliberately left null. There is no 'typical' length for being
-- finished, and a range on that card would be nonsense — the card is replaced by
-- a completion state at that point anyway.

-- Grants are inherited from 002800: every signed-in role may read this table,
-- which now includes the customer reading their own stage's typical range. The
-- numbers reveal nothing about anybody's project.



-- >>> 20260803003200_stage_feedback.sql

-- =============================================================================
-- 003200 — Stage feedback (customer sentiment)
-- =============================================================================
-- Implements the Stage Feedback specification: a one-tap rating asked the moment
-- a stage completes, six or seven times across a project instead of one survey
-- at the end.
--
-- The premise the whole design rests on (§1): asking at the moment tells you
-- *which stage* lost the customer, while you can still do something about it. An
-- end-of-job survey tells you that somebody is unhappy after the last chance to
-- fix it has gone.
--
-- Three things in this file are load-bearing, and each one is here rather than
-- in the application because the application is not the only thing that will
-- ever write to this table:
--
--  1. One row per (project, stage), for ever. §4's first hard limit — "a project
--     can never be asked twice about the same stage" — is a unique constraint,
--     not a check in a route. The row is created when the request is made and
--     updated when it is answered, so an unanswered request is still a
--     measurable thing (§8) rather than an absence.
--
--  2. The score is written on tap (§9). The functions are split accordingly:
--     one records a score alone, a second attaches the reasons and the comment
--     if the customer keeps going. Abandonment after tapping a face is common,
--     and that tap is the number worth having.
--
--  3. Attribution is a snapshot (§6). Who the PM, dealer and rep were at the
--     time is copied onto the row when the request is created. Reassigning a
--     project next month must not rewrite last month's scores.
--
-- What §6 asks for and this file cannot yet do: the stage-specific party is
-- recorded generically (kind + id + a name snapshot), and today only Stage 2's
-- designer is actually available — the live stage tables carry designer_id but
-- no surveyor or crew column. Those two attach the day those fields exist,
-- without a schema change here.
--
-- Note also what is deliberately absent: any table a third-party survey tool
-- would own. §8: "a rating that lives in someone else's system cannot flag a
-- project card or open a task."

-- -----------------------------------------------------------------------------
-- 1. Follow-up work
-- -----------------------------------------------------------------------------
-- §9 is blunt: "Build it after the portal and the PM task list exist. The rating
-- is only half the feature; the follow-up task is the other half, and without
-- somewhere for it to land you are just collecting numbers."
--
-- There was no task list in this product, so here is the smallest one that can
-- hold the other half honestly: a task belongs to a project, carries the reason
-- it exists, and cannot be closed without saying what was done (§5). The
-- `source` column is there so the next thing that needs to raise work for a PM
-- extends this table instead of inventing a second one.

create table if not exists public.project_tasks (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id) on delete cascade,
  source         text not null default 'feedback'
                   check (source in ('feedback', 'manual')),
  title          text not null,
  /** The first move, drawn from a template — §5's 'suggested action'. */
  suggested      text,
  detail         text,
  priority       text not null default 'high' check (priority in ('high', 'normal')),
  /** A snapshot: the PM at the time the task was raised. */
  assigned_to    uuid references public.profiles (id) on delete set null,
  created_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz,
  resolved_by    uuid references public.profiles (id) on delete set null,
  /** §5: "The task must be closed with a resolution note." Enforced below. */
  resolution     text,
  constraint project_tasks_resolution_needs_note
    check (resolved_at is null or length(btrim(coalesce(resolution, ''))) > 0)
);

create index if not exists project_tasks_open_idx
  on public.project_tasks (project_id) where resolved_at is null;
create index if not exists project_tasks_assigned_idx
  on public.project_tasks (assigned_to, resolved_at);

-- -----------------------------------------------------------------------------
-- 2. The rating itself
-- -----------------------------------------------------------------------------

-- public.stage_feedback already exists — as a placeholder from the foundation
-- schema (000200), which described it as "created now, mostly unused in phase
-- one" and gave it a rating, a free-text field, a `source` and permissive
-- policies letting any project participant write one. Nothing in the
-- application ever wrote to it.
--
-- This module is that table's real implementation, so it takes it over rather
-- than standing a near-identical table beside it. Two names change to match what
-- they now mean, the new columns arrive, and the old policies — which let a
-- dealer or a designer file a rating, and allowed many rows per stage — are
-- replaced further down.

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'stage_feedback'
                    and column_name = 'score') then
    alter table public.stage_feedback rename column rating to score;
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'stage_feedback'
                    and column_name = 'comment') then
    alter table public.stage_feedback rename column feedback to comment;
  end if;
end
$$;

-- Note what is NOT here: a type change on `score`. It arrived as integer and an
-- integer holds 1 to 5 perfectly well — and once the views below exist, altering
-- the column's type fails, which would make this file safe to run once and not
-- twice. Every migration here has to survive being pasted again.
alter table public.stage_feedback
  /** §3: one extra question, at the final stage only. */
  add column if not exists nps smallint check (nps between 0 and 10),
  /** The reason chips, by key. */
  add column if not exists tags text[] not null default '{}',
  add column if not exists channel text check (channel in ('portal', 'app', 'email')),
  add column if not exists requested_at timestamptz not null default now(),
  /**
   * When the request may actually be shown or sent. Carries §1's 7pm deferral
   * for installation day and §4's 48-hour gap: the request exists immediately
   * (so the stage is never asked about twice) but stays invisible until due.
   */
  add column if not exists send_after timestamptz not null default now(),
  add column if not exists responded_at timestamptz,
  /** 'Not now' — dismissed in the sheet, still askable as a quiet card. */
  add column if not exists dismissed_at timestamptz,
  /** The one email reminder (§4: asked twice, then never). */
  add column if not exists reminded_at timestamptz,
  /** Closed unanswered: both attempts spent, no third. */
  add column if not exists closed_at timestamptz,
  /** Attribution, snapshotted at request time (§6). */
  add column if not exists attributed_pm uuid references public.profiles (id) on delete set null,
  add column if not exists attributed_dealer uuid references public.dealers (id) on delete set null,
  add column if not exists attributed_rep uuid references public.sales_reps (id) on delete set null,
  add column if not exists attributed_party_kind text
    check (attributed_party_kind in ('surveyor', 'designer', 'crew')),
  add column if not exists attributed_party_id uuid,
  /** A name copy, so a deleted reference record does not blank the history. */
  add column if not exists attributed_party_name text,
  add column if not exists task_id uuid references public.project_tasks (id) on delete set null,
  /** sha256 of the emailed one-click token. The token itself is never stored. */
  add column if not exists token_hash text,
  add column if not exists updated_at timestamptz not null default now();

-- The legacy `source` column ('customer' | 'dealer' | 'designer' | 'ai') is left
-- alone: it is not null with a default, so it does not obstruct anything, and
-- dropping a column to tidy up is how you lose data that turns out to matter.
-- `channel` above is the field this module reads.

/**
 * §4's first hard limit as a constraint rather than a hope: one row per
 * (project, stage), for ever.
 *
 * The old table allowed several — one per participant. If a database somehow
 * holds duplicates, this says so and names them instead of quietly deleting
 * somebody's data to make room for the constraint.
 */
do $$
declare v_dupes text;
begin
  if not exists (select 1 from pg_constraint where conname = 'stage_feedback_one_per_stage') then
    select string_agg(format('%s/%s', project_id, stage), ', ')
      into v_dupes
      from (select project_id, stage from public.stage_feedback
             group by project_id, stage having count(*) > 1 limit 20) d;
    if v_dupes is not null then
      raise exception 'stage_feedback has more than one row for: %. Keep one row per project and stage, then run this file again.', v_dupes;
    end if;
    alter table public.stage_feedback
      add constraint stage_feedback_one_per_stage unique (project_id, stage);
  end if;

  -- A response has a score. Anything else is a half-written row.
  if not exists (select 1 from pg_constraint
                  where conname = 'stage_feedback_answered_has_score') then
    alter table public.stage_feedback
      add constraint stage_feedback_answered_has_score
      check (responded_at is null or score is not null);
  end if;
end
$$;

create index if not exists stage_feedback_due_idx
  on public.stage_feedback (send_after)
  where responded_at is null and closed_at is null;
create index if not exists stage_feedback_stage_idx
  on public.stage_feedback (stage, responded_at);
create index if not exists stage_feedback_low_idx
  on public.stage_feedback (project_id) where score <= 2;

drop trigger if exists set_updated_at on public.stage_feedback;
create trigger set_updated_at before update on public.stage_feedback
  for each row execute function app.tg_set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. Configuration: the chips, and which stages ask at all
-- -----------------------------------------------------------------------------
-- §3: "Editable in admin, and the chip list can vary per stage (a survey has no
-- pricing chip; an install has no permit chip)." An empty `stages` array means
-- the chip applies everywhere, which is the common case and saves listing all
-- seven on most rows.

create table if not exists public.feedback_reasons (
  key        text primary key,
  label      text not null,
  stages     public.project_stage[] not null default '{}',
  sort_order integer not null default 100,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.feedback_reasons (key, label, stages, sort_order) values
  ('slow_updates',  'Slow updates',       '{}', 10),
  ('scheduling',    'Scheduling',         '{}', 20),
  ('communication', 'Communication',      '{}', 30),
  ('technician',    'Technician or crew',
     '{survey,install,inspection_pto}', 40),
  ('pricing',       'Unclear pricing',    '{survey,design,complete}', 50),
  ('quality',       'Quality concern',    '{install,inspection_pto,complete}', 60),
  ('other',         'Something else',     '{}', 100)
on conflict (key) do nothing;

drop trigger if exists set_updated_at on public.feedback_reasons;
create trigger set_updated_at before update on public.feedback_reasons
  for each row execute function app.tg_set_updated_at();

-- Which stages ask, on the table that already holds the per-stage config.
--
-- Guarded, because stage_thresholds arrives with the dashboard module and a
-- database that skipped it would otherwise fail this whole file on a plain
-- `alter table`. The request function reads the flag through the same table and
-- the application's calls are savepoint-guarded, so a database without it simply
-- asks about every stage — which is the default anyway.
do $$
begin
  if to_regclass('public.stage_thresholds') is null then
    raise notice '003200: public.stage_thresholds is not here yet (it arrives with the dashboard migration 002800), so the per-stage feedback switch was skipped. Every stage will ask until that file is run.';
  else
    execute 'alter table public.stage_thresholds
               add column if not exists feedback_enabled boolean not null default true';
  end if;
end
$$;

-- Complete asks (and adds the recommendation question); the rest default on.
alter table public.app_settings
  add column if not exists feedback_enabled boolean not null default true,
  add column if not exists feedback_nps_enabled boolean not null default true,
  /** Templates for §5's suggested first move, by chip key. */
  add column if not exists feedback_action_templates jsonb not null default '{}'::jsonb;

update public.app_settings set feedback_action_templates = jsonb_build_object(
  'slow_updates',  'Call them with a status summary and set a date for the next update.',
  'scheduling',    'Call to re-book, with two concrete dates to choose between.',
  'communication', 'Call, apologise for the silence, and agree who they contact and how.',
  'technician',    'Review the visit with the crew lead before calling the customer back.',
  'pricing',       'Walk them through the contract line by line, including any adders.',
  'quality',       'Book a site visit to look at the concern in person.',
  'other',         'Call and ask what happened — the comment will not have the whole story.'
) where feedback_action_templates = '{}'::jsonb;

-- §4: the customer's own off switch, alongside the other notification kinds.
-- Guarded for the same reason as the switch above — this table arrives with the
-- mobile module, and every one of these files has to survive being run against a
-- database that is missing an earlier one.
do $$
begin
  if to_regclass('public.notification_preferences') is null then
    raise notice '003200: public.notification_preferences is not here yet (it arrives with the mobile migration 002500), so the rating opt-out category was skipped.';
  else
    alter table public.notification_preferences
      drop constraint if exists notification_preferences_category_check;
    alter table public.notification_preferences
      add constraint notification_preferences_category_check
      check (category in ('stage_advanced', 'appointment', 'action_needed', 'on_hold',
                          'power_on', 'chat_message', 'feedback_request'));
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 4. Row-level security
-- -----------------------------------------------------------------------------

-- app.is_project_customer() belongs to the chat module (002900) and is used by
-- the policy and the answer functions below. Created here only if it is absent,
-- so this file installs cleanly on a database that skipped 002900 — the same
-- predicate, never overwriting the original. A migration that fails because an
-- earlier one was skipped leaves an operator with a half-applied catch-up and no
-- idea which file to blame.
do $$
begin
  if to_regprocedure('app.is_project_customer(uuid)') is null then
    execute $f$
      create function app.is_project_customer(pid uuid)
      returns boolean
      language sql
      stable
      security definer
      set search_path = ''
      as $body$
        select exists (
          select 1 from public.projects p
          where p.id = pid
            and p.client_id in (select app.current_client_ids())
        );
      $body$
    $f$;
    execute 'grant execute on function app.is_project_customer(uuid) to authenticated';
  end if;
end
$$;

alter table public.project_tasks enable row level security;
alter table public.stage_feedback enable row level security;
alter table public.feedback_reasons enable row level security;

grant select on public.project_tasks to authenticated;
grant select on public.stage_feedback to authenticated;
grant select on public.feedback_reasons to authenticated;

-- Tasks are staff work. A customer must never see that their rating became a
-- ticket with a suggested script — and a dealer must not see it either.
drop policy if exists project_tasks_select on public.project_tasks;
create policy project_tasks_select on public.project_tasks
  for select to authenticated
  using ((select app.current_user_role()) in ('admin', 'ops'));

/**
 * The rating rows.
 *
 * Staff see everything. The customer sees their own project's rows, which is
 * what lets the sheet know whether to appear and what the persistent card says.
 * Dealers are NOT given the table: §5 says a dealer learns the fact and not the
 * verbatim comment, so they read a view that has no comment column in it at
 * all (below). Filtering a comment out in the application would be one edit
 * away from leaking it.
 */
-- The foundation schema's policies let any project participant insert a rating
-- and the author read their own. Both are wrong here: a dealer or designer must
-- not file a customer's rating, and every write now goes through a function.
drop policy if exists stage_feedback_insert on public.stage_feedback;
drop policy if exists stage_feedback_write_admin_u on public.stage_feedback;
drop policy if exists stage_feedback_write_admin_d on public.stage_feedback;

drop policy if exists stage_feedback_select on public.stage_feedback;
create policy stage_feedback_select on public.stage_feedback
  for select to authenticated
  using (
    (select app.current_user_role()) in ('admin', 'ops')
    or app.is_project_customer(project_id)
  );

drop policy if exists feedback_reasons_select on public.feedback_reasons;
create policy feedback_reasons_select on public.feedback_reasons
  for select to authenticated using (true);

drop policy if exists feedback_reasons_write on public.feedback_reasons;
create policy feedback_reasons_write on public.feedback_reasons
  for all to authenticated
  using (app.is_admin()) with check (app.is_admin());

-- Every write to a rating goes through a function below. The same reasoning as
-- the chat module: a table a customer can update directly is a table where a
-- customer can set somebody else's score, or their own twice.
revoke insert, update, delete on public.stage_feedback from authenticated;
revoke insert, update, delete on public.project_tasks from authenticated;

-- -----------------------------------------------------------------------------
-- 5. Asking
-- -----------------------------------------------------------------------------

/**
 * Create the request for a stage that has just completed.
 *
 * Called by the stage-move service as part of the same transaction as the move,
 * so a completed stage and its rating request cannot come apart. Returns the
 * request id, or null when a guardrail says not to ask — every one of §1 and
 * §4's rules is checked here rather than at the call site, because the call site
 * will eventually be more than one place.
 */
create or replace function public.request_stage_feedback(
  p_project uuid,
  p_stage   public.project_stage
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id           uuid;
  v_project      record;
  v_enabled      boolean;
  v_last_request timestamptz;
  v_send_after   timestamptz := now();
  v_tz           text;
  v_opted_out    boolean;
  v_party_kind   text;
  v_party_id     uuid;
  v_party_name   text;
begin
  if (select app.current_user_role()) not in ('admin', 'ops') then
    raise exception 'only staff may raise a feedback request' using errcode = '42501';
  end if;

  -- Globally off, or off for this stage (§3's per-stage configuration).
  select coalesce(a.feedback_enabled, true) into v_enabled
    from public.app_settings a where a.id;
  if not coalesce(v_enabled, true) then return null; end if;

  -- Same reasoning as the guarded alter above: on a database without the
  -- dashboard migration there is no per-stage switch, and the answer is 'ask'.
  if to_regclass('public.stage_thresholds') is not null then
    execute 'select coalesce(t.feedback_enabled, true) from public.stage_thresholds t
              where t.stage = $1'
       into v_enabled using p_stage;
    if not coalesce(v_enabled, true) then return null; end if;
  end if;

  select p.id, p.status, p.assigned_pm, p.dealer_id, p.sales_rep_id, p.client_id
    into v_project
    from public.projects p where p.id = p_project;
  if not found then return null; end if;

  -- §1: a project on hold or cancelled is not asked. "Asking someone to rate
  -- the experience at the moment it goes wrong is tone-deaf and produces
  -- useless data."
  if v_project.status in ('on_hold', 'cancelled') then return null; end if;

  -- §4: the customer's own off switch, honoured everywhere.
  select exists (
    select 1 from public.notification_preferences np
    join public.clients c on c.user_id = np.user_id
    where c.id = v_project.client_id
      and np.category = 'feedback_request'
      and not np.push and not coalesce(np.email, true)
  ) into v_opted_out;
  if v_opted_out then return null; end if;

  -- §4: never two requests inside 48 hours. The second one queues rather than
  -- being dropped — permits finishing the day after equipment is a real
  -- sequence, and the second stage is still worth asking about later.
  select max(f.requested_at) into v_last_request
    from public.stage_feedback f where f.project_id = p_project;
  if v_last_request is not null and v_last_request > now() - interval '48 hours' then
    v_send_after := v_last_request + interval '48 hours';
  end if;

  -- §1: installation is asked in the evening. "A crew leaving at 4pm is still
  -- packing the van — ask when the customer has actually seen their system."
  if p_stage = 'install' then
    select coalesce(a.company_timezone, 'America/Chicago') into v_tz
      from public.app_settings a where a.id;
    -- 7pm on the day the request would otherwise go out — which is not always
    -- today: a 48-hour queue may already have pushed it into next week, and
    -- 'greatest(queued, 7pm tonight)' would then quietly drop the deferral.
    -- If it is already past 7pm that day, it is evening enough.
    if (v_send_after at time zone v_tz)::time < time '19:00' then
      v_send_after := (((v_send_after at time zone v_tz)::date + time '19:00')
                       at time zone v_tz);
    end if;
  end if;

  -- The stage-specific party, where the schema has one (§6).
  if p_stage = 'design' then
    select 'designer', d.id, d.display_name into v_party_kind, v_party_id, v_party_name
      from public.stage2_design s2
      join public.designers d on d.id = s2.designer_id
     where s2.project_id = p_project;
  end if;

  insert into public.stage_feedback
    (project_id, stage, send_after, attributed_pm, attributed_dealer, attributed_rep,
     attributed_party_kind, attributed_party_id, attributed_party_name)
  values
    (p_project, p_stage, v_send_after, v_project.assigned_pm, v_project.dealer_id,
     v_project.sales_rep_id, v_party_kind, v_party_id, v_party_name)
  -- §4 again, belt and braces: a second attempt at the same stage is a no-op
  -- rather than an error, so an admin re-running a move cannot break a save.
  on conflict (project_id, stage) do nothing
  returning id into v_id;

  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Answering
-- -----------------------------------------------------------------------------

/**
 * Record the score, on tap (§9).
 *
 * Deliberately does nothing else: no comment, no chips, no Send. If the customer
 * closes the sheet immediately afterwards — which many will — the number is
 * already saved, and that is the part the business can act on.
 *
 * A low score opens the follow-up task here, in the same statement, so §5's
 * "creates a task" is true even for a customer who taps one face and walks away.
 */
create or replace function public.record_stage_feedback(
  p_project uuid,
  p_stage   public.project_stage,
  p_score   integer,
  p_channel text default 'portal'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.stage_feedback;
begin
  if not app.is_project_customer(p_project) then
    raise exception 'only this project''s customer may rate it' using errcode = '42501';
  end if;
  if p_score is null or p_score < 1 or p_score > 5 then
    raise exception 'score must be 1 to 5' using errcode = '22023';
  end if;

  update public.stage_feedback f
     set score = p_score,
         responded_at = coalesce(f.responded_at, now()),
         channel = coalesce(f.channel, case when p_channel in ('portal', 'app', 'email')
                                            then p_channel else 'portal' end),
         dismissed_at = null
   where f.project_id = p_project and f.stage = p_stage
     and f.closed_at is null
  returning * into v_row;

  if not found then return null; end if;

  perform public.open_feedback_task(v_row.id);
  return v_row.id;
end;
$$;

/**
 * Step two: the reasons and the comment, if they keep going (§3).
 *
 * Separate from the score on purpose — see above. Also used by the email path,
 * where the score arrives by link and the comment on the page that link opens.
 */
create or replace function public.detail_stage_feedback(
  p_project uuid,
  p_stage   public.project_stage,
  p_tags    text[],
  p_comment text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.stage_feedback;
begin
  if not app.is_project_customer(p_project) then
    raise exception 'only this project''s customer may rate it' using errcode = '42501';
  end if;

  update public.stage_feedback f
     set tags = coalesce(
           (select array_agg(r.key order by r.sort_order)
              from public.feedback_reasons r
             where r.key = any(coalesce(p_tags, '{}'))),
           '{}'),
         comment = nullif(btrim(coalesce(p_comment, '')), ''),
         -- Only a score makes this a response. Stamping responded_at on a
         -- comment alone would both violate the check constraint and count an
         -- unrated stage as answered in the response rate.
         responded_at = case when f.score is null then f.responded_at
                             else coalesce(f.responded_at, now()) end
   where f.project_id = p_project and f.stage = p_stage
  returning * into v_row;

  if not found then return null; end if;

  -- The task's suggested action depends on the chips, so it is recomputed once
  -- they arrive. A task raised by the tap alone gets the generic prompt.
  perform public.open_feedback_task(v_row.id);
  return v_row.id;
end;
$$;

/** The recommendation question, final stage only (§3). */
create or replace function public.record_stage_nps(
  p_project uuid,
  p_stage   public.project_stage,
  p_nps     integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.stage_feedback;
begin
  if not app.is_project_customer(p_project) then
    raise exception 'only this project''s customer may rate it' using errcode = '42501';
  end if;
  if p_nps is null or p_nps < 0 or p_nps > 10 then
    raise exception 'recommendation score must be 0 to 10' using errcode = '22023';
  end if;

  update public.stage_feedback f
     set nps = p_nps, responded_at = coalesce(f.responded_at, now())
   where f.project_id = p_project and f.stage = p_stage
  returning * into v_row;

  if not found then return null; end if;
  -- §5: a detractor is treated exactly like a low stage score.
  perform public.open_feedback_task(v_row.id);
  return v_row.id;
end;
$$;

/** 'Not now'. Dismissible, never blocking (§2). */
create or replace function public.dismiss_stage_feedback(
  p_project uuid,
  p_stage   public.project_stage
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not app.is_project_customer(p_project) then
    raise exception 'not your project' using errcode = '42501';
  end if;
  update public.stage_feedback
     set dismissed_at = now()
   where project_id = p_project and stage = p_stage and responded_at is null;
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. A low score becomes work
-- -----------------------------------------------------------------------------

/**
 * Open (or update) the follow-up task for a rating.
 *
 * §5: score 1–2, or NPS 0–6, creates a task flagged high, carrying the score,
 * the comment, the chips and which stage it refers to. Idempotent: called again
 * when the comment arrives, it fills in the detail rather than raising a second
 * task.
 *
 * Internal — the application never calls this directly, which is why it is not
 * granted below. It exists as its own function so the rule "what counts as a
 * low score" is written once.
 */
create or replace function public.open_feedback_task(p_feedback uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_f         public.stage_feedback;
  v_project   record;
  v_task      uuid;
  v_low       boolean;
  v_templates jsonb;
  v_suggested text;
  v_labels    text;
begin
  select * into v_f from public.stage_feedback where id = p_feedback;
  if not found then return null; end if;

  v_low := (v_f.score is not null and v_f.score <= 2)
        or (v_f.nps is not null and v_f.nps <= 6);
  if not v_low then return v_f.task_id; end if;

  select p.name, p.code, p.assigned_pm into v_project
    from public.projects p where p.id = v_f.project_id;

  select a.feedback_action_templates into v_templates
    from public.app_settings a where a.id;

  -- §5: the suggested first move comes from the chips. The first chip wins —
  -- with two selected the customer's first choice is the more likely cause.
  select string_agg(r.label, ', ' order by r.sort_order) into v_labels
    from public.feedback_reasons r where r.key = any(v_f.tags);
  select coalesce(
      v_templates ->> (v_f.tags)[1],
      'Call them, ask what happened, and agree the next step.')
    into v_suggested;

  if v_f.task_id is not null then
    update public.project_tasks
       set detail = format('Score %s of 5 on %s.%s%s',
                           coalesce(v_f.score::text, '—'),
                           replace(v_f.stage::text, '_', ' '),
                           case when v_labels is null then '' else ' Reasons: ' || v_labels || '.' end,
                           case when v_f.comment is null then ''
                                else E'\n\n' || v_f.comment end),
           suggested = v_suggested
     where id = v_f.task_id and resolved_at is null;
    return v_f.task_id;
  end if;

  insert into public.project_tasks (project_id, source, title, suggested, detail, priority, assigned_to)
  values (
    v_f.project_id,
    'feedback',
    format('Low rating on %s — %s', replace(v_f.stage::text, '_', ' '),
           coalesce(v_project.name, v_project.code)),
    v_suggested,
    format('Score %s of 5 on %s.%s%s',
           coalesce(v_f.score::text, '—'),
           replace(v_f.stage::text, '_', ' '),
           case when v_labels is null then '' else ' Reasons: ' || v_labels || '.' end,
           case when v_f.comment is null then '' else E'\n\n' || v_f.comment end),
    'high',
    coalesce(v_f.attributed_pm, v_project.assigned_pm)
  )
  returning id into v_task;

  update public.stage_feedback set task_id = v_task where id = p_feedback;
  return v_task;
end;
$$;

/** Close a task with the note §5 requires. */
create or replace function public.resolve_project_task(p_task uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select app.current_user_role()) not in ('admin', 'ops') then
    raise exception 'only staff may resolve a task' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_note, ''))) = 0 then
    raise exception 'a resolution note is required' using errcode = '22023';
  end if;
  update public.project_tasks
     set resolved_at = now(),
         resolved_by = (select auth.uid()),
         resolution = btrim(p_note)
   where id = p_task and resolved_at is null;
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. The email fallback (§2)
-- -----------------------------------------------------------------------------
-- "If nothing has been answered in the portal or app after 24 hours, one email
-- with the five faces as clickable links — clicking a face records the score
-- immediately and opens the portal for the optional comment. This is where most
-- responses will actually come from."
--
-- Which means the link must work without a login (§9). One token per request,
-- stored hashed; the five links differ only by the score in the query string.
-- The precedent is the no-login upload link the platform already has.

/** Issue (or reissue) the token for a request. Staff/cron only. */
create or replace function public.feedback_email_token(p_feedback uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  if (select app.current_user_role()) not in ('admin', 'ops') then
    raise exception 'only staff may issue a feedback token' using errcode = '42501';
  end if;
  update public.stage_feedback
     set token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex'),
         reminded_at = now()
   where id = p_feedback and responded_at is null and closed_at is null;
  if not found then return null; end if;
  return v_token;
end;
$$;

/**
 * Record a score from an emailed link, with no session at all.
 *
 * Safe to expose because the token grants exactly one capability: setting the
 * score on one rating request. It reads nothing, and a guessed token is 24
 * random bytes. It returns the project id so the page that opened can show the
 * thank-you and offer the comment box.
 *
 * Tokens stay usable while the request is open, so a customer who clicks a face
 * twice, or clicks a different face on reflection, gets the answer they meant
 * rather than an error page.
 */
-- Dropped first: `create or replace` cannot change a function's return type, and
-- this one's third column was smallint in an earlier draft of this file. Anybody
-- who ran that draft would otherwise keep the broken definition for ever, with
-- the file reporting success.
drop function if exists public.record_feedback_by_token(text, integer);
create or replace function public.record_feedback_by_token(p_token text, p_score integer)
-- `score integer`, not smallint: the column this reads was created as integer by
-- the foundation schema and deliberately left that way (see above), and plpgsql
-- compares RETURN QUERY types exactly — a smallint declaration here fails at
-- runtime with 'structure of query does not match function result type', on the
-- one path that has no session to show an error to.
returns table (project_id uuid, stage public.project_stage, score integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.stage_feedback;
begin
  if p_score is null or p_score < 1 or p_score > 5 then
    raise exception 'score must be 1 to 5' using errcode = '22023';
  end if;

  update public.stage_feedback f
     set score = p_score,
         responded_at = coalesce(f.responded_at, now()),
         channel = coalesce(f.channel, 'email')
   where f.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
     and f.closed_at is null
     and f.requested_at > now() - interval '60 days'
  returning * into v_row;

  if not found then return; end if;
  perform public.open_feedback_task(v_row.id);
  return query select v_row.project_id, v_row.stage, v_row.score;
end;
$$;

/**
 * The comment box on the emailed page, again with no session.
 *
 * Same token, same single capability, extended to the optional detail — the
 * alternative is asking somebody who has just told you they are unhappy to go
 * and find their password.
 */
create or replace function public.detail_feedback_by_token(
  p_token   text,
  p_tags    text[],
  p_comment text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.stage_feedback;
begin
  update public.stage_feedback f
     set tags = coalesce(
           (select array_agg(r.key order by r.sort_order)
              from public.feedback_reasons r
             where r.key = any(coalesce(p_tags, '{}'))),
           '{}'),
         comment = nullif(btrim(coalesce(p_comment, '')), '')
   where f.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
     and f.responded_at is not null
     and f.requested_at > now() - interval '60 days'
  returning * into v_row;

  if not found then return null; end if;
  perform public.open_feedback_task(v_row.id);
  return v_row.id;
end;
$$;

/**
 * What the cron endpoint needs: requests that are due, unanswered, and have not
 * had their one email yet. Also closes the ones that have had both attempts —
 * §4's "asked twice, then never", which has to be a state, not a silence.
 */
create or replace function public.claim_feedback_emails(p_limit integer default 50)
returns table (f_id uuid, f_project uuid, f_stage public.project_stage, f_token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_token text;
begin
  if (select app.current_user_role()) not in ('admin', 'ops') then
    raise exception 'only staff may send feedback email' using errcode = '42501';
  end if;

  -- Both attempts spent and still nothing: close it, and never ask again.
  update public.stage_feedback
     set closed_at = now()
   where responded_at is null and closed_at is null
     and reminded_at is not null
     and reminded_at < now() - interval '7 days';

  for v_row in
    select f.id, f.project_id, f.stage
      from public.stage_feedback f
     where f.responded_at is null
       and f.closed_at is null
       and f.reminded_at is null
       and f.send_after < now() - interval '24 hours'
     order by f.send_after
     limit greatest(1, least(200, coalesce(p_limit, 50)))
  loop
    v_token := public.feedback_email_token(v_row.id);
    if v_token is not null then
      return query select v_row.id, v_row.project_id, v_row.stage, v_token;
    end if;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Retention (§8)
-- -----------------------------------------------------------------------------
-- "Verbatim comments anonymised after two years; scores retained with the
-- project record." The score is a business metric; the sentence somebody typed
-- about their own house is personal data with a shelf life.

create or replace function public.sweep_feedback_comments()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.stage_feedback
     set comment = null
   where comment is not null
     and responded_at < now() - interval '2 years';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- 10. Reporting (§7)
-- -----------------------------------------------------------------------------
-- security_invoker views, so the reader's own policies decide what they can see
-- and these do not become a way around them.

-- CSAT by stage, with the response count beside every average — an average of
-- three answers is a different fact from an average of ninety.
create or replace view public.feedback_by_stage
with (security_invoker = true) as
select f.stage::text as stage,
       count(*) filter (where f.score is not null)          as responses,
       count(*)                                             as requests,
       round(avg(f.score) filter (where f.score is not null), 2) as avg_score,
       count(*) filter (where f.score <= 2)                 as low_scores,
       count(*) filter (where f.responded_at is null and f.closed_at is not null) as unanswered
  from public.stage_feedback f
 group by f.stage;

grant select on public.feedback_by_stage to authenticated;

-- The trend, by month, so you can see whether a fix worked.
create or replace view public.feedback_monthly
with (security_invoker = true) as
select date_trunc('month', f.responded_at)::date as month,
       count(*)                                   as responses,
       round(avg(f.score), 2)                     as avg_score,
       count(*) filter (where f.score <= 2)       as low_scores
  from public.stage_feedback f
 where f.responded_at is not null and f.score is not null
 group by 1;

grant select on public.feedback_monthly to authenticated;

/**
 * By party (§6, §7) — PM, dealer, rep, and the stage party where there is one.
 *
 * Admin and ops only, and not because the numbers are secret: §6 is explicit
 * that these are "a prompt for a conversation, not a league table", and a
 * per-person average visible to everyone becomes a league table whatever the
 * documentation says. Sample sizes travel with every row for the same reason.
 */
create or replace view public.feedback_by_party
with (security_invoker = false) as
select kind, party_id, party_name,
       count(*) as responses,
       round(avg(score), 2) as avg_score,
       count(*) filter (where score <= 2) as low_scores
  from (
    select 'pm' as kind, f.attributed_pm as party_id,
           coalesce(pr.full_name, pr.email) as party_name, f.score
      from public.stage_feedback f
      join public.profiles pr on pr.id = f.attributed_pm
     where f.score is not null
    union all
    select 'dealer', f.attributed_dealer, d.name, f.score
      from public.stage_feedback f
      join public.dealers d on d.id = f.attributed_dealer
     where f.score is not null
    union all
    select 'rep', f.attributed_rep, sr.name, f.score
      from public.stage_feedback f
      join public.sales_reps sr on sr.id = f.attributed_rep
     where f.score is not null
    union all
    select f.attributed_party_kind, f.attributed_party_id, f.attributed_party_name, f.score
      from public.stage_feedback f
     where f.score is not null and f.attributed_party_kind is not null
  ) parties
 where (select app.current_user_role()) in ('admin', 'ops')
 group by kind, party_id, party_name;

grant select on public.feedback_by_party to authenticated;

-- Response rate per channel (§7): if the email carries most of the answers,
-- that is a fact about the portal worth knowing.
create or replace view public.feedback_response_rate
with (security_invoker = true) as
select coalesce(f.channel, 'unanswered') as channel,
       count(*) as requests,
       count(*) filter (where f.responded_at is not null) as responses
  from public.stage_feedback f
 group by 1;

grant select on public.feedback_response_rate to authenticated;

/**
 * The verbatim log — §7 calls it "the most useful part of the whole module —
 * read it, do not just average it".
 *
 * Definer with an explicit role guard, because it carries what a customer wrote
 * about their own project and the join to project and PM names. Dealers and
 * customers get nothing from it.
 */
create or replace view public.feedback_verbatims
with (security_invoker = false) as
select f.id, f.project_id, p.name as project_name, p.code as project_code,
       f.stage::text as stage, f.score, f.nps, f.comment, f.tags,
       f.channel, f.responded_at,
       coalesce(pr.full_name, pr.email) as pm_name,
       d.name as dealer_name,
       f.task_id,
       t.resolved_at as task_resolved_at
  from public.stage_feedback f
  join public.projects p on p.id = f.project_id
  left join public.profiles pr on pr.id = f.attributed_pm
  left join public.dealers d on d.id = f.attributed_dealer
  left join public.project_tasks t on t.id = f.task_id
 where f.responded_at is not null
   and (select app.current_user_role()) in ('admin', 'ops');

grant select on public.feedback_verbatims to authenticated;

/**
 * A project's rolling rating (§8), for the project card and the dealer portal.
 *
 * This is the dealer's whole view of the module: an average and a count for
 * their own projects, with no comment column in it to leak.
 *
 * Definer with its own guard, not security_invoker — that was the first attempt
 * and it gave the dealer nothing at all. The policy that would have applied is
 * the one on stage_feedback, which admits staff and the project's customer; a
 * dealer reading through it sees no rows to aggregate. So the scoping is written
 * here, once, and the view carries no column a dealer may not see.
 */
create or replace view public.project_csat
with (security_invoker = false) as
select f.project_id,
       count(*) filter (where f.score is not null) as responses,
       round(avg(f.score) filter (where f.score is not null), 2) as avg_score,
       min(f.score) as worst_score,
       count(*) filter (where f.score <= 2 and f.task_id is not null) as low_scores,
       max(f.responded_at) as last_responded_at
  from public.stage_feedback f
 where (select app.current_user_role()) in ('admin', 'ops')
    or app.is_project_customer(f.project_id)
    or exists (
         select 1 from public.projects p
          where p.id = f.project_id
            and p.dealer_id = any (select app.current_dealer_ids())
       )
 group by f.project_id;

grant select on public.project_csat to authenticated;

-- How long low-score tasks take to close, and how many are open (§7): the
-- measure of whether the loop is actually closing.
create or replace view public.feedback_task_stats
with (security_invoker = false) as
select count(*) filter (where t.resolved_at is null) as open_tasks,
       count(*) filter (where t.resolved_at is not null) as closed_tasks,
       round(avg(extract(epoch from (t.resolved_at - t.created_at)) / 86400.0)
             filter (where t.resolved_at is not null), 1) as avg_days_to_close,
       max(extract(epoch from (now() - t.created_at)) / 86400.0)
             filter (where t.resolved_at is null) as oldest_open_days
  from public.project_tasks t
 where t.source = 'feedback'
   and (select app.current_user_role()) in ('admin', 'ops');

grant select on public.feedback_task_stats to authenticated;

-- -----------------------------------------------------------------------------
-- 11. Grants
-- -----------------------------------------------------------------------------

revoke execute on function
  public.request_stage_feedback(uuid, public.project_stage),
  public.record_stage_feedback(uuid, public.project_stage, integer, text),
  public.detail_stage_feedback(uuid, public.project_stage, text[], text),
  public.record_stage_nps(uuid, public.project_stage, integer),
  public.dismiss_stage_feedback(uuid, public.project_stage),
  public.open_feedback_task(uuid),
  public.resolve_project_task(uuid, text),
  public.feedback_email_token(uuid),
  public.record_feedback_by_token(text, integer),
  public.detail_feedback_by_token(text, text[], text),
  public.claim_feedback_emails(integer),
  public.sweep_feedback_comments()
from public, anon;

-- open_feedback_task is deliberately NOT granted: it is called from inside the
-- functions above, and a caller who could reach it directly could raise a task
-- against any project.
grant execute on function
  public.request_stage_feedback(uuid, public.project_stage),
  public.record_stage_feedback(uuid, public.project_stage, integer, text),
  public.detail_stage_feedback(uuid, public.project_stage, text[], text),
  public.record_stage_nps(uuid, public.project_stage, integer),
  public.dismiss_stage_feedback(uuid, public.project_stage),
  public.resolve_project_task(uuid, text),
  public.feedback_email_token(uuid),
  public.record_feedback_by_token(text, integer),
  public.detail_feedback_by_token(text, text[], text),
  public.claim_feedback_emails(integer),
  public.sweep_feedback_comments()
to authenticated;

-- -----------------------------------------------------------------------------
-- 12. Audit
-- -----------------------------------------------------------------------------
-- Ratings are not audited row by row: the row itself is the record, it is
-- written once by the person it belongs to, and a second copy in the audit log
-- would double the storage of the most-written table in the module for no new
-- information. Tasks are audited, because a task being raised, reassigned and
-- closed is exactly the history somebody will want to reconstruct.

drop trigger if exists audit_row on public.project_tasks;
create trigger audit_row after insert or update or delete on public.project_tasks
  for each row execute function app.tg_audit_row();



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
  ('20260803003200_stage_feedback.sql')
on conflict (name) do nothing;
