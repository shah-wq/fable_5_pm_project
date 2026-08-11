import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';

/**
 * '+ Add new' inline from the project form — the PM shouldn't have to leave
 * for the admin panel to add the sales rep or dealer standing in front of
 * them. Only these two lists; RLS still has the final say on the insert.
 */

const ALLOWED = new Set(['sales_reps', 'dealers']);

export async function POST(request: Request, ctx: { params: Promise<{ entity: string }> }) {
  const { entity } = await ctx.params;
  if (!ALLOWED.has(entity)) return NextResponse.json({ error: 'unknown list' }, { status: 404 });

  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    name?: string;
    email?: string | null;
    phone?: string | null;
  } | null;
  const name = body?.name?.trim();
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });

  const id = await withUser(session, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into public."${entity}" (name, email, phone) values ($1, $2, $3) returning id`,
      [name, body?.email?.trim() || null, body?.phone?.trim() || null]
    );
    return rows[0]?.id ?? null;
  }).catch(() => null);

  if (!id) {
    return NextResponse.json(
      { error: 'Could not add — you may not have permission for this list.' },
      { status: 403 }
    );
  }

  await tryLogAuditEvent(session, { action: `${entity}.added_inline`, entityType: entity, entityId: id });
  return NextResponse.json({ id }, { status: 201 });
}
