-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with:
--   node scripts/split-migration.mjs 20260803003400_crm_foundation.sql 12
--
--   20260803003400_crm_foundation.sql · part 7 of 12
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
  if not exists (select 1 from public.sf_migration_parts where part = '20260803003400-crm-foundation-part6') then
    raise exception 'Part 6 has not been applied to this database — run 20260803003400-crm-foundation-part6-of-12.sql first.'
      using hint = 'If you believe you did run it, it did not finish: nothing it created is here. Run it again and read what the console says about it, because that message is the thing that has been missing all along.';
  end if;
end
$$;

create index if not exists subscriptions_list_idx on public.subscriptions (list_id, status);

-- "Hard bounces, complaints, unsubscribes and manual suppressions in one set
-- that every send checks, marketing and transactional alike."
create table if not exists public.suppression (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null default 'email' check (kind in ('email', 'phone')),
  value_normalised text not null,
  reason           text not null
    check (reason in ('unsubscribed', 'hard_bounce', 'complaint', 'manual', 'sunset', 'deleted')),
  notes            text,
  created_by       uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (kind, value_normalised)
);

-- -----------------------------------------------------------------------------
-- 8. Lifecycle, derived (Part 2)
-- -----------------------------------------------------------------------------
/**
 * "Prospect if no project, customer if any live project, past customer if all
 * projects are complete or cancelled."
 *
 * A function rather than a column, and a view over it rather than a join every
 * caller writes by hand.
 */
create or replace function public.client_lifecycle(p_client uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not exists (select 1 from public.projects p where p.client_id = p_client)
      then 'prospect'
    when exists (select 1 from public.projects p
                  where p.client_id = p_client
                    and p.status not in ('complete', 'cancelled'))
      then 'customer'
    else 'past_customer'
  end;
$$;

-- security_invoker so the reader's own RLS on clients decides which rows they
-- see — the view adds the roll-ups, never access.
create or replace view public.people_overview
with (security_invoker = true) as
select c.id,
       c.first_name,
       c.last_name,
       coalesce(c.preferred_name, c.first_name) as display_first,
       c.email,
       c.phone,
       c.dealer_id,
       c.owner_id,
       c.source_id,
       c.is_archived,
       c.created_at,
       c.last_activity_at,
       c.last_contacted_at,
       public.client_lifecycle(c.id) as lifecycle,
       (select count(*) from public.projects p where p.client_id = c.id) as project_count,
       (select count(*) from public.deals d where d.client_id = c.id) as deal_count,
       (select count(*) from public.deals d
         where d.client_id = c.id and d.stage not in ('won', 'lost')) as open_deal_count,
       (select count(*) from public.subscriptions s
         where s.client_id = c.id and s.status = 'subscribed') as subscription_count,
       c.do_not_email,
       c.do_not_call,
       c.do_not_sms
  from public.clients c;

grant select on public.people_overview to authenticated;

-- -----------------------------------------------------------------------------
-- 9. RLS — "new policies, same model" (Part 3)
-- -----------------------------------------------------------------------------
alter table public.client_channels enable row level security;
alter table public.client_addresses enable row level security;
alter table public.deal_contacts enable row level security;
alter table public.proposals enable row level security;
alter table public.subscriptions enable row level security;

-- Recorded so the next part can tell that this one finished.
insert into public.sf_migration_parts (part) values ('20260803003400-crm-foundation-part7')
  on conflict (part) do nothing;
