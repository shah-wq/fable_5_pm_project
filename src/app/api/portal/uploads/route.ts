import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * A customer sends a document the PM asked for (utility bill, HOA paperwork,
 * a site photo). record_customer_upload checks in the database that the
 * uploader really is the homeowner on that project, stores the bytes beside
 * the metadata, and marks the row visible to them; a request row notifies the
 * PM so it doesn't sit unnoticed.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (session.role !== 'customer' || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  const projectId = String(form?.get('projectId') ?? '');
  const note = String(form?.get('note') ?? '').trim().slice(0, 500) || null;

  if (!UUID_RE.test(projectId)) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  }
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'choose a file to send' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'files must be 25 MB or smaller' }, { status: 400 });
  }
  const mime = file.type || 'application/octet-stream';
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'].includes(mime)) {
    return NextResponse.json({ error: 'please send a photo or a PDF' }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  try {
    const documentId = await withUser(session, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `select public.record_customer_upload($1, $2, $3, $4, $5) as id`,
        [projectId, 'customer_upload', file.name.slice(0, 200), mime, bytes]
      );
      const id = rows[0]?.id ?? null;
      if (!id) return null;

      const project = await client.query<{ client_id: string }>(
        `select client_id from public.projects where id = $1`,
        [projectId]
      );
      if (project.rows[0]) {
        await client.query(
          `insert into public.customer_requests
             (project_id, client_id, kind, message, document_id)
           values ($1, $2, 'document', $3, $4)`,
          [projectId, project.rows[0].client_id, note ?? `Sent ${file.name}`, id]
        );
      }
      return id;
    });

    if (!documentId) {
      return NextResponse.json({ error: 'could not store the file' }, { status: 400 });
    }

    await tryLogAuditEvent(session, {
      action: 'customer.document_uploaded',
      entityType: 'documents',
      entityId: documentId,
      projectId,
    });
    return NextResponse.json({ id: documentId }, { status: 201 });
  } catch (e) {
    return dbErrorResponse(e, 'Sending your file');
  }
}
