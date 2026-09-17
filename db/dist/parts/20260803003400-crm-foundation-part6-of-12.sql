-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with:
--   node scripts/split-migration.mjs 20260803003400_crm_foundation.sql 12
--
--   20260803003400_crm_foundation.sql · part 6 of 12
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
  if not exists (select 1 from public.sf_migration_parts where part = '20260803003400-crm-foundation-part5') then
    raise exception 'Part 5 has not been applied to this database — run 20260803003400-crm-foundation-part5-of-12.sql first.'
      using hint = 'If you believe you did run it, it did not finish: nothing it created is here. Run it again and read what the console says about it, because that message is the thing that has been missing all along.';
  end if;
end
$$;


-- The compatibility view: anything still saying `leads` keeps working for one
-- release. Read-only on purpose — a write path that still targets the old name
-- is a bug to find now, not to paper over.
do $$
begin
  if to_regclass('public.leads') is not null
     and (select relkind from pg_class where oid = to_regclass('public.leads')) = 'r' then
    -- The rename above did not happen (a database that already had deals), so
    -- leave the real table alone rather than shadowing it.
    return;
  end if;
  execute 'create or replace view public.leads as select * from public.deals';
  execute 'grant select on public.leads to authenticated';
end
$$;

-- -----------------------------------------------------------------------------
-- 6. Part 10 step 5 — the activity log gains two columns and a kind
-- -----------------------------------------------------------------------------
-- "One log renders the project audit trail, the customer Activity tab and the
-- deal timeline. A separate CRM would hold half of a person's history in a table
-- the project side cannot see."
alter table public.audit_log
  add column if not exists kind text not null default 'field_change'
    check (kind in ('call', 'email', 'sms', 'meeting', 'note', 'form', 'download',
                    'login', 'system', 'field_change', 'stage_move')),
  add column if not exists deal_id   uuid,
  add column if not exists client_id uuid;

create index if not exists audit_log_deal_idx on public.audit_log (deal_id, occurred_at desc);
create index if not exists audit_log_client_idx on public.audit_log (client_id, occurred_at desc);

-- -----------------------------------------------------------------------------
-- 7. The genuinely new tables (Part 2)
-- -----------------------------------------------------------------------------
create table if not exists public.deal_contacts (
  id        uuid primary key default gen_random_uuid(),
  deal_id   uuid not null references public.deals (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  /** "Most residential deals involve two people" (Part 5). */
  role      text not null default 'primary'
    check (role in ('primary', 'co_owner', 'decision_maker', 'referrer', 'dealer_rep')),
  created_at timestamptz not null default now(),
  unique (deal_id, client_id, role)
);
create index if not exists deal_contacts_client_idx on public.deal_contacts (client_id);

create table if not exists public.proposals (
  id            uuid primary key default gen_random_uuid(),
  deal_id       uuid not null references public.deals (id) on delete cascade,
  /** Versioned rows, not overwrites: "What did we quote them in March?" */
  version       integer not null,
  document_id   uuid references public.documents (id) on delete set null,
  sent_at       timestamptz,
  viewed_at     timestamptz,
  gross_price   numeric(12,2),
  incentives    numeric(12,2),
  net_price     numeric(12,2),
  monthly_payment numeric(10,2),
  notes         text,
  superseded_by_id uuid references public.proposals (id) on delete set null,
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (deal_id, version)
);

create table if not exists public.lists (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique,
  description    text,
  /** Double opt-in is on by default and configurable per list (Part 7). */
  double_optin   boolean not null default true,
  /** Sunset policy: months of no engagement before re-permission. */
  sunset_months  integer not null default 12,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.lead_magnets (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  version      text,
  list_id      uuid references public.lists (id) on delete set null,
  document_id  uuid references public.documents (id) on delete set null,
  download_count integer not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients (id) on delete cascade,
  list_id         uuid not null references public.lists (id) on delete cascade,
  lead_magnet_id  uuid references public.lead_magnets (id) on delete set null,
  status          text not null default 'pending'
    check (status in ('pending', 'subscribed', 'unsubscribed', 'bounced',
                      'complained', 'suppressed')),
  -- "Recorded at the moment of consent because it cannot be assembled
  -- afterwards. This is the record produced if someone complains."
  consent_basis   text not null default 'consent'
    check (consent_basis in ('consent', 'legitimate_interest', 'contract', 'imported')),
  consent_at      timestamptz not null default now(),
  consent_source  text,
  consent_ip      inet,
  consent_statement_text text,
  double_optin_confirmed_at timestamptz,
  confirm_token_hash text,
  unsubscribed_at timestamptz,
  sends           integer not null default 0,
  opens           integer not null default 0,
  clicks          integer not null default 0,
  last_engaged_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (client_id, list_id)
);

-- Recorded so the next part can tell that this one finished.
insert into public.sf_migration_parts (part) values ('20260803003400-crm-foundation-part6')
  on conflict (part) do nothing;
