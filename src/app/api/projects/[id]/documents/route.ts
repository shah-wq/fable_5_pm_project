import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Staff file upload for stage forms (shading reports, install pictures, …).
 * public.record_staff_upload enforces staff-of-project, mime and size rules,
 * stores the bytes, registers the documents row with its category, and
 * writes the audit entry.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const form = await request.formData().catch(() => null);
  const category = String(form?.get('category') ?? '').trim();
  const files = (form?.getAll('file') ?? []).filter((f): f is File => f instanceof File);
  if (!category || files.length === 0) {
    return NextResponse.json({ error: 'category and at least one file are required' }, { status: 400 });
  }

  const documentIds: string[] = [];
  for (const file of files.slice(0, 20)) {
    if (file.size === 0 || file.size > MAX_BYTES) {
      return NextResponse.json({ error: `${file.name}: files must be under 25 MB` }, { status: 413 });
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    try {
      const { rows } = await withUser(session, (c) =>
        c.query<{ id: string }>(
          'select public.record_staff_upload($1, $2, $3, $4, $5) as id',
          [id, category, file.name, file.type, bytes]
        )
      );
      documentIds.push(rows[0].id);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('only photos and PDFs')) {
        return NextResponse.json({ error: `${file.name}: only photos and PDFs are accepted` }, { status: 415 });
      }
      throw error;
    }
  }

  return NextResponse.json({ documentIds }, { status: 201 });
}
