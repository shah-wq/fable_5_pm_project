-- =============================================================================
-- 001100 — File bytes in Postgres (replaces Supabase Storage)
-- =============================================================================
-- Object metadata stays in storage.objects (the 000700 bucket policies keep
-- governing it); the bytes live beside it in storage.object_data. The app
-- never touches the blob table directly — uploads and downloads go through
-- the two definer functions below, which enforce the same §2 access rules as
-- the storage policies. Blob-in-database is the right call at this product's
-- volume (site photos, plan PDFs); if that ever changes, the metadata layer
-- is already shaped for an S3-style backend.

create table storage.object_data (
  object_id  uuid primary key references storage.objects (id) on delete cascade,
  data       bytea not null,
  created_at timestamptz not null default now()
);

-- No grants: SECURITY DEFINER access only.

-- ---------------------------------------------------------------------------
-- No-login grant uploads (REQ-SEC-01). Validates the token (expiry,
-- revocation), stores the photo, registers the documents row, audits.
-- Returns the document id, or null when the link is dead (route → 410).
-- ---------------------------------------------------------------------------

create or replace function public.record_grant_upload(
  p_token    text,
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
  v_grant record;
  v_name text;
  v_path text;
  v_object_id uuid;
  v_document_id uuid;
begin
  select * into v_grant from public.validate_upload_grant(p_token) limit 1;
  if v_grant.grant_id is null then
    return null;
  end if;

  if p_mime not in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif') then
    raise exception 'only photos are accepted on this link';
  end if;
  if p_data is null or octet_length(p_data) = 0 or octet_length(p_data) > 26214400 then
    raise exception 'file must be between 1 byte and 25 MB';
  end if;

  v_name := coalesce(nullif(regexp_replace(coalesce(p_filename, ''), '[^\w.\-]+', '_', 'g'), ''), 'photo');
  v_name := right(v_name, 100);
  v_path := v_grant.project_id || '/grant-uploads/' || v_grant.grant_id || '/'
            || floor(extract(epoch from clock_timestamp()) * 1000)::bigint || '-' || v_name;

  insert into storage.objects (bucket_id, name)
  values ('project-photos', v_path)
  returning id into v_object_id;

  insert into storage.object_data (object_id, data) values (v_object_id, p_data);

  insert into public.documents
    (project_id, bucket, object_path, kind, title, mime_type, size_bytes,
     customer_visible, uploaded_by)
  values
    (v_grant.project_id, 'project-photos', v_path, 'photo', p_filename, p_mime,
     octet_length(p_data),
     v_grant.purpose = 'customer_delivery',   -- delivery photos surface on the portal
     null)
  returning id into v_document_id;

  perform app.write_audit(
    'document.uploaded_via_grant', 'documents', v_document_id::text, v_grant.project_id,
    null, null,
    jsonb_build_object(
      'grant_id', v_grant.grant_id,
      'purpose', v_grant.purpose,
      'filename', p_filename,
      'size_bytes', octet_length(p_data)));

  return v_document_id;
end;
$$;

revoke execute on function public.record_grant_upload(text, text, text, bytea) from public;
grant execute on function public.record_grant_upload(text, text, text, bytea) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Authenticated downloads. Mirrors the documents/storage read rules:
-- project participants only, customers only see customer_visible rows, and
-- DWG bytes stay staff-only. Empty result = not found OR not allowed.
-- ---------------------------------------------------------------------------

create or replace function public.read_document(p_document_id uuid)
returns table (
  title      text,
  mime_type  text,
  size_bytes bigint,
  data       bytea
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents%rowtype;
begin
  select d.* into v_doc from public.documents d where d.id = p_document_id;
  if not found then
    return;
  end if;

  if not app.can_access_project(v_doc.project_id) then
    return;
  end if;
  if app.current_user_role() = 'customer' and not v_doc.customer_visible then
    return;
  end if;
  if v_doc.bucket = 'project-dwg' and not app.is_project_staff(v_doc.project_id) then
    return;
  end if;

  return query
    select v_doc.title, v_doc.mime_type, v_doc.size_bytes, od.data
    from storage.objects o
    join storage.object_data od on od.object_id = o.id
    where o.bucket_id = v_doc.bucket and o.name = v_doc.object_path;
end;
$$;

revoke execute on function public.read_document(uuid) from public, anon;
grant execute on function public.read_document(uuid) to authenticated;
