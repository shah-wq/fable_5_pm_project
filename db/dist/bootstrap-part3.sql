-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
-- Bootstrap part 3 of 3 for a fresh database via a SQL console (e.g. Neon SQL Editor).
-- Run the parts in order, each as its own execution.
-- Includes: 20260803001600_complete_stage_backfill.sql, 20260803001700_project_details.sql, 20260803001800_equipment_quantities.sql, 20260803001900_dealer_portal.sql, 20260803002000_dealer_companies.sql, 20260803002100_restore_project_defaults.sql, 20260803002200_report_builder.sql, migration bookkeeping
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
  ('20260803002200_report_builder.sql')
on conflict (name) do nothing;
