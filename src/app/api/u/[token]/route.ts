import { NextResponse } from 'next/server';
import { withAnon } from '@/lib/db';

const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

/**
 * Receives one file for an upload grant (REQ-SEC-01). No session, no
 * cookies: the token is the entire credential. public.record_grant_upload
 * re-validates it on every request (expired/revoked → 410), stores the
 * bytes, registers the documents row, and writes the audit entry — all in
 * one transaction.
 */
export async function POST(request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

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

  const bytes = Buffer.from(await file.arrayBuffer());

  let documentId: string | null;
  try {
    const { rows } = await withAnon((c) =>
      c.query<{ id: string | null }>(
        'select public.record_grant_upload($1, $2, $3, $4) as id',
        [token, file.name, file.type, bytes]
      )
    );
    documentId = rows[0]?.id ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('only photos')) {
      return NextResponse.json({ error: 'only photos are accepted on this link' }, { status: 415 });
    }
    if (message.includes('25 MB')) {
      return NextResponse.json({ error: 'file must be between 1 byte and 25 MB' }, { status: 413 });
    }
    throw error;
  }

  if (!documentId) {
    return NextResponse.json({ error: 'link expired or revoked' }, { status: 410 });
  }

  return NextResponse.json({ documentId }, { status: 201 });
}
