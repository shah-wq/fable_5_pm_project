-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · newest module · step 11 of 16 · 20260803004300_stage_upload_fix.sql
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
--   12. 20260803004400-esignature.sql
--   13. 20260803004500-sales-see-dealer-names.sql
--   14. 20260803004600-stage-fields-solar.sql
--   15. 20260803004700-notifications.sql
--   16. 20260803004800-ai-automation.sql
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

