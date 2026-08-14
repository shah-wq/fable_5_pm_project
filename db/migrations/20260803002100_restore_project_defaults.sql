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
