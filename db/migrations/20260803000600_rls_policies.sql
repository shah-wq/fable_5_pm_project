-- =============================================================================
-- 000600 — Grants + Row-Level Security for every §2 role
-- =============================================================================
-- The §2 contract this file implements (see docs/rls-matrix.md for the full
-- table-by-table matrix):
--   admin    → everything
--   designer → their queue (projects where they are the assigned designer)
--              plus internal tables for those projects
--   dealer   → their book (projects/clients of their dealer orgs)
--   customer → their own project, customer-facing rows only
--   finance  → the whitelisted columns via public.project_financials plus
--              financial tables (price_book, change_orders, vendor_quotes,
--              project_adders); NO direct project/client row access
-- service_role (BYPASSRLS) is reserved for trusted jobs; anon gets nothing.

-- -----------------------------------------------------------------------------
-- Grants: RLS is the authorization layer, so table grants are broad for
-- authenticated and zero for anon. audit_log is the exception (read-only).
-- -----------------------------------------------------------------------------

revoke all on all tables    in schema public from anon;
revoke all on all functions in schema public from anon;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Append-only audit log: rows arrive via app.write_audit() only.
revoke insert, update, delete on public.audit_log from authenticated;

-- project_financials is a read-only reporting surface. Its security_barrier
-- flag already prevents auto-updatable-view DML from reaching projects with
-- the view owner's privileges; the revoke is belt-and-braces.
revoke insert, update, delete on public.project_financials from authenticated;

-- -----------------------------------------------------------------------------
-- Enable RLS everywhere (deny-by-default until a policy grants access).
-- -----------------------------------------------------------------------------

alter table public.profiles             enable row level security;
alter table public.dealers              enable row level security;
alter table public.dealer_users         enable row level security;
alter table public.designers            enable row level security;
alter table public.clients              enable row level security;
alter table public.jurisdictions        enable row level security;
alter table public.utilities            enable row level security;
alter table public.price_book           enable row level security;
alter table public.adder_rules          enable row level security;
alter table public.vendors              enable row level security;
alter table public.projects             enable row level security;
alter table public.project_stage_events enable row level security;
alter table public.availability_slots   enable row level security;
alter table public.documents            enable row level security;
alter table public.designs              enable row level security;
alter table public.design_assets        enable row level security;
alter table public.site_surveys         enable row level security;
alter table public.project_adders       enable row level security;
alter table public.change_orders        enable row level security;
alter table public.vendor_quotes        enable row level security;
alter table public.bom_items            enable row level security;
alter table public.permits              enable row level security;
alter table public.permit_events        enable row level security;
alter table public.stage_feedback       enable row level security;
alter table public.exceptions           enable row level security;
alter table public.audit_log            enable row level security;

-- -----------------------------------------------------------------------------
-- profiles
-- -----------------------------------------------------------------------------

create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select app.is_admin()));

create policy profiles_insert_admin on public.profiles
  for insert to authenticated
  with check ((select app.is_admin()));

-- Users may edit their own row; role changes are blocked for non-admins by
-- app.tg_guard_profile_role (000400).
create policy profiles_update on public.profiles
  for update to authenticated
  using (id = (select auth.uid()) or (select app.is_admin()))
  with check (id = (select auth.uid()) or (select app.is_admin()));

create policy profiles_delete_admin on public.profiles
  for delete to authenticated
  using ((select app.is_admin()));

-- -----------------------------------------------------------------------------
-- dealers / dealer_users / designers / clients
-- -----------------------------------------------------------------------------

create policy dealers_select on public.dealers
  for select to authenticated
  using (
    (select app.is_admin())
    or id in (select app.current_dealer_ids())
    or (select app.current_user_role()) = 'finance'   -- names only; needed to read project_financials.dealer_id
  );

create policy dealers_write_admin on public.dealers
  for all to authenticated
  using ((select app.is_admin()))
  with check ((select app.is_admin()));

create policy dealer_users_select on public.dealer_users
  for select to authenticated
  using (
    (select app.is_admin())
    or user_id = (select auth.uid())
    or dealer_id in (select app.current_dealer_ids())
  );

