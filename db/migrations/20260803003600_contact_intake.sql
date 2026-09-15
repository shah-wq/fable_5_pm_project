-- =============================================================================
-- Modules 16–19 · the contact intake fields
-- =============================================================================
-- The fields a rep fills in on a contact: identity and mailing on the person,
-- and the solar/commercial detail on the deal.
--
-- Why the split rather than putting all fifty on clients: a person can have two
-- properties and two deals, and "System size" then has two answers. The person
-- record holds what is true about the person; the deal holds what is true about
-- one opportunity. The Contacts screen shows both together against the deal
-- being worked, which is what the request actually asks for — one screen with
-- every field on it.
--
-- Everything here is additive and nullable. Nothing is required, because an
-- intake form that refuses to save half-known information is a form people keep
-- in a spreadsheet instead.
-- =============================================================================

do $$
begin
  if to_regclass('public.deals') is null then
    raise exception 'Run 20260803003400_crm_foundation.sql first — it creates deals.';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 1. The person
-- -----------------------------------------------------------------------------
alter table public.clients
  -- Contact owner and lead source already exist (owner_id, source_id).
  add column if not exists created_by       uuid references public.profiles (id) on delete set null,
  /** Free text about the person, distinct from internal_notes: this one is the
      description a rep writes, not the PM's private note. */
  add column if not exists description      text,
  /** The property owner's number, when the contact is not the owner — a spouse,
      an adult child, a landlord. Kept apart from phone so neither overwrites
      the other during a merge. */
  add column if not exists owner_phone      text,
  -- Mailing address, in the parts a mail merge needs. clients.mailing_address
  -- stays as the single-line legacy value and is kept in step by the trigger
  -- below, so anything already reading it keeps working.
  add column if not exists mailing_street   text,
  add column if not exists mailing_city     text,
  add column if not exists mailing_state    text,
  add column if not exists mailing_postal_code text,
  add column if not exists mailing_country  text;

/**
 * One address, two shapes. The parts are what the form edits; the single line is
 * what every existing query and export already reads.
 */
create or replace function app.tg_client_mailing_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line text;
begin
  if new.mailing_street is distinct from old.mailing_street
     or new.mailing_city is distinct from old.mailing_city
     or new.mailing_state is distinct from old.mailing_state
     or new.mailing_postal_code is distinct from old.mailing_postal_code
     or new.mailing_country is distinct from old.mailing_country
     or old.id is null then
    v_line := nullif(
      btrim(concat_ws(', ',
        nullif(btrim(coalesce(new.mailing_street, '')), ''),
        nullif(btrim(coalesce(new.mailing_city, '')), ''),
        nullif(btrim(coalesce(new.mailing_state, '')), ''),
        nullif(btrim(coalesce(new.mailing_postal_code, '')), ''),
        nullif(btrim(coalesce(new.mailing_country, '')), ''))),
      '');
    if v_line is not null then
      new.mailing_address := v_line;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists client_mailing_line on public.clients;
create trigger client_mailing_line before insert or update on public.clients
  for each row execute function app.tg_client_mailing_line();

-- Created-by is filled going forward; existing rows keep a null rather than a
-- guess, because a wrong attribution is worse than an absent one.
create or replace function app.tg_client_created_by()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.created_by is null then
    new.created_by := (select auth.uid());
  end if;
  return new;
end;
$$;

drop trigger if exists client_created_by on public.clients;
create trigger client_created_by before insert on public.clients
  for each row execute function app.tg_client_created_by();

