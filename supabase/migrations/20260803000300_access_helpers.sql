-- =============================================================================
-- 000300 — Access helpers used by every RLS policy (000600, 000700)
-- =============================================================================
-- All are SECURITY DEFINER with an empty search_path: they read the tables
-- they need as the owner, which keeps policy evaluation free of RLS recursion
-- (e.g. the clients policy can reference projects without re-entering the
-- projects policy).

-- Resolve the caller's §2 role. Prefers the `user_role` JWT claim (stamped by
-- public.custom_access_token_hook, 000400); falls back to profiles for
-- sessions minted before the hook ran.
create or replace function app.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when (select auth.jwt() ->> 'user_role')
         in ('admin', 'designer', 'customer', 'dealer', 'finance')
      then ((select auth.jwt() ->> 'user_role'))::public.user_role
    else (select p.role from public.profiles p where p.id = (select auth.uid()))
  end;
$$;

create or replace function app.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.current_user_role() = 'admin';
$$;

-- The designers.id of the calling user, if any.
create or replace function app.current_designer_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.id from public.designers d where d.user_id = (select auth.uid());
$$;

-- Every dealer org the calling user belongs to.
create or replace function app.current_dealer_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select du.dealer_id from public.dealer_users du where du.user_id = (select auth.uid());
$$;

-- Every client record linked to the calling user's login.
create or replace function app.current_client_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id from public.clients c where c.user_id = (select auth.uid());
$$;

-- §2 project visibility: admin → all; designer → their queue; dealer → their
-- book; customer → their own project. Finance is deliberately absent — it
-- reads the whitelisted columns via public.project_financials (000400), never
-- project rows directly.
create or replace function app.can_access_project(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.projects p
    where p.id = pid
      and (
        app.current_user_role() = 'admin'
        or p.assigned_designer_id = app.current_designer_id()
        or p.dealer_id in (select app.current_dealer_ids())
        or p.client_id in (select app.current_client_ids())
      )
  );
$$;

-- Staff on a project = admin or its assigned designer. Gate for internal
-- tables (BOM, vendor quotes, exceptions) and for writes.
create or replace function app.is_project_staff(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.current_user_role() = 'admin'
      or exists (
           select 1
           from public.projects p
           where p.id = pid
             and p.assigned_designer_id = app.current_designer_id()
         );
$$;

-- Storage objects are keyed as '<project_id>/...'; extract the project id
-- from an object name, null when the prefix isn't a UUID.
create or replace function app.storage_object_project(object_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when object_name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
      then left(object_name, 36)::uuid
  end;
$$;

grant execute on all functions in schema app to authenticated;
