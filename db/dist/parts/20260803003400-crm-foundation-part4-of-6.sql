-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with:
--   node scripts/split-migration.mjs 20260803003400_crm_foundation.sql 6
--
--   20260803003400_crm_foundation.sql · part 4 of 6
--
-- The same migration, cut into pieces small enough for a browser SQL console.
-- Run the parts in order, each as its own execution, and stop at the first one
-- that reports an error — that error is the thing worth sending on.
--
-- Safe to run again: every statement skips work already done.
-- ============================================================================


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
alter table public.lists enable row level security;
alter table public.lead_magnets enable row level security;
alter table public.suppression enable row level security;
alter table public.client_sources enable row level security;
alter table public.deal_loss_reasons enable row level security;
alter table public.dealer_tiers enable row level security;
alter table public.competitors enable row level security;
alter table public.roof_types enable row level security;

grant select, insert, update, delete on
  public.client_channels, public.client_addresses, public.deal_contacts,
  public.proposals, public.subscriptions, public.lists, public.lead_magnets,
  public.suppression
to authenticated;
grant select on
  public.client_sources, public.deal_loss_reasons, public.dealer_tiers,
  public.competitors, public.roof_types
to authenticated;