-- -----------------------------------------------------------------------------
-- 2. The deal — system, documents-adjacent detail, and the money
-- -----------------------------------------------------------------------------
alter table public.deals
  -- System. Brand columns already exist as references to the admin lists
  -- (module_id, inverter_id, battery_id); these are the numbers beside them.
  add column if not exists module_quantity      integer check (module_quantity >= 0),
  add column if not exists module_wattage       integer check (module_wattage >= 0),
  add column if not exists inverter_size_kw     numeric(8,3),
  add column if not exists battery_size_kwh     numeric(8,2),
  add column if not exists includes_battery     boolean,
  add column if not exists mount_type           text
    check (mount_type in ('rooftop', 'ground', 'both')),
  /** Yes / no / unknown rather than a boolean: "we have not asked yet" is the
      commonest answer at this stage and it is not the same as no. */
  add column if not exists hoa                  text
    check (hoa in ('yes', 'no', 'unknown')),
  add column if not exists comparable_brand_ok  boolean,

  -- Money. gross_price is the system price; the rest is how it is being paid.
  add column if not exists down_payment         numeric(12,2),
  add column if not exists amount_financed      numeric(12,2),

  -- Attribution and notes.
  add column if not exists dealer_code          text,
  add column if not exists wave_sales_notes     text,
  add column if not exists additional_information text,
  add column if not exists reschedule_reason    text;

/**
 * "System includes battery?" answers itself when a quantity is known, and is
 * only asked when it is not. Kept in the database so the answer is the same in
 * a report as it is on the screen.
 */
create or replace function app.tg_deal_battery_flag()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.battery_qty is not null and new.battery_qty > 0 then
    new.includes_battery := true;
  elsif new.battery_qty = 0 then
    new.includes_battery := false;
  end if;
  return new;
end;
$$;

drop trigger if exists deal_battery_flag on public.deals;
create trigger deal_battery_flag before insert or update on public.deals
  for each row execute function app.tg_deal_battery_flag();

-- -----------------------------------------------------------------------------
-- 3. The intake documents
-- -----------------------------------------------------------------------------
-- Categories are text on public.documents, so these need no schema change —
-- but they do need to exist as a list somewhere the application and a human can
-- both read, and this is the file that introduces them:
--
--   solar_proposal              Updated solar proposal
--   electricity_bill_front      Updated electricity bill (front)
--   electricity_bill_back       Updated electricity bill (back)
--   electric_bill               Electric bill
--   signed_installation_agreement  Updated signed solar installation agreement
--   electrical_panel            Updated electrical panel
--   electrical_meter            Updated electrical meter
--   dealer_code_form            Dealer code form
--
-- They attach to a deal (documents.deal_id, added in 003500) and gain the
-- project relation on conversion, so nothing is re-uploaded after a sale.
-- Every one of them defaults to customer_visible = false, like every other
-- document in the product.

create index if not exists documents_deal_category_idx
  on public.documents (deal_id, category) where deal_id is not null;

/**
 * Filing one of them. The deal twin of record_staff_upload(): same buckets,
 * same size and type rules, same hidden-by-default visibility — the only
 * difference is which column the document hangs off, because there is no
 * project yet.
 */
create or replace function public.record_deal_document(
  p_deal     uuid,
  p_category text,
  p_filename text,
  p_mime     text,
  p_data     bytea
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_path text;
  v_object_id uuid;
  v_document_id uuid;
  v_bucket text;
begin
  if not app.is_sales_staff() then
    raise exception 'only the sales team may file documents on a deal' using errcode = '42501';
  end if;
  if not exists (select 1 from public.deals d where d.id = p_deal) then
    raise exception 'that deal no longer exists' using errcode = 'P0002';
  end if;
  if p_category is null or btrim(p_category) = '' then
    raise exception 'category is required';
  end if;
  if p_mime not in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
                    'application/pdf') then
    raise exception 'only photos and PDFs are accepted';
  end if;
  if p_data is null or octet_length(p_data) = 0 or octet_length(p_data) > 26214400 then
    raise exception 'file must be between 1 byte and 25 MB';
  end if;

  v_name := coalesce(nullif(regexp_replace(coalesce(p_filename, ''), '[^\w.\-]+', '_', 'g'), ''), 'file');
  v_name := right(v_name, 100);
  v_path := 'deal/' || p_deal || '/' || p_category || '/'
            || floor(extract(epoch from clock_timestamp()) * 1000)::bigint || '-' || v_name;
  v_bucket := case when p_mime = 'application/pdf' then 'project-deliverables' else 'project-photos' end;

  insert into storage.objects (bucket_id, name, owner)
  values (v_bucket, v_path, (select auth.uid()))
  returning id into v_object_id;

  insert into storage.object_data (object_id, data) values (v_object_id, p_data);

  insert into public.documents
    (deal_id, bucket, object_path, kind, category, title, mime_type, size_bytes,
     customer_visible, uploaded_by)
  values
    (p_deal, v_bucket, v_path,
     (case when p_mime = 'application/pdf' then 'pdf' else 'photo' end)::public.document_kind,
     btrim(p_category), p_filename, p_mime, octet_length(p_data), false, (select auth.uid()))
  returning id into v_document_id;

  perform public.log_audit_event(
    'document.uploaded', 'documents', v_document_id::text, null,
    jsonb_build_object('category', p_category, 'filename', p_filename),
    'form', p_deal, (select client_id from public.deals where id = p_deal));

  return v_document_id;
