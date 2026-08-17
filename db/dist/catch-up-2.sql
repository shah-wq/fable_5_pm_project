-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · catch-up 2 of 2 · newest migration: 20260803002500_mobile_app.sql
--
-- Paste this whole file into a SQL console (e.g. the Neon SQL Editor) and run
-- it. Safe to run more than once: every statement below skips work already
-- done, so 'already exists' errors cannot happen. NOTICE lines saying
-- 'does not exist, skipping' are normal.
--
-- Run catch-up 1 first, then catch-up 2, each as its own execution.
-- Includes: 20260803001600_complete_stage_backfill.sql, 20260803001700_project_details.sql, 20260803001800_equipment_quantities.sql, 20260803001900_dealer_portal.sql, 20260803002000_dealer_companies.sql, 20260803002100_restore_project_defaults.sql, 20260803002200_report_builder.sql, 20260803002300_customer_portal.sql, 20260803002400_customer_management.sql, 20260803002500_mobile_app.sql, migration bookkeeping
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
  ('20260803002500_mobile_app.sql')
on conflict (name) do nothing;