create policy dealer_users_write_admin on public.dealer_users
  for all to authenticated
  using ((select app.is_admin()))
  with check ((select app.is_admin()));

create policy designers_select on public.designers
  for select to authenticated
  using ((select app.is_admin()) or user_id = (select auth.uid()));

create policy designers_update_own on public.designers
  for update to authenticated
  using ((select app.is_admin()) or user_id = (select auth.uid()))
  with check ((select app.is_admin()) or user_id = (select auth.uid()));

create policy designers_insert_admin on public.designers
  for insert to authenticated
  with check ((select app.is_admin()));

create policy designers_delete_admin on public.designers
  for delete to authenticated
  using ((select app.is_admin()));

create policy clients_select on public.clients
  for select to authenticated
  using (
    (select app.is_admin())
    or dealer_id in (select app.current_dealer_ids())          -- dealer: their book
    or user_id = (select auth.uid())                           -- customer: themselves
    or exists (                                                -- designer: clients on their queue
         select 1 from public.projects p
         where p.client_id = clients.id
           and p.assigned_designer_id = (select app.current_designer_id())
       )
  );

create policy clients_insert on public.clients
  for insert to authenticated
  with check (
    (select app.is_admin())
    or dealer_id in (select app.current_dealer_ids())
  );

create policy clients_update on public.clients
  for update to authenticated
  using ((select app.is_admin()) or dealer_id in (select app.current_dealer_ids()))
  with check ((select app.is_admin()) or dealer_id in (select app.current_dealer_ids()));

create policy clients_delete_admin on public.clients
  for delete to authenticated
  using ((select app.is_admin()));

-- -----------------------------------------------------------------------------
-- Reference data
-- -----------------------------------------------------------------------------

create policy jurisdictions_select on public.jurisdictions
  for select to authenticated
  using (true);

create policy jurisdictions_write_admin on public.jurisdictions
  for all to authenticated
  using ((select app.is_admin()))
  with check ((select app.is_admin()));

create policy utilities_select on public.utilities
  for select to authenticated
  using (true);

create policy utilities_write_admin on public.utilities
  for all to authenticated
  using ((select app.is_admin()))
  with check ((select app.is_admin()));

-- Costs live here → internal + finance only (no dealer/customer).
create policy price_book_select on public.price_book
  for select to authenticated
  using ((select app.current_user_role()) in ('admin', 'designer', 'finance'));

create policy price_book_write_admin on public.price_book
  for all to authenticated
  using ((select app.is_admin()))
  with check ((select app.is_admin()));

-- Dealers see adder rules so pricing to their book is explainable.
create policy adder_rules_select on public.adder_rules
  for select to authenticated
  using ((select app.current_user_role()) in ('admin', 'designer', 'finance', 'dealer'));

create policy adder_rules_write_admin on public.adder_rules
  for all to authenticated
  using ((select app.is_admin()))
  with check ((select app.is_admin()));

create policy vendors_select on public.vendors
  for select to authenticated
  using ((select app.current_user_role()) in ('admin', 'designer', 'finance'));

create policy vendors_write_admin on public.vendors
  for all to authenticated
  using ((select app.is_admin()))
  with check ((select app.is_admin()));

-- -----------------------------------------------------------------------------
-- projects — the §2 core matrix. Finance intentionally has no policy here.
-- -----------------------------------------------------------------------------

create policy projects_select on public.projects
  for select to authenticated
  using (app.can_access_project(id));

create policy projects_insert on public.projects
  for insert to authenticated
  with check (
    (select app.is_admin())
    or (
      -- dealers create projects in their own book, for their own clients
      dealer_id in (select app.current_dealer_ids())
      and exists (
        select 1 from public.clients c
        where c.id = client_id and c.dealer_id = projects.dealer_id
      )
    )
  );

create policy projects_update on public.projects
  for update to authenticated
  using (
    (select app.is_admin())
    or assigned_designer_id = (select app.current_designer_id())
    or dealer_id in (select app.current_dealer_ids())
  )
  with check (
    (select app.is_admin())
    or assigned_designer_id = (select app.current_designer_id())
    or dealer_id in (select app.current_dealer_ids())   -- a dealer can't move a project out of their book
  );

