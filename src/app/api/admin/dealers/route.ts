import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';

/**
 * Create / update a dealer company — the full record from the spec. Admin
 * only (RLS enforces it a second time). Company names are unique
 * case-insensitively; a duplicate is rejected naming the existing record.
 * The audit_row trigger writes every field change with old → new values.
 */

const TEXT_FIELDS = [
  'name', 'code', 'primary_contact_name', 'primary_contact_email', 'email', 'phone',
  'company_address', 'tax_id', 'payment_terms', 'notification_recipients', 'notes',
] as const;
const BASES = ['percentage_of_contract', 'fixed_per_project', 'per_watt', 'manual'];

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (session.role !== 'admin' || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    id?: string;
    values?: Record<string, unknown>;
    isActive?: boolean;
  } | null;
  const v = body?.values ?? {};

  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const f of TEXT_FIELDS) {
    if (f in v) {
      const s = v[f] === null || v[f] === undefined ? '' : String(v[f]).trim();
      cols.push(f);
      vals.push(s || null);
    }
  }
  if ('default_commission_basis' in v) {
    const basis = v.default_commission_basis ? String(v.default_commission_basis) : null;
    if (basis && !BASES.includes(basis)) {
      return NextResponse.json({ error: 'invalid commission basis' }, { status: 400 });
    }
    cols.push('default_commission_basis');
    vals.push(basis);
  }
  if ('default_commission_rate' in v) {
    const rate = v.default_commission_rate === null || v.default_commission_rate === ''
      ? null
      : Number(v.default_commission_rate);
    if (rate !== null && (!Number.isFinite(rate) || rate < 0)) {
      return NextResponse.json({ error: 'invalid commission rate' }, { status: 400 });
    }
    cols.push('default_commission_rate');
    vals.push(rate);
  }
  if ('reps_see_own_only' in v) {
    cols.push('reps_see_own_only');
    vals.push(v.reps_see_own_only === true);
  }
  if (typeof body?.isActive === 'boolean') {
    cols.push('is_active');
    vals.push(body.isActive);
  }

  const nameIdx = cols.indexOf('name');
  if (!body?.id) {
    if (nameIdx === -1 || !vals[nameIdx]) {
      return NextResponse.json({ error: 'company name is required' }, { status: 400 });
    }
    if (!cols.includes('primary_contact_email') || !vals[cols.indexOf('primary_contact_email')]) {
      return NextResponse.json({ error: 'primary contact email is required' }, { status: 400 });
    }
  } else if (nameIdx !== -1 && !vals[nameIdx]) {
    return NextResponse.json({ error: 'company name cannot be blank' }, { status: 400 });
  }
  if (cols.length === 0) return NextResponse.json({ error: 'nothing to save' }, { status: 400 });

  try {
    const row = await withUser(session, async (client) => {
      if (body?.id) {
        const sets = cols.map((c, i) => `"${c}" = $${i + 2}`).join(', ');
        const { rows } = await client.query(
          `update public.dealers set ${sets} where id = $1 returning id`,
          [body.id, ...vals]
        );
        return rows[0] ?? null;
      }
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const { rows } = await client.query(
        `insert into public.dealers (${cols.map((c) => `"${c}"`).join(', ')})
         values (${placeholders}) returning id`,
        vals
      );
      return rows[0] ?? null;
    });
    if (!row) return NextResponse.json({ error: 'dealer not found' }, { status: 404 });

    await tryLogAuditEvent(session, {
      action: body?.id ? 'dealer.updated' : 'dealer.created',
      entityType: 'dealers',
      entityId: row.id,
    });
    return NextResponse.json({ id: row.id }, { status: body?.id ? 200 : 201 });
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      return NextResponse.json(
        { error: 'A dealer company with this name already exists — edit the existing record instead.' },
        { status: 409 }
      );
    }
    throw e;
  }
}
