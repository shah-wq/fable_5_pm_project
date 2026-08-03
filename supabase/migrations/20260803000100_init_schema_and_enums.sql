-- =============================================================================
-- 000100 — Init: app schema, enums, generic helpers
-- =============================================================================
-- Everything role/permission related lives behind helper functions in the
-- `app` schema so that RLS policies stay one-liners and the logic is defined
-- in exactly one place. `app` is NOT exposed through PostgREST (only `public`
-- is in config.toml), so these are internal building blocks.

create schema if not exists app;

grant usage on schema app to authenticated;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

-- §2 roles. One role per user, stored on public.profiles and mirrored into the
-- JWT as the `user_role` claim by public.custom_access_token_hook (000400).
create type public.user_role as enum (
  'admin',
  'designer',
  'customer',
  'dealer',
  'finance'
);

create type public.project_stage as enum (
  'intake',
  'site_survey',
  'design',
  'design_review',
  'engineering',
  'permitting',
  'permit_approved',
  'installation',
  'inspection',
  'pto',
  'complete'
);

create type public.project_status as enum (
  'active',
  'on_hold',
  'cancelled',
  'complete'
);

create type public.design_status as enum (
  'draft',
  'in_review',
  'approved',
  'rejected',
  'superseded'
);

create type public.permit_status as enum (
  'not_started',
  'preparing',
  'submitted',
  'in_review',
  'revisions_required',
  'approved',
  'rejected',
  'expired'
);

create type public.change_order_status as enum (
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'void'
);

create type public.vendor_quote_status as enum (
  'requested',
  'received',
  'accepted',
  'declined',
  'expired'
);

create type public.exception_status as enum (
  'open',
  'acknowledged',
  'in_progress',
  'resolved',
  'dismissed'
);

create type public.exception_severity as enum (
  'low',
  'medium',
  'high',
  'critical'
);

create type public.slot_status as enum (
  'open',
  'held',
  'booked',
  'cancelled'
);

create type public.document_kind as enum (
  'dwg',
  'pdf',
  'photo',
  'contract',
  'permit_doc',
  'other'
);

-- -----------------------------------------------------------------------------
-- Generic helpers (no table dependencies)
-- -----------------------------------------------------------------------------

-- Keep updated_at honest on every table that has one.
create or replace function app.tg_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
