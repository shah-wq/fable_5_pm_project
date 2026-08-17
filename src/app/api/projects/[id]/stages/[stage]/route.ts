import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';
import { notifyAppointment } from '@/lib/push/events';
import { isStageKey } from '@/lib/stages/definitions';
import { STAGE_FORMS, STAGE_TABLES, type StageField } from '@/lib/stages/fields';

/**
 * Saves a stage form. The field registry (lib/stages/fields.ts) is the
 * allowlist — only its columns reach SQL, values are validated against each
 * field's type/options, and rows are upserted per target table (the stage's
 * own table, finance_milestones, or projects.finance_partner_id). The
 * audit_row triggers capture old → new values automatically.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function coerce(field: StageField, raw: unknown): { ok: true; value: unknown } | { ok: false } {
  if (raw === '' || raw === null || raw === undefined) return { ok: true, value: null };
  switch (field.type) {
    case 'select':
      return field.options?.includes(String(raw))
        ? { ok: true, value: String(raw) }
        : { ok: false };
    case 'date':
      return DATE_RE.test(String(raw)) ? { ok: true, value: String(raw) } : { ok: false };
    case 'toggle':
      return typeof raw === 'boolean' ? { ok: true, value: raw } : { ok: false };
    case 'refselect':
      return UUID_RE.test(String(raw)) ? { ok: true, value: String(raw) } : { ok: false };
    case 'permits':
      return Array.isArray(raw)
        ? { ok: true, value: raw.map((v) => String(v).slice(0, 60)).filter(Boolean) }
        : { ok: false };
    case 'text':
    case 'textarea':
      return { ok: true, value: String(raw).slice(0, 10000) };
    default:
      return { ok: false };
  }
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; stage: string }> }
) {
  const { id, stage } = await ctx.params;
  if (!isStageKey(stage)) return NextResponse.json({ error: 'unknown stage' }, { status: 404 });

  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    values?: Record<string, unknown>;
  } | null;
  if (!body?.values || typeof body.values !== 'object') {
    return NextResponse.json({ error: 'values required' }, { status: 400 });
  }

  const fields = STAGE_FORMS[stage].flatMap((card) => card.fields);
  const byTable: Record<'stage' | 'finance' | 'project', Array<{ col: string; value: unknown }>> = {
    stage: [],
    finance: [],
    project: [],
  };

  for (const [name, raw] of Object.entries(body.values)) {
    const field = fields.find((f) => f.name === name && f.type !== 'upload');
    if (!field) continue; // silently drop unknown/upload fields
    const coerced = coerce(field, raw);
    if (!coerced.ok) {
      return NextResponse.json({ error: `invalid value for ${field.label}` }, { status: 400 });
    }
    // Status/toggle columns are NOT NULL with defaults; an untouched dropdown
    // arrives as null and must be omitted, not written.
    if (coerced.value === null && (field.type === 'select' || field.type === 'toggle')) continue;
    const value =
      field.type === 'permits' && coerced.value === null ? [] : coerced.value;
    byTable[field.table ?? 'stage'].push({ col: name, value });
  }

  // Drive Updated carries its own timestamp (Complete uses final_drive_updated).
  for (const [col, stampCol] of [
    ['drive_updated', 'drive_updated_at'],
    ['final_drive_updated', 'final_drive_updated_at'],
  ] as const) {
    const drive = byTable.stage.find((u) => u.col === col);
    if (drive) byTable.stage.push({ col: stampCol, value: drive.value ? new Date() : null });
  }

  if (!byTable.stage.length && !byTable.finance.length && !byTable.project.length) {
    return NextResponse.json({ error: 'nothing to save' }, { status: 400 });
  }

  let saved: boolean;
  try {
    saved = await withUser(session, async (client) => {
    const project = await client.query('select id from public.projects where id = $1', [id]);
    if (!project.rows[0]) return false;

    const upsert = async (table: string, updates: Array<{ col: string; value: unknown }>) => {
      if (!updates.length) return;
      const cols = updates.map((u) => `"${u.col}"`);
      const params: unknown[] = [id, ...updates.map((u) => u.value)];
      const placeholders = updates.map((_, i) => `$${i + 2}`);
      const sets = updates.map((u, i) => `"${u.col}" = $${i + 2}`);
      await client.query(
        `insert into public."${table}" (project_id, ${cols.join(', ')})
         values ($1, ${placeholders.join(', ')})
         on conflict (project_id) do update set ${sets.join(', ')}`,
        params
      );
    };

    await upsert(STAGE_TABLES[stage], byTable.stage);
    await upsert('finance_milestones', byTable.finance);
    if (byTable.project.length) {
      const sets = byTable.project.map((u, i) => `"${u.col}" = $${i + 2}`);
      await client.query(
        `update public.projects set ${sets.join(', ')} where id = $1`,
        [id, ...byTable.project.map((u) => u.value)]
      );
    }

    // Confirming a date the customer has to be home for is the one save they
    // want to hear about immediately (spec §4). Deduped on the date itself, so
    // correcting another field does not re-notify — but re-scheduling does.
    for (const [col, what] of [
      ['install_scheduled_date', 'install'],
      ['inspection_requested_date', 'inspection'],
    ] as const) {
      const scheduled = byTable.stage.find((u) => u.col === col);
      if (scheduled?.value) {
        await notifyAppointment(client, id, what, String(scheduled.value));
      }
    }
      return true;
    });
  } catch (e) {
    return dbErrorResponse(e, `Saving the ${stage} form`);
  }

  if (!saved) return NextResponse.json({ error: 'project not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
