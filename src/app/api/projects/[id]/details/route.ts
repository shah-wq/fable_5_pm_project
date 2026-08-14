import { NextResponse } from 'next/server';
import { logAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';
import { DETAIL_FIELDS, coerceDetail } from '@/lib/projects/details';

/**
 * Saves the Details tab. The registry (lib/projects/details.ts) is the
 * allowlist — project columns and the customer's client row both update in
 * one transaction, and the audit_row triggers capture old → new values.
 * Details stay editable from any stage; once a project is Complete or
 * Cancelled they lock, and only an admin with a mandatory reason can write —
 * finished records must not drift silently.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    values?: Record<string, unknown>;
    reason?: string;
  } | null;
  if (!body?.values || typeof body.values !== 'object') {
    return NextResponse.json({ error: 'values required' }, { status: 400 });
  }

  const project: Array<{ col: string; value: unknown }> = [];
  const client: Array<{ col: string; value: unknown }> = [];
  for (const [name, raw] of Object.entries(body.values)) {
    const field = DETAIL_FIELDS.find((f) => f.name === name);
    if (!field) continue; // silently drop unknown fields
    const coerced = coerceDetail(field, raw);
    if (!coerced.ok) {
      return NextResponse.json({ error: `invalid value for ${field.label}` }, { status: 400 });
    }
    if (field.required && coerced.value === null) {
      return NextResponse.json({ error: `${field.label} cannot be empty` }, { status: 400 });
    }
    (field.table === 'client' ? client : project).push({ col: name, value: coerced.value });
  }
  if (!project.length && !client.length) {
    return NextResponse.json({ error: 'nothing to save' }, { status: 400 });
  }

  let result: 'ok' | 'not_found' | 'locked' | 'reason';
  try {
    result = await withUser(session, async (c) => {
    const { rows } = await c.query(
      `select id, status, client_id from public.projects where id = $1`,
      [id]
    );
    const row = rows[0];
    if (!row) return 'not_found' as const;

    // Completed and cancelled projects need an admin unlock with a reason.
    if (['complete', 'cancelled'].includes(row.status)) {
      if (session.role !== 'admin') return 'locked' as const;
      if (!body.reason || body.reason.trim().length < 5) return 'reason' as const;
    }

    if (project.length) {
      const sets = project.map((u, i) => `"${u.col}" = $${i + 2}`).join(', ');
      await c.query(`update public.projects set ${sets} where id = $1`, [
        id,
        ...project.map((u) => u.value),
      ]);
    }
    if (client.length && row.client_id) {
      const sets = client.map((u, i) => `"${u.col}" = $${i + 2}`).join(', ');
      await c.query(`update public.clients set ${sets} where id = $1`, [
        row.client_id,
        ...client.map((u) => u.value),
      ]);
    }
    return 'ok' as const;
    });
  } catch (e) {
    return dbErrorResponse(e, 'Saving the project details');
  }

  if (result === 'not_found') return NextResponse.json({ error: 'project not found' }, { status: 404 });
  if (result === 'locked') {
    return NextResponse.json(
      { error: 'This project is finished — only an admin can unlock the details for a correction.' },
      { status: 403 }
    );
  }
  if (result === 'reason') {
    return NextResponse.json(
      { error: 'A reason is required to edit a finished project.' },
      { status: 422 }
    );
  }

  await logAuditEvent(session, {
    action: 'project.details_updated',
    entityType: 'projects',
    entityId: id,
    projectId: id,
    context: {
      fields: [...project, ...client].map((u) => u.col),
      ...(body.reason ? { reason: body.reason.trim() } : {}),
    },
  }).catch(() => undefined);

  return NextResponse.json({ ok: true });
}
