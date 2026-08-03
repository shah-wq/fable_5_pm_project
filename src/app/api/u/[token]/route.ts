import { NextResponse } from 'next/server';
import { BUCKETS } from '@/lib/storage';
import { createAnonClient, createServiceClient } from '@/lib/supabase/server';

const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

/**
 * Receives one file for an upload grant (REQ-SEC-01). The token is
 * re-validated on every request — a link that expired or was revoked between
 * page load and upload gets 410 — then the file lands in the private
 * project-photos bucket, a documents row records it, and the audit log gets
 * an entry. No session, no cookies: the token is the entire credential.
 */
export async function POST(request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  // Validate with the anon client: same call an unauthenticated page makes.
  const anon = createAnonClient();
  const { data: grants, error: grantError } = await anon.rpc('validate_upload_grant', {
    p_token: token,
  });
  if (grantError) {
    return NextResponse.json({ error: 'validation failed' }, { status: 500 });
  }
  const grant = grants?.[0];
  if (!grant) {
    return NextResponse.json({ error: 'link expired or revoked' }, { status: 410 });
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'no file' }, { status: 400 });
  }
  if (file.size === 0 || file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'file must be between 1 byte and 25 MB' }, { status: 413 });
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json({ error: 'only photos are accepted on this link' }, { status: 415 });
  }

  const safeName = file.name.replace(/[^\w.\-]+/g, '_').slice(-100) || 'photo';
  const objectPath = `${grant.project_id}/grant-uploads/${grant.grant_id}/${Date.now()}-${safeName}`;

  const service = createServiceClient();

  const { error: uploadError } = await service.storage
    .from(BUCKETS.photos)
    .upload(objectPath, file, { contentType: file.type });
  if (uploadError) {
    return NextResponse.json({ error: 'storage upload failed' }, { status: 502 });
  }

  const { data: doc, error: docError } = await service
    .from('documents')
    .insert({
      project_id: grant.project_id,
      bucket: BUCKETS.photos,
      object_path: objectPath,
      kind: 'photo',
      title: file.name,
      mime_type: file.type,
      size_bytes: file.size,
      // Delivery confirmations belong on the customer's portal; survey and
      // crew shots stay internal.
      customer_visible: grant.purpose === 'customer_delivery',
      uploaded_by: null,
    })
    .select('id')
    .single();
  if (docError) {
    await service.storage.from(BUCKETS.photos).remove([objectPath]);
    return NextResponse.json({ error: 'could not record the upload' }, { status: 502 });
  }

  await service.rpc('log_audit_event', {
    p_action: 'document.uploaded_via_grant',
    p_entity_type: 'documents',
    p_entity_id: doc.id,
    p_project_id: grant.project_id,
    p_context: {
      grant_id: grant.grant_id,
      purpose: grant.purpose,
      filename: file.name,
      size_bytes: file.size,
    },
  });

  return NextResponse.json({ documentId: doc.id }, { status: 201 });
}
