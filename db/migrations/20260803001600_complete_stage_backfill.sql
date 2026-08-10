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
