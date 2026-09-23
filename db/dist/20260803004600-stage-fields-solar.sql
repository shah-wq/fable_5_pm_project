-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · newest module · step 14 of 15 · 20260803004600_stage_fields_solar.sql
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
--   15. 20260803004700-notifications.sql
-- Each break is where one script adds something the next one uses, which
-- PostgreSQL will not allow inside a single pasted transaction.
--
-- Behind by more than this module? Run every db/dist/catch-up-*.sql in order
-- instead — they cover everything from 001400 onwards.
-- ============================================================================

-- >>> 20260803004600_stage_fields_solar.sql
-- =============================================================================
-- Stage fields a solar installer needs
-- =============================================================================
-- The stage forms recorded the milestones (status and dates) and the money.
-- They did not record the facts each stage produces — the main panel rating
-- found at survey, the permit number and its expiry, the purchase order, the
-- crew, the inspector, the meter set, the monitoring site — so those lived in
-- notes, email and people's heads, where no report, reminder or automation
-- could reach them.
--
-- Every column here is optional. Nothing changes what a stage needs to
-- advance; these are the places the facts go, and the document reader
-- (migration 004800) writes into them. Numbers are numeric so they can be
-- summed and compared in reports; short choices are text with a check, in the
-- form's own vocabulary.
-- =============================================================================

-- Survey: what the site is -----------------------------------------------------
alter table public.stage1_survey
  add column if not exists surveyor_id             uuid references public.profiles (id) on delete set null,
  add column if not exists survey_scheduled_date   date,
  add column if not exists roof_type               text check (roof_type in
    ('comp_shingle', 'tile', 'metal', 'flat', 'wood_shake', 'other')),
  add column if not exists roof_age_years          numeric(5,1) check (roof_age_years >= 0),
  add column if not exists roof_condition          text check (roof_condition in
    ('good', 'fair', 'poor', 'replace_first')),
  add column if not exists stories                 numeric(3,1) check (stories > 0),
  add column if not exists roof_pitch              text,
  add column if not exists main_panel_rating_amps  numeric(5,0) check (main_panel_rating_amps > 0),
  add column if not exists bus_bar_rating_amps     numeric(5,0) check (bus_bar_rating_amps > 0),
  add column if not exists main_breaker_amps       numeric(5,0) check (main_breaker_amps > 0),
  add column if not exists panel_upgrade_needed    text check (panel_upgrade_needed in ('yes', 'no', 'tbd')),
  add column if not exists meter_number            text,
  add column if not exists utility_account_number  text,
  add column if not exists attic_access            text check (attic_access in ('yes', 'no', 'limited')),
  add column if not exists trenching_distance_ft   numeric(7,1) check (trenching_distance_ft >= 0),
  add column if not exists shading_notes           text,
  add column if not exists site_notes              text;

-- Design: what was designed -----------------------------------------------------
alter table public.stage2_design
  add column if not exists final_system_size_kw    numeric(8,3) check (final_system_size_kw > 0),
  add column if not exists final_module_count      numeric(5,0) check (final_module_count > 0),
  add column if not exists production_estimate_kwh numeric(10,0) check (production_estimate_kwh >= 0),
  add column if not exists offset_percent          numeric(5,1) check (offset_percent >= 0),
  add column if not exists design_revision         numeric(3,0) check (design_revision >= 0),
  add column if not exists customer_approval_date  date,
  add column if not exists design_tool_url         text,
  add column if not exists engineering_firm        text,
  add column if not exists pe_stamp_required       text check (pe_stamp_required in ('yes', 'no', 'tbd'));

-- Permits: the numbers on the paperwork -----------------------------------------
alter table public.stage3_permit
  add column if not exists permit_number           text,
  add column if not exists permit_expiry_date      date,
  add column if not exists permit_fee              numeric(10,2) check (permit_fee >= 0),
  add column if not exists permit_submission_method text check (permit_submission_method in
    ('portal', 'email', 'in_person', 'solarapp')),
  add column if not exists ica_application_number  text,
  add column if not exists meter_swap_required     text check (meter_swap_required in ('yes', 'no', 'na')),
  add column if not exists hoa_name                text,
  add column if not exists hoa_contact             text;

-- Procurement: the order -------------------------------------------------------
alter table public.stage4_procurement
  add column if not exists vendor_name             text,
  add column if not exists po_number               text,
  add column if not exists order_date              date,
  add column if not exists expected_delivery_date  date,
  add column if not exists tracking_number         text,
  add column if not exists material_location       text check (material_location in
    ('vendor', 'warehouse', 'site')),
  add column if not exists material_cost           numeric(12,2) check (material_cost >= 0);

-- Install: who, how long, signed off ---------------------------------------------
alter table public.stage5_install
  add column if not exists crew_lead               text,
  add column if not exists crew_size               numeric(3,0) check (crew_size > 0),
  add column if not exists install_duration_days   numeric(4,1) check (install_duration_days > 0),
  add column if not exists mpu_completed_date      date,
  add column if not exists homeowner_signoff_date  date,
  add column if not exists install_notes           text;

-- Inspection & PTO: the visit, the utility, the monitoring -----------------------
alter table public.stage6_inspection
  add column if not exists inspection_scheduled_date date,
  add column if not exists inspector_name          text,
  add column if not exists reinspection_date       date,
  add column if not exists pto_application_number  text,
  add column if not exists meter_set_date          date,
  add column if not exists monitoring_platform     text check (monitoring_platform in
    ('enphase', 'solaredge', 'tesla', 'generac', 'other')),
  add column if not exists monitoring_site_id      text;

-- Complete: closing out ----------------------------------------------------------
alter table public.stage7_complete
  add column if not exists warranty_registration_date date,
  add column if not exists final_payment_received_date date,
  add column if not exists closeout_packet_sent_date date,
  add column if not exists review_requested_date   date,
  add column if not exists referral_asked          text check (referral_asked in ('yes', 'no'));

-- The permit expiry is what the reminder job watches (004700); an index keeps
-- that a cheap question.
create index if not exists stage3_permit_expiry_idx
  on public.stage3_permit (permit_expiry_date) where permit_expiry_date is not null;

