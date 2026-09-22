-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · newest module · step 8 of 10 · 20260803004000_project_holds_contact.sql
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
-- Each break is where one script adds something the next one uses, which
-- PostgreSQL will not allow inside a single pasted transaction.
--
-- Behind by more than this module? Run every db/dist/catch-up-*.sql in order
-- instead — they cover everything from 001400 onwards.
-- ============================================================================

-- >>> 20260803004000_project_holds_contact.sql
-- =============================================================================
-- The project holds the contact in place, until it is deleted
-- =============================================================================
-- 003900 makes signing record the system and create the project. This file
-- adds what follows from there being a project: the contact stays in Contract
-- signed. Moving somebody with a live installation back to Quoted, or out to
-- Lost, would put the board and the job in disagreement about whether they are
-- a customer — so the move is refused until the project is deleted, which is
-- the one honest way to say "this sale did not happen after all".
--
-- Deleting a project is new here, and it is admin-only. It is not the same as
-- cancelling one: a cancelled project is a job that stopped and stays on
-- record; a deleted one is a sale that is being unwound. The deal's documents
-- — the signed agreement, the bills — belong to the sale, and are kept.
-- =============================================================================

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'deals'
                    and column_name = 'system_recorded_at') then
    raise exception 'Run 20260803003900_contract_signed_system.sql first — it adds signing.'
      using hint = 'Admin → Database → Apply runs every missing file in order.';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- The project a signed contact is held by
-- -----------------------------------------------------------------------------
/**
 * The project made when this contact signed, if it still exists. Their newest
 * signing wins where there is more than one. Null means nothing holds them.
 *
 * Only a signed deal counts — one whose system was recorded at signing. A
 * returning customer whose project from five years ago came through the deal
 * board is not held in place by it.
 */
create or replace function public.contact_project(p_client uuid)
returns table (project_id uuid, project_code text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.code
    from public.deals d
    join public.projects p on p.id = d.project_id
   where d.client_id = p_client
     and d.system_recorded_at is not null
   order by d.system_recorded_at desc
   limit 1;
$$;

revoke execute on function public.contact_project(uuid) from public, anon;
grant execute on function public.contact_project(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- The hold
-- -----------------------------------------------------------------------------
/**
 * A contact with a project cannot leave Contract signed.
 *
 * On the table rather than in the move function, because there are three ways
 * to change a stage — the board, the Lead status box, and anything with SQL —
 * and a rule that holds on two of them does not hold.
 */
create or replace function app.tg_client_stage_hold()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  if old.contact_stage = 'contract_signed'
     and new.contact_stage is distinct from old.contact_stage then
    select cp.project_code into v_code from public.contact_project(new.id) cp;
    if v_code is not null then
      raise exception 'this contact has a project (%) — delete the project before moving them out of Contract signed', v_code
        using errcode = '55000',
              hint = 'The project holds them in place. An admin can delete it from the project page.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists client_stage_hold on public.clients;
create trigger client_stage_hold before update of contact_stage on public.clients
  for each row execute function app.tg_client_stage_hold();

-- -----------------------------------------------------------------------------
-- Deleting a project
-- -----------------------------------------------------------------------------
/**
 * Unwind a sale: the project goes, and the deal is open again.
 *
 * Admin-only, and the project's code has to be typed to confirm — this takes
 * the project's stages, tasks, messages and forms with it, and there is no
 * undo. What it keeps:
 *
 *   · the deal's documents. They were filed against the deal and only gained
 *     the project relation at conversion; the signed agreement belongs to the
 *     sale, not to the job. Documents filed against the project alone go with
 *     it.
 *   · the deal, reopened at Contract out with its system intact, and no longer
 *     Won — a won deal with no project is the state the conversion exists to
 *     prevent.
 *   · the activity log, which is not tied to the project row.
 *
 * The contact stays in Contract signed, and can now be moved.
 */
create or replace function public.delete_project(p_project uuid, p_confirm text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.projects%rowtype;
  v_deals uuid[];
begin
  if not app.is_admin() then
    raise exception 'only an admin may delete a project' using errcode = '42501';
  end if;

  select * into v from public.projects p where p.id = p_project for update;
  if not found then
    raise exception 'that project no longer exists' using errcode = 'P0002';
  end if;
  if p_confirm is distinct from v.code then
    raise exception 'type the project code % to confirm', v.code using errcode = '22023';
  end if;

  update public.documents d set project_id = null
   where d.project_id = p_project and d.deal_id is not null;

  select coalesce(array_agg(d.id), '{}') into v_deals
    from public.deals d where d.project_id = p_project;
  update public.deals d
     set project_id = null, stage = 'contract_out', won_at = null
   where d.project_id = p_project;
  -- The one reference that would otherwise refuse the delete: a dealer
  -- submission that was converted to this project. The submission stays; it
  -- just no longer points at a project that is not there.
  update public.deals d set converted_project_id = null
   where d.converted_project_id = p_project;

  delete from public.projects p where p.id = p_project;

  perform public.log_audit_event(
    'project.deleted', 'projects', p_project::text, p_project,
    jsonb_build_object('code', v.code, 'name', v.name, 'client_id', v.client_id,
                       'reopened_deals', to_jsonb(v_deals)),
    'system', v_deals[1], v.client_id);

  return v.client_id;
end;
$$;

revoke execute on function public.delete_project(uuid, text) from public, anon;
grant execute on function public.delete_project(uuid, text) to authenticated;