create policy projects_delete_admin on public.projects
  for delete to authenticated
  using ((select app.is_admin()));

-- -----------------------------------------------------------------------------
-- project_stage_events
-- -----------------------------------------------------------------------------

create policy project_stage_events_select on public.project_stage_events
  for select to authenticated
  using (app.can_access_project(project_id));

create policy project_stage_events_insert_staff on public.project_stage_events
  for insert to authenticated
  with check (app.is_project_staff(project_id));

create policy project_stage_events_write_admin_u on public.project_stage_events
  for update to authenticated
  using ((select app.is_admin()))
  with check ((select app.is_admin()));

create policy project_stage_events_write_admin_d on public.project_stage_events
  for delete to authenticated
  using ((select app.is_admin()));

-- -----------------------------------------------------------------------------
-- availability_slots — designers own their calendar; open slots are visible
-- to any authenticated user so booking flows can offer them; a booked slot is
-- visible to that project's participants.
-- -----------------------------------------------------------------------------

create policy availability_slots_select on public.availability_slots
  for select to authenticated
  using (
    status = 'open'
    or (select app.is_admin())
    or designer_id = (select app.current_designer_id())
    or (project_id is not null and app.can_access_project(project_id))
  );

create policy availability_slots_insert on public.availability_slots
  for insert to authenticated
  with check ((select app.is_admin()) or designer_id = (select app.current_designer_id()));

create policy availability_slots_update on public.availability_slots
  for update to authenticated
  using ((select app.is_admin()) or designer_id = (select app.current_designer_id()))
  with check ((select app.is_admin()) or designer_id = (select app.current_designer_id()));

create policy availability_slots_delete on public.availability_slots
  for delete to authenticated
  using ((select app.is_admin()) or designer_id = (select app.current_designer_id()));

-- -----------------------------------------------------------------------------
-- documents — project participants; customers only see rows flagged
-- customer_visible, and may upload their own photos.
-- -----------------------------------------------------------------------------

create policy documents_select on public.documents
  for select to authenticated
  using (
    app.can_access_project(project_id)
    and ((select app.current_user_role()) <> 'customer' or customer_visible)
  );

create policy documents_insert on public.documents
  for insert to authenticated
  with check (
    app.can_access_project(project_id)
    and (
      (select app.current_user_role()) in ('admin', 'designer', 'dealer')
      or ((select app.current_user_role()) = 'customer' and kind = 'photo' and customer_visible)
    )
    and uploaded_by = (select auth.uid())
  );

create policy documents_update on public.documents
  for update to authenticated
  using (app.is_project_staff(project_id) or uploaded_by = (select auth.uid()))
  with check (app.is_project_staff(project_id) or uploaded_by = (select auth.uid()));

