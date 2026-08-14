-- =============================================================================
-- 002000 — Dealer companies (admin record, commission defaults, guarded delete)
-- =============================================================================
-- Implements the "Dealer companies" spec: the company record grows identity /
-- commercial / portal-behaviour fields, names are unique case-insensitively
-- (catch 'SunPro Energy LLC' vs 'sunpro energy llc ' at creation, not later),
-- and every change is audited. Deletion stays restricted at the database
-- level: projects.dealer_id and leads.dealer_id have plain (NO ACTION)
-- foreign keys, so a referenced company cannot be deleted by any code path.

alter table public.dealers
  add column if not exists primary_contact_name    text,
  add column if not exists primary_contact_email   text,
  add column if not exists company_address         text,
  add column if not exists tax_id                  text,
  add column if not exists default_commission_basis text
    check (default_commission_basis in
           ('percentage_of_contract', 'fixed_per_project', 'per_watt', 'manual')),
  add column if not exists default_commission_rate numeric(12,4)
    check (default_commission_rate >= 0),
  add column if not exists payment_terms           text,
  add column if not exists notification_recipients text,
  add column if not exists notes                   text;

-- Case-insensitive, trimmed uniqueness on the company name.
create unique index if not exists dealers_name_ci_key
  on public.dealers (lower(trim(name)));

-- Every field change on a company is written to the activity log.
drop trigger if exists audit_row on public.dealers;
create trigger audit_row after insert or update or delete on public.dealers
  for each row execute function app.tg_audit_row();

-- Commission prefill from the dealer's defaults — forward-only: it fires at
-- project creation, so changing a dealer's defaults later never restates
-- money already promised on existing projects. Definer rights because the
-- commissions table is otherwise admin-write-only.
create or replace function app.tg_seed_commission_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_basis text;
  v_rate  numeric;
  v_base  numeric;
begin
  select d.default_commission_basis, d.default_commission_rate
    into v_basis, v_rate
  from public.dealers d
  where d.id = new.dealer_id;

  if v_basis is null or v_rate is null or v_basis = 'manual' then
    return new;
  end if;

  v_base := case v_basis
    when 'percentage_of_contract' then round(v_rate * new.contract_value / 100.0, 2)
    when 'fixed_per_project'      then round(v_rate, 2)
    when 'per_watt'               then round(v_rate * new.system_size_kw * 1000, 2)
  end;
  if v_base is null then
    return new;
  end if;

  insert into public.commissions (project_id, base_amount, status, notes)
  values (new.id, v_base, 'pending',
          'Prefilled from dealer default (' || v_basis || ' @ ' || v_rate || ')')
  on conflict (project_id) do nothing;
  return new;
end;
$$;

drop trigger if exists seed_commission_defaults on public.projects;
create trigger seed_commission_defaults after insert on public.projects
  for each row execute function app.tg_seed_commission_defaults();
