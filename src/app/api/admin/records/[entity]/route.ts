import { NextResponse } from 'next/server';
import { ADMIN_ENTITIES } from '@/lib/admin/entities';
import { getSession, type Session } from '@/lib/auth/session';
import { withUser } from '@/lib/db';

/**
 * Generic create/update for the admin panel's reference tables. Columns come
 * from the entity registry — nothing else reaches the SQL. Writes run with
 * the admin's claims (RLS applies) and the audit_row triggers capture
 * old → new values automatically.
 */

async function requireAdmin(): Promise<Session | NextResponse> {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (session.role !== 'admin' || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return session;
}

function coerce(type: string, raw: unknown): unknown {
  if (raw === '' || raw === undefined || raw === null) return null;
  switch (type) {
    case 'number':
    case 'rating': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case 'tags':
      return Array.isArray(raw)
        ? raw.map(String)
        : String(raw)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
    default:
      return String(raw);
  }
}

export async function POST(request: Request, ctx: { params: Promise<{ entity: string }> }) {
  const gate = await requireAdmin();
  if (gate instanceof NextResponse) return gate;
  const { entity } = await ctx.params;
  const def = ADMIN_ENTITIES[entity];
  if (!def) return NextResponse.json({ error: 'unknown entity' }, { status: 404 });

  const body = (await request.json().catch(() => null)) as {
    id?: string;
    values?: Record<string, unknown>;
    isActive?: boolean;
  } | null;

  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const field of def.fields) {
    if (body?.values && field.name in body.values) {
      const v = coerce(field.type, body.values[field.name]);
      if (field.required && (v === null || v === '')) {
        return NextResponse.json({ error: `${field.label} is required` }, { status: 400 });
      }
      cols.push(field.name);
      vals.push(v);
    } else if (field.required && !body?.id) {
      return NextResponse.json({ error: `${field.label} is required` }, { status: 400 });
    }
  }
  if (typeof body?.isActive === 'boolean') {
    cols.push('is_active');
    vals.push(body.isActive);
  }
  if (cols.length === 0) {
    return NextResponse.json({ error: 'nothing to save' }, { status: 400 });
  }

  const row = await withUser(gate, async (client) => {
    if (body?.id) {
      const sets = cols.map((c, i) => `"${c}" = $${i + 2}`).join(', ');
      const { rows } = await client.query(
        `update public."${def.table}" set ${sets} where id = $1 returning id`,
        [body.id, ...vals]
      );
      return rows[0] ?? null;
    }
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const quoted = cols.map((c) => `"${c}"`).join(', ');
    const { rows } = await client.query(
      `insert into public."${def.table}" (${quoted}) values (${placeholders}) returning id`,
      vals
    );
    return rows[0] ?? null;
  });

  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ id: row.id }, { status: body?.id ? 200 : 201 });
}