create policy documents_delete on public.documents
  for delete to authenticated
  using ((select app.is_admin()) or uploaded_by = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- designs / design_assets — customers only see approved versions.
-- -----------------------------------------------------------------------------

create policy designs_select on public.designs
  for select to authenticated
  using (
    app.can_access_project(project_id)
    and ((select app.current_user_role()) <> 'customer' or status = 'approved')
  );

create policy designs_insert_staff on public.designs
  for insert to authenticated
  with check (app.is_project_staff(project_id));

create policy designs_update_staff on public.designs
  for update to authenticated
  using (app.is_project_staff(project_id))
  with check (app.is_project_staff(project_id));

create policy designs_delete_admin on public.designs
  for delete to authenticated
  using ((select app.is_admin()));

create policy design_assets_select on public.design_assets
  for select to authenticated
  using (
    exists (
      select 1 from public.designs d
      where d.id = design_id
        and app.can_access_project(d.project_id)
        and ((select app.current_user_role()) <> 'customer' or d.status = 'approved')
    )
  );

create policy design_assets_write_staff on public.design_assets
  for all to authenticated
  using (
    exists (select 1 from public.designs d
            where d.id = design_id and app.is_project_staff(d.project_id))
  )
  with check (
    exists (select 1 from public.designs d
            where d.id = design_id and app.is_project_staff(d.project_id))
  );

-- -----------------------------------------------------------------------------
-- site_surveys — staff and the dealer coordinate surveys.
-- -----------------------------------------------------------------------------

create policy site_surveys_select on public.site_surveys
  for select to authenticated
  using (app.can_access_project(project_id));

create policy site_surveys_insert on public.site_surveys
  for insert to authenticated
  with check (
    app.can_access_project(project_id)
    and (select app.current_user_role()) in ('admin', 'designer', 'dealer')
  );

create policy site_surveys_update on public.site_surveys
  for update to authenticated
  using (
    app.can_access_project(project_id)
    and (select app.current_user_role()) in ('admin', 'designer', 'dealer')
  )
  with check (
    app.can_access_project(project_id)
    and (select app.current_user_role()) in ('admin', 'designer', 'dealer')
  );

create policy site_surveys_delete_admin on public.site_surveys
  for delete to authenticated
  using ((select app.is_admin()));

-- -----------------------------------------------------------------------------
-- project_adders — pricing internals: staff + dealer (their book) + finance.
-- Customers see contract impacts through change_orders, not raw adders.
-- -----------------------------------------------------------------------------

create policy project_adders_select on public.project_adders
  for select to authenticated
  using (
    (select app.current_user_role()) = 'finance'
    or (
      app.can_access_project(project_id)
      and (select app.current_user_role()) in ('admin', 'designer', 'dealer')
    )
  );

create policy project_adders_insert_staff on public.project_adders
  for insert to authenticated
  with check (app.is_project_staff(project_id));

create policy project_adders_update_staff on public.project_adders
  for update to authenticated
  using (app.is_project_staff(project_id))
  with check (app.is_project_staff(project_id));

create policy project_adders_delete_staff on public.project_adders
  for delete to authenticated
  using (app.is_project_staff(project_id));

-- -----------------------------------------------------------------------------
-- change_orders — customers sign them, so project participants see them;
-- finance reads all of them.
-- -----------------------------------------------------------------------------

create policy change_orders_select on public.change_orders
  for select to authenticated
  using (
    (select app.current_user_role()) = 'finance'
    or app.can_access_project(project_id)
  );

create policy change_orders_insert on public.change_orders
  for insert to authenticated
  with check (
    app.is_project_staff(project_id)
    or (
      app.can_access_project(project_id)
      and (select app.current_user_role()) = 'dealer'
    )
  );

create policy change_orders_update on public.change_orders
  for update to authenticated
  using (
    app.is_project_staff(project_id)
    or (app.can_access_project(project_id) and (select app.current_user_role()) = 'dealer')
  )
  with check (
    app.is_project_staff(project_id)
    or (app.can_access_project(project_id) and (select app.current_user_role()) = 'dealer')
  );

create policy change_orders_delete_admin on public.change_orders
  for delete to authenticated
  using ((select app.is_admin()));

-- -----------------------------------------------------------------------------
-- vendor_quotes — procurement internals: staff of the project + finance.
-- Quotes not tied to a project are admin/finance only.
-- -----------------------------------------------------------------------------

create policy vendor_quotes_select on public.vendor_quotes
  for select to authenticated
  using (
    (select app.current_user_role()) in ('admin', 'finance')
    or (project_id is not null and app.is_project_staff(project_id))
  );

create policy vendor_quotes_write_staff_i on public.vendor_quotes
  for insert to authenticated
  with check ((select app.is_admin()) or (project_id is not null and app.is_project_staff(project_id)));

create policy vendor_quotes_write_staff_u on public.vendor_quotes
  for update to authenticated
  using ((select app.is_admin()) or (project_id is not null and app.is_project_staff(project_id)))
  with check ((select app.is_admin()) or (project_id is not null and app.is_project_staff(project_id)));

create policy vendor_quotes_delete_admin on public.vendor_quotes
  for delete to authenticated
  using ((select app.is_admin()));

-- -----------------------------------------------------------------------------
-- bom_items — unit costs: staff + finance only.
-- -----------------------------------------------------------------------------

create policy bom_items_select on public.bom_items
  for select to authenticated
  using (
    (select app.current_user_role()) = 'finance'
    or app.is_project_staff(project_id)
  );

create policy bom_items_write_staff_i on public.bom_items
  for insert to authenticated
  with check (app.is_project_staff(project_id));

create policy bom_items_write_staff_u on public.bom_items
  for update to authenticated
  using (app.is_project_staff(project_id))
  with check (app.is_project_staff(project_id));

create policy bom_items_write_staff_d on public.bom_items
  for delete to authenticated
  using (app.is_project_staff(project_id));

-- -----------------------------------------------------------------------------
-- permits / permit_events — status visible to all project participants,
-- writes by staff.
-- -----------------------------------------------------------------------------

create policy permits_select on public.permits
  for select to authenticated
  using (app.can_access_project(project_id));

create policy permits_write_staff_i on public.permits
  for insert to authenticated
  with check (app.is_project_staff(project_id));

create policy permits_write_staff_u on public.permits
  for update to authenticated
  using (app.is_project_staff(project_id))
  with check (app.is_project_staff(project_id));

create policy permits_delete_admin on public.permits
  for delete to authenticated
  using ((select app.is_admin()));

create policy permit_events_select on public.permit_events
  for select to authenticated
  using (
    exists (select 1 from public.permits pm
            where pm.id = permit_id and app.can_access_project(pm.project_id))
  );

create policy permit_events_insert_staff on public.permit_events
  for insert to authenticated
  with check (
    exists (select 1 from public.permits pm
            where pm.id = permit_id and app.is_project_staff(pm.project_id))
  );

create policy permit_events_write_admin_u on public.permit_events
  for update to authenticated
  using ((select app.is_admin()))
  with check ((select app.is_admin()));

create policy permit_events_write_admin_d on public.permit_events
  for delete to authenticated
  using ((select app.is_admin()));

-- -----------------------------------------------------------------------------
-- stage_feedback — any project participant may leave feedback on their own
-- behalf; staff and the author can read it.
-- -----------------------------------------------------------------------------

create policy stage_feedback_select on public.stage_feedback
  for select to authenticated
  using (
    app.is_project_staff(project_id)
    or created_by = (select auth.uid())
  );

create policy stage_feedback_insert on public.stage_feedback
  for insert to authenticated
  with check (
    app.can_access_project(project_id)
    and created_by = (select auth.uid())
  );

create policy stage_feedback_write_admin_u on public.stage_feedback
  for update to authenticated
  using ((select app.is_admin()))
  with check ((select app.is_admin()));

create policy stage_feedback_write_admin_d on public.stage_feedback
  for delete to authenticated
  using ((select app.is_admin()));

-- -----------------------------------------------------------------------------
-- exceptions — internal work queue: admins, the project's designer, and
-- whoever the exception is assigned to.
-- -----------------------------------------------------------------------------

create policy exceptions_select on public.exceptions
  for select to authenticated
  using (
    (select app.is_admin())
    or assigned_to = (select auth.uid())
    or (project_id is not null and app.is_project_staff(project_id))
  );

create policy exceptions_insert_staff on public.exceptions
  for insert to authenticated
  with check (
    (select app.is_admin())
    or (project_id is not null and app.is_project_staff(project_id))
  );

create policy exceptions_update on public.exceptions
  for update to authenticated
  using (
    (select app.is_admin())
    or assigned_to = (select auth.uid())
    or (project_id is not null and app.is_project_staff(project_id))
  )
  with check (
    (select app.is_admin())
    or assigned_to = (select auth.uid())
    or (project_id is not null and app.is_project_staff(project_id))
  );

create policy exceptions_delete_admin on public.exceptions
  for delete to authenticated
  using ((select app.is_admin()));

-- -----------------------------------------------------------------------------
-- audit_log — admins read; nobody writes directly (see 000500).
-- -----------------------------------------------------------------------------

create policy audit_log_select_admin on public.audit_log
  for select to authenticated
  using ((select app.is_admin()));
