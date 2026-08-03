import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';

interface DocumentRow {
  title: string | null;
  mime_type: string | null;
  size_bytes: string | number | null;
  data: Buffer;
}

/**
 * Serves a document's bytes to a signed-in user. Access is decided in the
 * database (public.read_document): project participants only, customers only
 * see customer-visible files, DWG stays staff-only. 404 covers both
 * "missing" and "not yours".
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const session = await getSession();
  if (!session || !session.isActive) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { rows } = await withUser(session, (c) =>
    c.query<DocumentRow>('select * from public.read_document($1)', [id])
  );
  const doc = rows[0];
  if (!doc) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const filename = (doc.title ?? 'document').replace(/[^\w.\- ]+/g, '_');
  return new NextResponse(new Uint8Array(doc.data), {
    headers: {
      'content-type': doc.mime_type ?? 'application/octet-stream',
      'content-length': String(doc.data.length),
      'content-disposition': `inline; filename="${filename}"`,
      'cache-control': 'private, max-age=0, no-store',
    },
  });
}
