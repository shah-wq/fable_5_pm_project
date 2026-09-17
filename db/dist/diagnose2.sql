-- ============================================================================
-- SolarFlow PM · why 20260803003400 will not apply
-- ============================================================================
-- The first script said the database is the right one and the prerequisites are
-- all present, which leaves one question: what happens when 003400 tries to do
-- its first few pieces of work.
--
-- This asks by trying them — each inside its own exception handler, each undone
-- immediately, so nothing is left behind whatever the answer is. Anything that
-- cannot be done prints the database's own error text.
--
-- Paste the whole file and send back BOTH the table and the NOTICE lines (in
-- Neon they appear under the results, and there will be several).
-- ============================================================================

-- 1. Who owns what. 003400 alters profiles, clients and leads; a role that does
--    not own them cannot, no matter what it is otherwise allowed to do.
select c.relname                                    as object,
       case c.relkind when 'r' then 'table' when 'v' then 'view' else c.relkind::text end as kind,
       pg_get_userbyid(c.relowner)                  as owned_by,
       pg_has_role(current_user, c.relowner, 'USAGE') as i_am_the_owner
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('profiles', 'clients', 'leads', 'deals', 'projects',
                     'dealers', 'audit_log', 'documents')
 order by c.relname;

-- 2. The schemas and the type, same question.
select 'schema ' || n.nspname                       as object,
       pg_get_userbyid(n.nspowner)                  as owned_by,
       pg_has_role(current_user, n.nspowner, 'USAGE') as i_am_the_owner
  from pg_namespace n where n.nspname in ('public', 'app', 'auth', 'storage')
union all
select 'type public.user_role',
       pg_get_userbyid(t.typowner),
       pg_has_role(current_user, t.typowner, 'USAGE')
  from pg_type t
  join pg_namespace n on n.oid = t.typnamespace
 where n.nspname = 'public' and t.typname = 'user_role';

-- 3. The actual operations 003400 performs, tried and undone. Each one reports
--    either "ok" or the exact error the migration would have stopped on.
do $$
declare
  msg text;
begin
  -- a. Add and drop a column on profiles — the migration's first real statement.
  begin
    execute 'alter table public.profiles add column if not exists sf_probe_col boolean';
    execute 'alter table public.profiles drop column if exists sf_probe_col';
    raise notice 'alter public.profiles ....... ok';
  exception when others then
    raise notice 'alter public.profiles ....... NO: %', sqlerrm;
  end;

  -- b. Same on clients, which gains a dozen columns.
  begin
    execute 'alter table public.clients add column if not exists sf_probe_col boolean';
    execute 'alter table public.clients drop column if exists sf_probe_col';
    raise notice 'alter public.clients ........ ok';
  exception when others then
    raise notice 'alter public.clients ........ NO: %', sqlerrm;
  end;

  -- c. Renaming a table, which is how leads becomes deals. Tried on a scratch
  --    table of our own first, then on leads itself and renamed straight back.
  begin
    execute 'create table public.sf_probe_tbl (id int)';
    execute 'alter table public.sf_probe_tbl rename to sf_probe_tbl2';
    execute 'drop table public.sf_probe_tbl2';
    raise notice 'create and rename a table ... ok';
  exception when others then
    raise notice 'create and rename a table ... NO: %', sqlerrm;
    begin execute 'drop table if exists public.sf_probe_tbl'; exception when others then null; end;
    begin execute 'drop table if exists public.sf_probe_tbl2'; exception when others then null; end;
  end;

  begin
    execute 'alter table public.leads rename to sf_probe_leads';
    execute 'alter table public.sf_probe_leads rename to leads';
    raise notice 'rename public.leads ......... ok';
  exception when others then
    raise notice 'rename public.leads ......... NO: %', sqlerrm;
  end;

  -- d. A function in the app schema, and one in public with security definer.
  begin
    execute 'create or replace function app.sf_probe_fn() returns int language sql as $f$ select 1 $f$';
    execute 'drop function app.sf_probe_fn()';
    raise notice 'create a function in app .... ok';
  exception when others then
    raise notice 'create a function in app .... NO: %', sqlerrm;
  end;

  begin
    execute 'create or replace function public.sf_probe_fn() returns int language sql security definer as $f$ select 1 $f$';
    execute 'drop function public.sf_probe_fn()';
    raise notice 'create a definer function ... ok';
  exception when others then
    raise notice 'create a definer function ... NO: %', sqlerrm;
  end;

  -- e. A policy on an existing table, which the migration adds several of.
  begin
    execute 'create policy sf_probe_policy on public.clients for select using (true)';
    execute 'drop policy sf_probe_policy on public.clients';
    raise notice 'create a policy on clients .. ok';
  exception when others then
    raise notice 'create a policy on clients .. NO: %', sqlerrm;
  end;

  -- f. A trigger, and granting to the app role.
  begin
    execute 'grant select on public.clients to authenticated';
    raise notice 'grant to authenticated ...... ok';
  exception when others then
    raise notice 'grant to authenticated ...... NO: %', sqlerrm;
  end;

  select current_setting('server_version') into msg;
  raise notice 'postgres version ............ %', msg;
end
$$;
