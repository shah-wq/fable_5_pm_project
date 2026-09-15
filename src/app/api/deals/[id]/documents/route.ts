import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { dbErrorResponse } from '@/lib/db-error';
import { optionalRows } from '@/lib/db-optional';
import { INTAKE_DOCUMENT_CATEGORIES } from '@/lib/crm/intake';

const MAX_BYTES = 15 * 1024 * 1024;
const ALLOWED = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
];

/**
 * The intake uploads: proposals, bills, panel and meter photos, the signed
 * agreement.
 *
 * Filed against the deal rather than a project, because at this point there is
 * no project — and when the deal is won the conversion moves the relation
 * across rather than copying the file. One document store, as Part 3 asks.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops', 'sales'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: 'expected a form' }, { status: 400 });

  const category = String(form.get('category') ?? '');
  if (!INTAKE_DOCUMENT_CATEGORIES.includes(category)) {
    return NextResponse.json({ error: 'unknown document category' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'pick a file first' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `${file.name} is larger than 15 MB` }, { status: 400 });
  }
  if (!ALLOWED.includes(file.type || '')) {
    return NextResponse.json({ error: `${file.name} is not a PDF or a photo` }, { status: 400 });
  }

  try {
    const documentId = await withUser(session, async (client) => {
      const deal = await optionalRows<{ id: string }>(
        client,
        'the deal being uploaded against',
        `select id from public.deals where id = $1`,
        [id]
      );
      if (deal.length === 0) return null;

      const bytes = Buffer.from(await file.arrayBuffer());
      const rows = await optionalRows<{ id: string }>(
        client,
        'filing an intake document (public.record_deal_document)',
        `select public.record_deal_document($1, $2, $3, $4, $5) as id`,
        [id, category, file.name.slice(0, 200), file.type, bytes]
      );
      return rows[0]?.id ?? null;
    });

    if (!documentId) {
      return NextResponse.json(
        { error: 'Could not file that — the deal may have gone, or the database has not caught up.' },
        { status: 400 }
      );
    }

    await tryLogAuditEvent(session, {
      action: `document.uploaded.${category}`,
      entityType: 'documents',
      entityId: documentId,
      dealId: id,
      kind: 'form',
    });
    return NextResponse.json({ id: documentId }, { status: 201 });
  } catch (e) {
    return dbErrorResponse(e, 'Uploading the document');
  }
}
