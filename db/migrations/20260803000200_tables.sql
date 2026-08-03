-- =============================================================================
-- 000200 — All tables (§3), incl. AI-era tables created now so phase two needs
-- zero schema migration. RLS is enabled in 000600; audit triggers in 000500.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Identity & orgs
-- -----------------------------------------------------------------------------

-- One row per auth user. Created automatically by app.tg_handle_new_user()
-- (000400). `role` is the single source of truth for §2 authorization; it is
-- carried in the per-request claims (`user_role`) by the session layer.
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  role        public.user_role not null default 'customer',
  full_name   text,
  email       text,
  phone       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger set_updated_at before update on public.profiles
  for each row execute function app.tg_set_updated_at();

-- Dealer organizations. A dealer's "book" = every client/project whose
-- dealer_id points here.
create table public.dealers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  code        text unique,
  email       text,
  phone       text,
  address     jsonb not null default '{}'::jsonb,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger set_updated_at before update on public.dealers
  for each row execute function app.tg_set_updated_at();

-- Membership of auth users in a dealer org (a dealer org can have several
-- logins). A user with role 'dealer' sees exactly the books of the dealers
-- they belong to.
create table public.dealer_users (
  dealer_id   uuid not null references public.dealers (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  is_owner    boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (dealer_id, user_id)
);

create index dealer_users_user_id_idx on public.dealer_users (user_id);

-- Design staff. Separate from profiles so capacity/skill data doesn't live on
-- the identity row and so a designer can exist before their login does.
create table public.designers (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid unique references public.profiles (id) on delete set null,
  display_name            text not null,
  skills                  text[] not null default '{}',
  max_concurrent_projects integer not null default 10,
  timezone                text not null default 'UTC',
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create trigger set_updated_at before update on public.designers
  for each row execute function app.tg_set_updated_at();

-- Homeowners. `user_id` is set once the customer activates their portal login.
create table public.clients (
  id          uuid primary key default gen_random_uuid(),
  dealer_id   uuid not null references public.dealers (id),
  user_id     uuid unique references public.profiles (id) on delete set null,
  first_name  text not null,
  last_name   text not null,
  email       text,
  phone       text,
  address     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index clients_dealer_id_idx on public.clients (dealer_id);

create trigger set_updated_at before update on public.clients
  for each row execute function app.tg_set_updated_at();

-- -----------------------------------------------------------------------------
-- Reference data
-- -----------------------------------------------------------------------------

-- Authorities Having Jurisdiction (permitting offices).
create table public.jurisdictions (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null,
  state                   text not null,
  county                  text,
  ahj_code                text,
  requirements            jsonb not null default '{}'::jsonb,
  typical_turnaround_days integer,
  contact                 jsonb not null default '{}'::jsonb,
  notes                   text,
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create unique index jurisdictions_state_name_idx on public.jurisdictions (state, name);

create trigger set_updated_at before update on public.jurisdictions
  for each row execute function app.tg_set_updated_at();

create table public.utilities (
  id                           uuid primary key default gen_random_uuid(),
  name                         text not null,
  state                        text not null,
  interconnection_requirements jsonb not null default '{}'::jsonb,
  is_active                    boolean not null default true,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

create trigger set_updated_at before update on public.utilities
  for each row execute function app.tg_set_updated_at();

-- Catalog of parts/services with cost & price. AI-era table (quoting/BOM
-- automation) — created now, written manually until phase two.
create table public.price_book (
  id             uuid primary key default gen_random_uuid(),
  sku            text not null unique,
  name           text not null,
  category       text,
  description    text,
  manufacturer   text,
  unit           text not null default 'each',
  unit_cost      numeric(12,2),
  unit_price     numeric(12,2),
  effective_from date,
  effective_to   date,
  is_active      boolean not null default true,
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger set_updated_at before update on public.price_book
  for each row execute function app.tg_set_updated_at();

-- Rules that add line-item charges when a condition matches (e.g. metal roof,
-- main panel upgrade). `condition` is a JSON predicate evaluated by the app.
create table public.adder_rules (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  condition   jsonb not null default '{}'::jsonb,
  amount      numeric(12,2) not null,
  amount_type text not null default 'flat' check (amount_type in ('flat', 'per_watt', 'percent')),
  priority    integer not null default 100,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger set_updated_at before update on public.adder_rules
  for each row execute function app.tg_set_updated_at();

create table public.vendors (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  contact    jsonb not null default '{}'::jsonb,
  categories text[] not null default '{}',
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at before update on public.vendors
  for each row execute function app.tg_set_updated_at();

-- -----------------------------------------------------------------------------
-- Projects & pipeline
-- -----------------------------------------------------------------------------

create table public.projects (
  id                   uuid primary key default gen_random_uuid(),
  code                 text not null unique default ('PRJ-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
  name                 text not null,
  dealer_id            uuid not null references public.dealers (id),
  client_id            uuid not null references public.clients (id),
  jurisdiction_id      uuid references public.jurisdictions (id),
  utility_id           uuid references public.utilities (id),
  assigned_designer_id uuid references public.designers (id),
  stage                public.project_stage not null default 'intake',
  status               public.project_status not null default 'active',
  priority             integer not null default 0,
  system_size_kw       numeric(8,3),
  panel_count          integer,
  site_address         jsonb not null default '{}'::jsonb,
  -- Financial columns below are the finance-role whitelist surface; the
  -- finance role reads them through public.project_financials (000400).
  contract_value       numeric(12,2),
  dealer_fee           numeric(12,2),
  amount_invoiced      numeric(12,2) not null default 0,
  amount_paid          numeric(12,2) not null default 0,
  target_install_date  date,
  metadata             jsonb not null default '{}'::jsonb,
  created_by           uuid references public.profiles (id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index projects_dealer_id_idx on public.projects (dealer_id);
create index projects_client_id_idx on public.projects (client_id);
create index projects_assigned_designer_id_idx on public.projects (assigned_designer_id);
create index projects_jurisdiction_id_idx on public.projects (jurisdiction_id);
create index projects_stage_idx on public.projects (stage);

create trigger set_updated_at before update on public.projects
  for each row execute function app.tg_set_updated_at();

-- Stage history. Written automatically by app.tg_project_stage_change()
-- (000400) whenever projects.stage changes; manual inserts allowed for staff.
create table public.project_stage_events (
  id         bigint generated always as identity primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  from_stage public.project_stage,
  to_stage   public.project_stage not null,
  changed_by uuid references public.profiles (id),
  changed_at timestamptz not null default now(),
  notes      text
);

create index project_stage_events_project_id_idx on public.project_stage_events (project_id, changed_at desc);

-- Designer scheduling. AI-era table (automated survey/review booking) —
-- created now so phase two needs no migration. Open slots are readable by all
-- authenticated users so booking flows can offer them.
create table public.availability_slots (
  id          uuid primary key default gen_random_uuid(),
  designer_id uuid not null references public.designers (id) on delete cascade,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  status      public.slot_status not null default 'open',
  slot_type   text not null default 'design_review',
  project_id  uuid references public.projects (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index availability_slots_designer_id_idx on public.availability_slots (designer_id, starts_at);
create index availability_slots_status_idx on public.availability_slots (status) where status = 'open';

create trigger set_updated_at before update on public.availability_slots
  for each row execute function app.tg_set_updated_at();

-- -----------------------------------------------------------------------------
-- Files
-- -----------------------------------------------------------------------------

-- Registry row for every object in the storage buckets (000700). The object
-- itself lives in storage; this row carries project scoping and the
-- customer_visible flag that storage policies and the UI both key off.
create table public.documents (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id) on delete cascade,
  bucket           text not null,
  object_path      text not null,
  kind             public.document_kind not null default 'other',
  title            text,
  customer_visible boolean not null default false,
  mime_type        text,
  size_bytes       bigint,
  uploaded_by      uuid references public.profiles (id),
  created_at       timestamptz not null default now(),
  unique (bucket, object_path)
);

create index documents_project_id_idx on public.documents (project_id);

-- -----------------------------------------------------------------------------
-- Design
-- -----------------------------------------------------------------------------

create table public.designs (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id) on delete cascade,
  version        integer not null default 1,
  status         public.design_status not null default 'draft',
  designer_id    uuid references public.designers (id),
  layout         jsonb not null default '{}'::jsonb,
  system_size_kw numeric(8,3),
  panel_count    integer,
  inverter_model text,
  notes          text,
  submitted_at   timestamptz,
  approved_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (project_id, version)
);

create index designs_project_id_idx on public.designs (project_id);

create trigger set_updated_at before update on public.designs
  for each row execute function app.tg_set_updated_at();

-- Links a design version to its files (DWG, stamped PDF, ...).
create table public.design_assets (
  id          uuid primary key default gen_random_uuid(),
  design_id   uuid not null references public.designs (id) on delete cascade,
  document_id uuid not null references public.documents (id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (design_id, document_id)
);

create index design_assets_design_id_idx on public.design_assets (design_id);

create table public.site_surveys (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  slot_id      uuid references public.availability_slots (id) on delete set null,
  scheduled_at timestamptz,
  completed_at timestamptz,
  surveyor     text,
  findings     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index site_surveys_project_id_idx on public.site_surveys (project_id);

create trigger set_updated_at before update on public.site_surveys
  for each row execute function app.tg_set_updated_at();

-- -----------------------------------------------------------------------------
-- Pricing & procurement
-- -----------------------------------------------------------------------------

-- Adders applied to a specific project (from a rule, a human, or — phase
-- two — the AI). Snapshot name/amount so rule edits don't rewrite history.
create table public.project_adders (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  adder_rule_id uuid references public.adder_rules (id),
  name          text not null,
  amount        numeric(12,2) not null,
  amount_type   text not null default 'flat' check (amount_type in ('flat', 'per_watt', 'percent')),
  source        text not null default 'manual' check (source in ('rule', 'manual', 'ai')),
  approved      boolean not null default false,
  created_by    uuid references public.profiles (id),
  created_at    timestamptz not null default now()
);

create index project_adders_project_id_idx on public.project_adders (project_id);

create table public.change_orders (
  id                          uuid primary key default gen_random_uuid(),
  project_id                  uuid not null references public.projects (id) on delete cascade,
  number                      integer not null,
  status                      public.change_order_status not null default 'draft',
  reason                      text,
  description                 text,
  amount_delta                numeric(12,2) not null default 0,
  requires_customer_signature boolean not null default true,
  document_id                 uuid references public.documents (id),
  requested_by                uuid references public.profiles (id),
  approved_by                 uuid references public.profiles (id),
  approved_at                 timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (project_id, number)
);

create index change_orders_project_id_idx on public.change_orders (project_id);

create trigger set_updated_at before update on public.change_orders
  for each row execute function app.tg_set_updated_at();

-- Vendor pricing. AI-era table (automated quote solicitation) — created now.
create table public.vendor_quotes (
  id           uuid primary key default gen_random_uuid(),
  vendor_id    uuid not null references public.vendors (id),
  project_id   uuid references public.projects (id) on delete set null,
  status       public.vendor_quote_status not null default 'requested',
  quote_number text,
  line_items   jsonb not null default '[]'::jsonb,
  total        numeric(12,2),
  valid_until  date,
  document_id  uuid references public.documents (id),
  requested_by uuid references public.profiles (id),
  received_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index vendor_quotes_vendor_id_idx on public.vendor_quotes (vendor_id);
create index vendor_quotes_project_id_idx on public.vendor_quotes (project_id);

create trigger set_updated_at before update on public.vendor_quotes
  for each row execute function app.tg_set_updated_at();

-- Bill of materials per design. project_id is denormalized from the design on
-- purpose: RLS and common queries filter by project without a join.
create table public.bom_items (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id) on delete cascade,
  design_id       uuid not null references public.designs (id) on delete cascade,
  price_book_id   uuid references public.price_book (id),
  vendor_quote_id uuid references public.vendor_quotes (id),
  sku             text,
  description     text not null,
  quantity        numeric(12,3) not null default 1 check (quantity > 0),
  unit_cost       numeric(12,2),
  unit_price      numeric(12,2),
  source          text not null default 'manual' check (source in ('manual', 'rule', 'ai')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index bom_items_project_id_idx on public.bom_items (project_id);
create index bom_items_design_id_idx on public.bom_items (design_id);

create trigger set_updated_at before update on public.bom_items
  for each row execute function app.tg_set_updated_at();

-- -----------------------------------------------------------------------------
-- Permitting
-- -----------------------------------------------------------------------------

create table public.permits (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id) on delete cascade,
  jurisdiction_id uuid not null references public.jurisdictions (id),
  permit_type     text not null default 'building',
  status          public.permit_status not null default 'not_started',
  permit_number   text,
  fees            numeric(12,2),
  submitted_at    timestamptz,
  approved_at     timestamptz,
  expires_at      timestamptz,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index permits_project_id_idx on public.permits (project_id);
create index permits_jurisdiction_id_idx on public.permits (jurisdiction_id);

create trigger set_updated_at before update on public.permits
  for each row execute function app.tg_set_updated_at();

create table public.permit_events (
  id          bigint generated always as identity primary key,
  permit_id   uuid not null references public.permits (id) on delete cascade,
  from_status public.permit_status,
  to_status   public.permit_status not null,
  actor_id    uuid references public.profiles (id),
  occurred_at timestamptz not null default now(),
  notes       text
);

create index permit_events_permit_id_idx on public.permit_events (permit_id, occurred_at desc);

-- -----------------------------------------------------------------------------
-- AI-era feedback & exception queue (created now, mostly unused in phase one)
-- -----------------------------------------------------------------------------

-- Per-stage feedback from any participant (and later, AI self-critique).
create table public.stage_feedback (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  stage      public.project_stage not null,
  rating     integer check (rating between 1 and 5),
  feedback   text,
  source     text not null default 'customer' check (source in ('customer', 'dealer', 'designer', 'ai')),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

create index stage_feedback_project_id_idx on public.stage_feedback (project_id);

-- Work queue of things a human must look at (rule conflicts, AI low
-- confidence, SLA breaches, ...).
create table public.exceptions (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid references public.projects (id) on delete cascade,
  entity_type      text,
  entity_id        text,
  severity         public.exception_severity not null default 'medium',
  status           public.exception_status not null default 'open',
  summary          text not null,
  details          jsonb not null default '{}'::jsonb,
  raised_by        text not null default 'system',
  assigned_to      uuid references public.profiles (id),
  resolved_by      uuid references public.profiles (id),
  resolved_at      timestamptz,
  resolution_notes text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index exceptions_project_id_idx on public.exceptions (project_id);
create index exceptions_status_idx on public.exceptions (status) where status in ('open', 'acknowledged', 'in_progress');
create index exceptions_assigned_to_idx on public.exceptions (assigned_to);

create trigger set_updated_at before update on public.exceptions
  for each row execute function app.tg_set_updated_at();

-- -----------------------------------------------------------------------------
-- Audit log (writer utilities in 000500)
-- -----------------------------------------------------------------------------

-- Append-only. Rows are written only through app.write_audit() (SECURITY
-- DEFINER); direct DML is revoked and update/delete is blocked by trigger.
create table public.audit_log (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id    uuid,
  actor_role  public.user_role,
  action      text not null,
  entity_type text not null,
  entity_id   text,
  project_id  uuid,
  old_data    jsonb,
  new_data    jsonb,
  context     jsonb not null default '{}'::jsonb
);

create index audit_log_project_id_idx on public.audit_log (project_id, occurred_at desc);
create index audit_log_entity_idx on public.audit_log (entity_type, entity_id);
create index audit_log_actor_id_idx on public.audit_log (actor_id, occurred_at desc);
