-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
-- Bootstrap part 3 of 3 for a fresh database via a SQL console (e.g. Neon SQL Editor).
-- Run the parts in order, each as its own execution.
-- Includes: 20260803001600_complete_stage_backfill.sql, migration bookkeeping
-- ============================================================================

-- >>> 20260803001600_complete_stage_backfill.sql

-- =============================================================================
-- 001600 — Backfill: completed projects land on the Complete stage
-- =============================================================================
-- Projects that finished before 001500 added the 'complete' enum value have
-- status = 'complete' but stage still at 'inspection_pto', so they never show
-- in the board's Complete column and an admin back-out targets the wrong
-- stage. Move them onto the Complete stage and seed their completion record.

update public.projects
set stage = 'complete'
where status = 'complete' and stage <> 'complete';

insert into public.stage7_complete (project_id, completion_date)
select p.id, current_date
from public.projects p
where p.status = 'complete'
on conflict (project_id) do nothing;



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
  ('20260803001600_complete_stage_backfill.sql')
on conflict (name) do nothing;
