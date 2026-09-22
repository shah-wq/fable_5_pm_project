-- =============================================================================
-- Contract signed — the system is recorded at the moment it is sold
-- =============================================================================
-- A contact is a person until they sign, and nothing about a system belongs on
-- a person who has not bought one. Once they sign, the system is the most
-- important thing about them: what was sold, at what size, for how much.
--
-- So signing is a step rather than a drag. Moving somebody into Contract signed
-- asks for the system there and then, records it on the deal, moves them, and
-- creates the project (004100). From that moment the contact record shows the
-- system. Before it, the contact record shows nothing about systems at all,
-- because there is nothing true to show.
--
-- The facts live on the deal, as they always have: a person with two
-- properties signs two contracts. What this file adds is the marker that says
-- "this deal's system was recorded at signing".
-- =============================================================================

do $$
begin
  if to_regclass('public.deals') is null then
    raise exception 'Run 20260803003400_crm_foundation.sql first — it creates deals.'
      using hint = 'Admin → Database → Apply runs every missing file in order.';
  end if;
  if to_regprocedure('public.convert_deal_to_project(uuid,public.project_stage)') is null then
    raise exception 'Run 20260803003500_deals.sql first — it converts deals to projects.'
      using hint = 'Admin → Database → Apply runs every missing file in order.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'clients'
                    and column_name = 'contact_stage') then
    raise exception 'Run 20260803003800_contact_stages.sql first — it adds the contact stage.'
      using hint = 'Admin → Database → Apply runs every missing file in order.';
  end if;
end
$$;

/** When the system was recorded at signing. Null means it never was — which is
    true of every deal still being worked, and of every one signed before this
    file, unless the backfill below can say otherwise. */
alter table public.deals
  add column if not exists system_recorded_at timestamptz;

-- -----------------------------------------------------------------------------
-- The contacts who had already signed
-- -----------------------------------------------------------------------------
-- A contact already in Contract signed whose deal carries a system size had it
-- recorded, just not by this screen. Marking those means the System tab
-- appears for them straight away rather than asking again for something that is
-- already on file. A signed contact with no size on their deal stays unmarked:
-- nothing was recorded, and claiming otherwise would put an empty panel on the
-- record that says "here is the system" over nothing.
update public.deals d
   set system_recorded_at = coalesce(d.stage_entered_at, d.updated_at, now())
  from public.clients c
 where c.id = d.client_id
   and c.contact_stage = 'contract_signed'
   and d.system_size_kw is not null
   and d.system_recorded_at is null;

-- The signing function itself is in 20260803004100_signing_creates_project.sql.
-- It was first defined here, in a shape that made no project, and databases
-- that took that shape report this file as applied — so the final version has
-- a file of its own, which a database without it can see it is missing.
