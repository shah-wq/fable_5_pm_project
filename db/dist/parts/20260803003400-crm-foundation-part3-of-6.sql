-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with:
--   node scripts/split-migration.mjs 20260803003400_crm_foundation.sql 6
--
--   20260803003400_crm_foundation.sql · part 3 of 6
--
-- The same migration, cut into pieces small enough for a browser SQL console.
-- Run the parts in order, each as its own execution, and stop at the first one
-- that reports an error — that error is the thing worth sending on.
--
-- Safe to run again: every statement skips work already done.
-- ============================================================================



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
