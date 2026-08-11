import { NextResponse } from 'next/server';
import { logAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { withUser } from '@/lib/db';

/**
 * Bulk edit from the Projects tab: set assigned PM, dealer, or sales rep on
 * several projects in one action — the common case when a rep leaves or a PM
 * takes over a book. Finished (complete/cancelled) projects are skipped, not
 * silently rewritten; the response says how many were updated.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SETTABLE = new Set(['assigned_pm', 'dealer_id', 'sales_rep_id']);

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    ids?: unknown;
    set?: Record<string, unknown>;
  } | null;
  const ids = Array.isArray(body?.ids) ? body.ids.map(String).filter((v) => UUID_RE.test(v)) : [];
  if (ids.length === 0 || ids.length > 200) {
    return NextResponse.json({ error: 'select between 1 and 200 projects' }, { status: 400 });
  }

  const sets: Array<{ col: string; value: string }> = [];
  for (const [col, raw] of Object.entries(body?.set ?? {})) {
    if (!SETTABLE.has(col)) continue;
    if (!UUID_RE.test(String(raw))) {
      return NextResponse.json({ error: `invalid value for ${col}` }, { status: 400 });
    }
    sets.push({ col, value: String(raw) });
  }
  if (sets.length === 0) {
    return NextResponse.json({ error: 'nothing to set' }, { status: 400 });
  }

  const updated = await withUser(session, async (client) => {
    const clauses = sets.map((s, i) => `"${s.col}" = $${i + 2}`).join(', ');
    const { rows } = await client.query<{ id: string }>(
      `update public.projects set ${clauses}
       where id = any($1) and status not in ('complete', 'cancelled')
       returning id`,
      [ids, ...sets.map((s) => s.value)]
    );
    return rows.map((r) => r.id);
  });

  for (const projectId of updated) {
    await logAuditEvent(session, {
      action: 'project.details_updated',
      entityType: 'projects',
      entityId: projectId,
      projectId,
      context: { bulk: true, fields: sets.map((s) => s.col) },
    }).catch(() => undefined);
  }

  return NextResponse.json({ updated: updated.length, skipped: ids.length - updated.length });
}
