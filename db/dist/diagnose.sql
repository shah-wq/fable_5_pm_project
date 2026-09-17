-- ============================================================================
-- SolarFlow PM · what is actually in this database
-- ============================================================================
-- Paste the whole of this into the SQL editor and run it. It changes nothing —
-- every line is a question. Send the result back.
--
-- It answers the three things that cannot be worked out from the outside:
--   · which database the editor is pointed at (a paste that lands in the wrong
--     one looks exactly like a paste that did nothing),
--   · whether the objects the CRM migration needs are present before it runs,
--   · whether the objects it creates are present after it has run.
-- ============================================================================

select
  -- Where this paste is going. If this is not the database the app's
  -- DATABASE_URL names, nothing pasted here will ever reach the app.
  current_database()                                          as database,
  current_user                                                as running_as,

  -- What 003400 needs before it will do anything.
  coalesce(to_regclass('public.clients')::text, 'MISSING')    as needs_clients,
  coalesce(to_regclass('public.leads')::text, 'MISSING')      as needs_leads,
  (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'user_role' and e.enumlabel = 'sales')  as needs_sales_role,

  -- What it creates. deals is the one every later file asks for.
  coalesce(to_regclass('public.deals')::text, 'MISSING')          as makes_deals,
  coalesce(to_regclass('public.client_channels')::text, 'MISSING') as makes_channels,
  coalesce(to_regclass('public.client_sources')::text, 'MISSING')  as makes_sources,

  -- And the three files after it.
  coalesce(to_regprocedure('public.convert_deal_to_project(uuid,public.project_stage)')::text,
           'MISSING')                                         as makes_conversion,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'clients'
      and column_name = 'mailing_street')                     as makes_intake_fields,
  coalesce(to_regprocedure('public.create_contact(jsonb,jsonb)')::text, 'MISSING')
                                                              as makes_create_contact;

-- Is public.leads a table (which 003400 renames) or already a view (which means
-- it has been renamed once already)? Nothing here means neither exists.
select c.relname,
       case c.relkind when 'r' then 'table' when 'v' then 'view' else c.relkind::text end as kind
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname in ('leads', 'deals');

-- What the bookkeeping table has recorded, if this database keeps one. A pasted
-- file does not write to it, so it lags the real state — a hint, not the answer.
do $$
declare v text;
begin
  if to_regclass('public.schema_migrations') is null then
    raise notice 'schema_migrations: not present — fine, only `npm run db:migrate` creates it';
  else
    execute 'select string_agg(name, '', '') from (
               select name from public.schema_migrations order by name desc limit 8) t'
      into v;
    raise notice 'last recorded migrations: %', v;
  end if;
end
$$;
