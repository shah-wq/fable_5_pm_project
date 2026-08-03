-- =============================================================================
-- 000500 — Audit log writer (the shared utility every later module calls)
-- =============================================================================
-- Three entry points, one sink:
--   * app.write_audit(...)        — SQL-side writer, callable from any
--                                    function/trigger in later migrations.
--   * app.tg_audit_row()          — generic row trigger attached to the core
--                                    business tables below; captures OLD/NEW.
--   * public.log_audit_event(...) — RPC for application code
--                                    (src/lib/audit.ts wraps it).
-- audit_log itself is append-only: direct DML is revoked in 000600 and
-- update/delete raise even for definer code via tg_audit_log_immutable.

create or replace function app.write_audit(
  p_action      text,
  p_entity_type text,
  p_entity_id   text default null,
  p_project_id  uuid default null,
  p_old_data    jsonb default null,
  p_new_data    jsonb default null,
  p_context     jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if p_action is null or btrim(p_action) = '' then
    raise exception 'audit action must not be empty';
  end if;
  if p_entity_type is null or btrim(p_entity_type) = '' then
    raise exception 'audit entity_type must not be empty';
  end if;

  insert into public.audit_log
    (actor_id, actor_role, action, entity_type, entity_id, project_id, old_data, new_data, context)
  values
    ((select auth.uid()),
     app.current_user_role(),
     btrim(p_action),
     btrim(p_entity_type),
     p_entity_id,
     p_project_id,
     p_old_data,
     p_new_data,
     coalesce(p_context, '{}'::jsonb))
  returning id into v_id;

  return v_id;
end;
$$;

-- Generic row auditor. Derives the project id from the row itself so one
-- trigger fits every table: projects use their own id, everything else its
-- project_id column (null when the table has none).
create or replace function app.tg_audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_project_id uuid;
begin
  if tg_table_name = 'projects' then
    v_project_id := (v_row ->> 'id')::uuid;
  else
    v_project_id := (v_row ->> 'project_id')::uuid;
  end if;

  perform app.write_audit(
    lower(tg_op),
    tg_table_name,
    v_row ->> 'id',
    v_project_id,
    v_old,
    v_new
  );

  return coalesce(new, old);
end;
$$;

-- Attach to the tables whose history matters for compliance/debugging.
-- (project_stage_events / permit_events are themselves history tables, and
-- audit_log auditing itself would recurse — leave those out.)
create trigger audit_row after insert or update or delete on public.projects
  for each row execute function app.tg_audit_row();
create trigger audit_row after insert or update or delete on public.clients
  for each row execute function app.tg_audit_row();
create trigger audit_row after insert or update or delete on public.designs
  for each row execute function app.tg_audit_row();
create trigger audit_row after insert or update or delete on public.change_orders
  for each row execute function app.tg_audit_row();
create trigger audit_row after insert or update or delete on public.permits
  for each row execute function app.tg_audit_row();
create trigger audit_row after insert or update or delete on public.project_adders
  for each row execute function app.tg_audit_row();
create trigger audit_row after insert or update or delete on public.bom_items
  for each row execute function app.tg_audit_row();
create trigger audit_row after insert or update or delete on public.vendor_quotes
  for each row execute function app.tg_audit_row();
create trigger audit_row after insert or update or delete on public.exceptions
  for each row execute function app.tg_audit_row();
create trigger audit_row after insert or update or delete on public.documents
  for each row execute function app.tg_audit_row();
create trigger audit_row after insert or update or delete on public.price_book
  for each row execute function app.tg_audit_row();
create trigger audit_row after insert or update or delete on public.adder_rules
  for each row execute function app.tg_audit_row();
create trigger audit_row after insert or update or delete on public.profiles
  for each row execute function app.tg_audit_row();

-- RPC for application-level events that aren't row DML ("permit packet
-- downloaded", "design shared with customer", ...). Actor identity comes from
-- the JWT inside write_audit, so callers can't spoof who did it.
create or replace function public.log_audit_event(
  p_action      text,
  p_entity_type text,
  p_entity_id   text default null,
  p_project_id  uuid default null,
  p_context     jsonb default '{}'::jsonb
)
returns bigint
language sql
security definer
set search_path = ''
as $$
  select app.write_audit(p_action, p_entity_type, p_entity_id, p_project_id, null, null, p_context);
$$;

grant execute on function public.log_audit_event(text, text, text, uuid, jsonb) to authenticated;
grant execute on function app.write_audit(text, text, text, uuid, jsonb, jsonb, jsonb) to authenticated;

-- Append-only enforcement, even for superuser-adjacent code paths.
create or replace function app.tg_audit_log_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_log is append-only'
    using errcode = '42501';
end;
$$;

create trigger audit_log_immutable
  before update or delete on public.audit_log
  for each row execute function app.tg_audit_log_immutable();