end;
$$;

revoke execute on function public.record_deal_document(uuid, text, text, text, bytea)
  from public, anon;
grant execute on function public.record_deal_document(uuid, text, text, text, bytea)
  to authenticated;

-- -----------------------------------------------------------------------------
-- 4. One row per contact for the screen and the report builder
-- -----------------------------------------------------------------------------
/**
 * The person, plus the deal a rep is most likely to mean: the newest open one,
 * falling back to the newest of any kind. A contact with two live deals is
 * ambiguous by nature, so the screen lets them switch — this view is what it
 * opens on, and what a report reads when it asks for "the contact's system
 * size" without naming a deal.
 */
create or replace view public.contact_intake
with (security_invoker = true) as
select c.id as client_id,
       c.first_name, c.last_name, c.email, c.phone, c.owner_phone,
       c.mailing_street, c.mailing_city, c.mailing_state,
       c.mailing_postal_code, c.mailing_country, c.description,
       coalesce(owner.full_name, owner.email) as contact_owner,
       coalesce(creator.full_name, creator.email) as created_by_name,
       src.name as lead_source,
       dl.name as dealer_name,
       d.id as deal_id, d.code as deal_code, d.stage as lead_status,
       d.system_size_kw, d.module_quantity, d.module_wattage,
       d.battery_qty, d.battery_size_kwh, d.includes_battery,
       d.inverter_size_kw, d.mount_type, d.hoa, d.comparable_brand_ok,
       d.annual_usage_kwh, d.production_estimate_kwh, d.avg_monthly_bill,
       d.gross_price, d.contract_value, d.down_payment, d.amount_financed,
       d.financing_route, d.dealer_code, d.wave_sales_notes,
       d.additional_information, d.reschedule_reason,
       mod.name as module_brand, inv.name as inverter_brand, bat.name as battery_brand,
       fin.name as financing_company, u.name as electric_utility,
       lr.name as lost_reason
  from public.clients c
  left join public.profiles owner on owner.id = c.owner_id
  left join public.profiles creator on creator.id = c.created_by
  left join public.client_sources src on src.id = c.source_id
  left join public.dealers dl on dl.id = c.dealer_id
  left join lateral (
    select * from public.deals dd
     where dd.client_id = c.id
     order by (dd.stage not in ('won', 'lost')) desc, dd.updated_at desc
     limit 1
  ) d on true
  left join public.module_types mod on mod.id = d.module_id
  left join public.inverter_types inv on inv.id = d.inverter_id
  left join public.battery_types bat on bat.id = d.battery_id
  left join public.financing_companies fin on fin.id = d.financing_company_id
  left join public.utilities u on u.id = d.utility_id
  left join public.deal_loss_reasons lr on lr.id = d.lost_reason_id;

grant select on public.contact_intake to authenticated;
