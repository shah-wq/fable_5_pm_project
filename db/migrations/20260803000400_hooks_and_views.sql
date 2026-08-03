-- =============================================================================
-- 000400 — User lifecycle, JWT claim hook, stage-history trigger, finance view
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Profile bootstrap: every auth user gets a profiles row. Role can be
-- pre-assigned by an admin/service via raw_app_meta_data.user_role (app
-- metadata is not user-editable); everyone else starts as 'customer'.
-- -----------------------------------------------------------------------------

create or replace function app.tg_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.user_role;
begin
  v_role := case
    when new.raw_app_meta_data ->> 'user_role'
         in ('admin', 'designer', 'customer', 'dealer', 'finance')
      then (new.raw_app_meta_data ->> 'user_role')::public.user_role
    else 'customer'::public.user_role
  end;

  insert into public.profiles (id, role, email, full_name)
  values (new.id, v_role, new.email, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.tg_handle_new_user();

-- Only admins (or service-role / server-side SQL) may change a profile's role.
create or replace function app.tg_guard_profile_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role is distinct from old.role
     and (select auth.uid()) is not null                          -- SQL / migration context is exempt
     and coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
     and not app.is_admin()
  then
    raise exception 'only admins may change a profile role'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger guard_profile_role
  before update on public.profiles
  for each row execute function app.tg_guard_profile_role();

-- -----------------------------------------------------------------------------
-- Stage history: any change to projects.stage writes a project_stage_events
-- row, no matter which module made the change.
-- -----------------------------------------------------------------------------

create or replace function app.tg_project_stage_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.stage is distinct from old.stage then
    insert into public.project_stage_events (project_id, from_stage, to_stage, changed_by)
    values (new.id, old.stage, new.stage, (select auth.uid()));
  end if;
  return new;
end;
$$;

create trigger on_project_stage_change
  after update on public.projects
  for each row execute function app.tg_project_stage_change();

-- -----------------------------------------------------------------------------
-- Finance surface: the §2 whitelisted-columns view. The finance role has no
-- SELECT policy on public.projects at all — this view (owned by postgres, so
-- it bypasses the base table's RLS) is its only window, and its WHERE clause
-- restricts it to finance and admin callers. No PII / site / design columns.
-- -----------------------------------------------------------------------------

create view public.project_financials
with (security_barrier = true, security_invoker = false)
as
select
  p.id,
  p.code,
  p.name,
  p.stage,
  p.status,
  p.dealer_id,
  p.client_id,
  p.system_size_kw,
  p.contract_value,
  p.dealer_fee,
  p.amount_invoiced,
  p.amount_paid,
  p.target_install_date,
  p.created_at,
  p.updated_at
from public.projects p
where app.current_user_role() in ('finance', 'admin');

grant select on public.project_financials to authenticated;
