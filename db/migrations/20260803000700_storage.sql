-- =============================================================================
-- 000700 — Storage: private buckets for DWG / PDF deliverables / photos
-- =============================================================================
-- All three buckets are PRIVATE (public = false): every download goes through
-- a signed URL (src/lib/storage.ts) or an authenticated storage request that
-- these storage.objects policies authorize.
--
-- Object naming convention (enforced by the policies via
-- app.storage_object_project): '<project_id>/<...anything...>'. Uploads whose
-- key doesn't start with a project UUID the caller can access are rejected.
--
--   project-dwg          — CAD sources; staff-only (internal work product)
--   project-deliverables — customer-facing PDFs (plan sets, contracts)
--   project-photos       — site/survey photos; customers may upload their own

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('project-dwg', 'project-dwg', false, 104857600, null),
  ('project-deliverables', 'project-deliverables', false, 52428800,
   array['application/pdf']),
  ('project-photos', 'project-photos', false, 26214400,
   array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- project-dwg — staff only, read and write.
-- -----------------------------------------------------------------------------

create policy dwg_select_staff on storage.objects
  for select to authenticated
  using (
    bucket_id = 'project-dwg'
    and app.is_project_staff(app.storage_object_project(name))
  );

create policy dwg_insert_staff on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'project-dwg'
    and app.is_project_staff(app.storage_object_project(name))
  );

create policy dwg_update_staff on storage.objects
  for update to authenticated
  using (
    bucket_id = 'project-dwg'
    and app.is_project_staff(app.storage_object_project(name))
  );

create policy dwg_delete_staff on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'project-dwg'
    and app.is_project_staff(app.storage_object_project(name))
  );

-- -----------------------------------------------------------------------------
-- project-deliverables — staff write; every project participant (incl. the
-- customer) can read.
-- -----------------------------------------------------------------------------

create policy deliverables_select_participants on storage.objects
  for select to authenticated
  using (
    bucket_id = 'project-deliverables'
    and app.can_access_project(app.storage_object_project(name))
  );

create policy deliverables_insert_staff on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'project-deliverables'
    and app.is_project_staff(app.storage_object_project(name))
  );

create policy deliverables_update_staff on storage.objects
  for update to authenticated
  using (
    bucket_id = 'project-deliverables'
    and app.is_project_staff(app.storage_object_project(name))
  );

create policy deliverables_delete_staff on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'project-deliverables'
    and app.is_project_staff(app.storage_object_project(name))
  );

-- -----------------------------------------------------------------------------
-- project-photos — any project participant can read and upload; deletes by
-- staff or the uploader.
-- -----------------------------------------------------------------------------

create policy photos_select_participants on storage.objects
  for select to authenticated
  using (
    bucket_id = 'project-photos'
    and app.can_access_project(app.storage_object_project(name))
  );

create policy photos_insert_participants on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'project-photos'
    and app.can_access_project(app.storage_object_project(name))
  );

create policy photos_update_staff_or_owner on storage.objects
  for update to authenticated
  using (
    bucket_id = 'project-photos'
    and (app.is_project_staff(app.storage_object_project(name))
         or owner = (select auth.uid()))
  );

create policy photos_delete_staff_or_owner on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'project-photos'
    and (app.is_project_staff(app.storage_object_project(name))
         or owner = (select auth.uid()))
  );
