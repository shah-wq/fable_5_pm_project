import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';
import { dbErrorResponse } from '@/lib/db-error';
import { optionalRows } from '@/lib/db-optional';
import { isUuid } from '@/lib/crm/coerce';

/**
 * Delete a project — unwinding the sale that made it.
 *
 * Admin-only, and the project's code must be sent back as confirmation: this
 * takes the project's stages, tasks, messages and forms with it and cannot be
 * undone. public.delete_project() keeps what belongs to the sale rather than
 * the job — the deal's documents, and the deal itself, reopened — and once it
 * is gone the contact it held in Contract signed can be moved again.
 *
 * Not the same as Cancel project, which stops a job and keeps it on record.
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (session.role !== 'admin' || !session.isActive) {
    return NextResponse.json({ error: 'Only an admin may delete a project.' }, { status: 403 });
  }
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = (await request.json().catch(() => null)) as { confirm?: unknown } | null;
  const confirm = typeof body?.confirm === 'string' ? body.confirm.trim() : '';

  try {
    const rows = await withUser(session, (client) =>
      optionalRows<{ client_id: string }>(
        client,
        'deleting the project (public.delete_project)',
        `select public.delete_project($1::uuid, $2) as client_id`,
        [id, confirm]
      )
    );
    if (rows.length === 0) {
      return NextResponse.json(
        {
          error:
            'Could not delete — the database has not caught up yet. Open Admin → Database and click Apply.',
        },
        { status: 400 }
      );
    }
    return NextResponse.json({ clientId: rows[0].client_id });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === '22023' || err.code === 'P0002') {
      const text = err.message ?? 'That project could not be deleted.';
      return NextResponse.json(
        { error: text.charAt(0).toUpperCase() + text.slice(1) + '.' },
        { status: err.code === 'P0002' ? 404 : 400 }
      );
    }
    return dbErrorResponse(e, 'Deleting the project');
  }
}
