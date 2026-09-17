-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with:
--   node scripts/split-migration.mjs 20260803003400_crm_foundation.sql 12
--
--   20260803003400_crm_foundation.sql · part 8 of 12
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
  if not exists (select 1 from public.sf_migration_parts where part = '20260803003400-crm-foundation-part7') then
    raise exception 'Part 7 has not been applied to this database — run 20260803003400-crm-foundation-part7-of-12.sql first.'
      using hint = 'If you believe you did run it, it did not finish: nothing it created is here. Run it again and read what the console says about it, because that message is the thing that has been missing all along.';
  end if;
end
$$;

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

-- Recorded so the next part can tell that this one finished.
insert into public.sf_migration_parts (part) values ('20260803003400-crm-foundation-part8')
  on conflict (part) do nothing;
