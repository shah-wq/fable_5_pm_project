import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { buildZip, type ZipEntry } from '@/lib/zip';

/**
 * 'Download all my documents' — the complete pack as one file at project
 * completion (spec §3.3). This is the thing customers ask for when the solar
 * tax credit is due and their accountant wants everything at once.
 *
 * Every file still goes through public.read_document(), one at a time, so the
 * customer-visible rule is applied per document by the database rather than
 * being re-decided here. A document they may not see simply is not in the zip.
 */
const MAX_FILES = 60;
const MAX_BYTES = 80 * 1024 * 1024;

export async function GET(request: Request) {
  const session = await getSession();
  if (!session || !session.isActive) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const projectId = new URL(request.url).searchParams.get('project');
  if (!projectId || !/^[0-9a-f-]{36}$/i.test(projectId)) {
    return NextResponse.json({ error: 'project required' }, { status: 400 });
  }

  const result = await withUser(session, async (client) => {
    // RLS scopes this to projects the caller may see, so a guessed id is empty.
    const { rows: docs } = await client.query<{
      id: string; title: string | null; mime_type: string | null; created_at: Date;
    }>(
      `select d.id, d.title, d.mime_type, d.created_at
       from public.documents d
       join public.projects p on p.id = d.project_id
       where d.project_id = $1
         and (d.customer_visible or (select app.current_user_role()) in ('admin', 'ops'))
       order by d.created_at
       limit $2`,
      [projectId, MAX_FILES]
    );
    const { rows: project } = await client.query<{ code: string }>(
      `select code from public.projects where id = $1`,
      [projectId]
    );
    if (!project[0]) return null;

    const entries: ZipEntry[] = [];
    let total = 0;
    for (const doc of docs) {
      const { rows } = await client.query<{ title: string | null; mime_type: string | null; data: Buffer }>(
        `select * from public.read_document($1)`,
        [doc.id]
      );
      const file = rows[0];
      if (!file) continue;                       // not visible to this caller
      total += file.data.length;
      if (total > MAX_BYTES) break;              // a phone download has limits
      entries.push({
        name: `${doc.title ?? 'document'}${extensionFor(file.mime_type)}`,
        data: file.data,
        modified: doc.created_at,
      });
    }
    return { code: project[0].code, entries };
  });

  if (!result) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (result.entries.length === 0) {
    return NextResponse.json({ error: 'no documents to download yet' }, { status: 404 });
  }

  const zip = buildZip(result.entries);
  return new NextResponse(new Uint8Array(zip), {
    headers: {
      'content-type': 'application/zip',
      'content-length': String(zip.length),
      'content-disposition': `attachment; filename="${result.code}-documents.zip"`,
      'cache-control': 'private, no-store',
    },
  });
}

function extensionFor(mime: string | null): string {
  switch (mime) {
    case 'application/pdf': return '.pdf';
    case 'image/jpeg': return '.jpg';
    case 'image/png': return '.png';
    case 'image/webp': return '.webp';
    case 'image/heic': return '.heic';
    default: return '';
  }
}
