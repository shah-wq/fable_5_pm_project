-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with:
--   node scripts/split-migration.mjs 20260803003400_crm_foundation.sql 12
--
--   20260803003400_crm_foundation.sql · part 5 of 12
--
-- The same migration, cut into pieces small enough for a browser SQL console.
-- Run the parts in order, each as its own execution, and stop at the first one
-- that reports an error — that error is the thing worth sending on.
--
-- Safe to run again: every statement skips work already done.
-- ============================================================================


create table if not exists public.sf_migration_parts (
  part       text primary key,
  applied_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from public.sf_migration_parts where part = '20260803003400-crm-foundation-part4') then
    raise exception 'Part 4 has not been applied to this database — run 20260803003400-crm-foundation-part4-of-12.sql first.'
      using hint = 'If you believe you did run it, it did not finish: nothing it created is here. Run it again and read what the console says about it, because that message is the thing that has been missing all along.';
  end if;
end
$$;


-- A deal needs a human-readable handle for the same reason a project has one.
update public.deals set code = 'DEA-' || upper(substr(replace(id::text, '-', ''), 1, 8))
 where code is null;
alter table public.deals alter column code set default
  ('DEA-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)));
create unique index if not exists deals_code_idx on public.deals (code);

-- The migrated rows: "set every migrated row to stage New or Qualified depending
-- on its existing state". The old status vocabulary was submitted / under_review
-- / converted / declined.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'deals' and column_name = 'status') then
    update public.deals
       set stage = case status
                     when 'submitted'     then 'new'
                     when 'under_review'  then 'qualified'
                     when 'converted'     then 'won'
                     when 'declined'      then 'lost'
                     else 'new'
                   end
     where stage = 'new';
    update public.deals set project_id = converted_project_id
     where converted_project_id is not null and project_id is null;
    update public.deals set won_at = coalesce(won_at, updated_at) where stage = 'won';
    update public.deals set lost_at = coalesce(lost_at, updated_at) where stage = 'lost';
  end if;
end
$$;

-- Attribution: the dealer company and submitting user "are kept and become the
-- permanent attribution fields" (Part 2). dealer_id is nullable now because a
-- deal can also arrive from a web form with no dealer at all.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'deals'
                and column_name = 'dealer_id' and is_nullable = 'NO') then
    alter table public.deals alter column dealer_id drop not null;
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'deals'
                and column_name = 'address' and is_nullable = 'NO') then
    alter table public.deals alter column address drop not null;
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'deals'
                and column_name = 'customer_first' and is_nullable = 'NO') then
    alter table public.deals alter column customer_first drop not null;
    alter table public.deals alter column customer_last drop not null;
  end if;
end
$$;

-- The rename carries the old table's constraints, and one of them is now wrong.
-- `leads` required an email or a phone *on the row*, because a lead was a
-- standalone scrap of contact detail. A deal's person is the clients record, and
-- the channel lives there — so the rule becomes "reachable somehow": a linked
-- person, or a direct channel for a submission that has not been matched yet.
do $$
declare
  c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.deals'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%customer_email%'
  loop
    execute format('alter table public.deals drop constraint %I', c.conname);
  end loop;

  if not exists (select 1 from pg_constraint where conname = 'deals_reachable') then
    alter table public.deals
      add constraint deals_reachable
      check (client_id is not null
             or customer_email is not null
             or customer_phone is not null);
  end if;
end
$$;

create index if not exists deals_stage_idx on public.deals (stage, stage_entered_at desc);create index if not exists deals_owner_idx on public.deals (owner_id, stage);
create index if not exists deals_client_idx on public.deals (client_id);
create index if not exists deals_next_action_idx on public.deals (next_action_at)
  where stage not in ('won', 'lost');

-- Recorded so the next part can tell that this one finished.
insert into public.sf_migration_parts (part) values ('20260803003400-crm-foundation-part5')
  on conflict (part) do nothing;
