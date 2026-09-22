-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · newest module · step 11 of 11 · 20260803004300_stage_upload_fix.sql
--
-- For a database that is already up to date apart from this module. Paste the
-- whole file into a SQL console (e.g. the Neon SQL Editor) and run it once.
-- Safe to run again: every statement skips work already done, so 'already
-- exists' errors cannot happen. NOTICE lines saying 'does not exist, skipping'
-- are normal.
--
-- Run these in order, each as its own execution:
--   1. 20260803003300-add-sales-role.sql
--   2. 20260803003400-crm-foundation.sql
--   3. 20260803003500-deals.sql
--   4. 20260803003600-contact-intake.sql
--   5. 20260803003700-contact-create.sql
--   6. 20260803003800-contact-stages.sql
--   7. 20260803003900-contract-signed-system.sql
--   8. 20260803004000-project-holds-contact.sql
--   9. 20260803004100-signing-creates-project.sql
--   10. 20260803004200-sales-see-deal-projects.sql
--   11. 20260803004300-stage-upload-fix.sql
-- Each break is where one script adds something the next one uses, which
-- PostgreSQL will not allow inside a single pasted transaction.
--
-- Behind by more than this module? Run every db/dist/catch-up-*.sql in order
-- instead — they cover everything from 001400 onwards.
-- ============================================================================

-- >>> 20260803004300_stage_upload_fix.sql
-- =============================================================================
-- Stage-form uploads work again
-- =============================================================================
-- public.record_staff_upload — the function behind every file on a stage form
-- (install pictures, shading reports, and now each stage's attachments) —
-- wrote the document's kind as a CASE of two string literals. PostgreSQL types
-- that CASE as text, and documents.kind is the enum public.document_kind, so
-- every upload failed:
--
--   column "kind" is of type public.document_kind but expression is of type text
--
-- The same slip was fixed for deal documents in 003500. This replaces the
-- function with the cast in place; nothing else about it changes. Added as a
-- new file rather than an edit to 001400, because a database that already has
-- 001400 would never see an edit.
-- =============================================================================

create or replace function public.record_staff_upload(
  p_project_id uuid,
  p_category   text,
  p_filename   text,
  p_mime       text,
  p_data       bytea
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
begin
  if not app.is_project_staff(p_project_id) then
    raise exception 'only project staff may upload' using errcode = '42501';
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
  v_path := p_project_id || '/uploads/' || p_category || '/'
            || floor(extract(epoch from clock_timestamp()) * 1000)::bigint || '-' || v_name;

  insert into storage.objects (bucket_id, name, owner)
  values (case when p_mime = 'application/pdf' then 'project-deliverables' else 'project-photos' end,
          v_path, auth.uid())
  returning id into v_object_id;

  insert into storage.object_data (object_id, data) values (v_object_id, p_data);

  insert into public.documents
    (project_id, bucket, object_path, kind, category, title, mime_type, size_bytes,
     customer_visible, uploaded_by)
  values
    (p_project_id,
     case when p_mime = 'application/pdf' then 'project-deliverables' else 'project-photos' end,
     v_path,
     (case when p_mime = 'application/pdf' then 'pdf' else 'photo' end)::public.document_kind,
     btrim(p_category), p_filename, p_mime, octet_length(p_data), false, auth.uid())
  returning id into v_document_id;

  perform app.write_audit('document.uploaded', 'documents', v_document_id::text, p_project_id,
    null, null, jsonb_build_object('category', p_category, 'filename', p_filename));

  return v_document_id;
end;
$$;

revoke execute on function public.record_staff_upload(uuid, text, text, text, bytea) from public, anon;
grant execute on function public.record_staff_upload(uuid, text, text, text, bytea) to authenticated;


-- >>> migration bookkeeping (lets `npm run db:migrate` skip these later)
create table if not exists public.schema_migrations (
  name       text primary key,
  applied_at timestamptz not null default now()
);
insert into public.schema_migrations (name) values
  ('20260803000000_platform.sql'),
  ('20260803000100_init_schema_and_enums.sql'),
  ('20260803000200_tables.sql'),
  ('20260803000300_access_helpers.sql'),
  ('20260803000400_hooks_and_views.sql'),
  ('20260803000500_audit.sql'),
  ('20260803000600_rls_policies.sql'),
  ('20260803000700_storage.sql'),
  ('20260803000800_add_ops_role.sql'),
  ('20260803000900_auth_module.sql'),
  ('20260803001000_auth_engine.sql'),
  ('20260803001100_file_storage.sql'),
  ('20260803001200_manual_version.sql'),
  ('20260803001300_admin_panel.sql'),
  ('20260803001400_stage_fields.sql'),
  ('20260803001500_complete_hold_cancel.sql'),
  ('20260803001600_complete_stage_backfill.sql'),
  ('20260803001700_project_details.sql'),
  ('20260803001800_equipment_quantities.sql'),
  ('20260803001900_dealer_portal.sql'),
  ('20260803002000_dealer_companies.sql'),
  ('20260803002100_restore_project_defaults.sql'),
  ('20260803002200_report_builder.sql'),
  ('20260803002300_customer_portal.sql'),
  ('20260803002400_customer_management.sql'),
  ('20260803002500_mobile_app.sql'),
  ('20260803002600_customer_passwords.sql'),
  ('20260803002700_invite_customers_with_tokens.sql'),
  ('20260803002800_dashboard.sql'),
  ('20260803002900_project_chat.sql'),
  ('20260803003000_sign_in.sql'),
  ('20260803003100_typical_durations.sql'),
  ('20260803003200_stage_feedback.sql'),
  ('20260803003300_add_sales_role.sql'),
  ('20260803003400_crm_foundation.sql'),
  ('20260803003500_deals.sql'),
  ('20260803003600_contact_intake.sql'),
  ('20260803003700_contact_create.sql'),
  ('20260803003800_contact_stages.sql'),
  ('20260803003900_contract_signed_system.sql'),
  ('20260803004000_project_holds_contact.sql'),
  ('20260803004100_signing_creates_project.sql'),
  ('20260803004200_sales_see_deal_projects.sql'),
  ('20260803004300_stage_upload_fix.sql')
on conflict (name) do nothing;
