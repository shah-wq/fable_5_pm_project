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
create table public.system_types (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.module_types (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  manufacturer text,
  wattage      integer check (wattage > 0),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table public.inverter_types (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  manufacturer text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table public.battery_types (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  manufacturer text,
  capacity_kwh numeric(8,2) check (capacity_kwh > 0),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table public.financing_companies (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.cash_financing_options (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Sales reps as a list, not free text — 'J. Smith', 'John Smith' and 'jsmith'
-- must not become three different reps.
create table public.sales_reps (
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
  add column sales_rep_id         uuid references public.sales_reps (id),
  add column system_type_id       uuid references public.system_types (id),
  add column module_type_id       uuid references public.module_types (id),
  add column module_quantity      integer check (module_quantity > 0),
  add column inverter_type_id     uuid references public.inverter_types (id),
  add column battery_type_id      uuid references public.battery_types (id),
  add column cash_or_financing_id uuid references public.cash_financing_options (id),
  add column financing_company_id uuid references public.financing_companies (id),
  add column financing_notes      text;

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
    execute format($p$
      create policy %1$I_select on public.%1$I
        for select to authenticated
        using ((select app.current_user_role()) in ('admin', 'ops', 'designer', 'finance'))
    $p$, t);
    execute format($p$
      create policy %1$I_write_i on public.%1$I
        for insert to authenticated
        with check ((select app.current_user_role()) in ('admin', 'ops'))
    $p$, t);
    execute format($p$
      create policy %1$I_write_u on public.%1$I
        for update to authenticated
        using ((select app.current_user_role()) in ('admin', 'ops'))
        with check ((select app.current_user_role()) in ('admin', 'ops'))
    $p$, t);
    execute format($p$
      create policy %1$I_delete_admin on public.%1$I
        for delete to authenticated
        using ((select app.is_admin()))
    $p$, t);
    execute format('create trigger set_updated_at before update on public.%I
                    for each row execute function app.tg_set_updated_at()', t);
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

