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
