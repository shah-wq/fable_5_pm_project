import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';
import { notifyAppointment } from '@/lib/push/events';
import { isStageKey } from '@/lib/stages/definitions';
import { groupStageValues, writeStageValues } from '@/lib/stages/save';

/**
 * Saves a stage form. The field registry (lib/stages/fields.ts) is the
 * allowlist — only its columns reach SQL, values are validated against each
 * field's type/options, and rows are upserted per target table (the stage's
 * own table, finance_milestones, or projects.finance_partner_id). The
 * audit_row triggers capture old → new values automatically. The coercion and
 * the upsert live in lib/stages/save.ts, shared with accepted AI suggestions.
 */
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

  const grouped = groupStageValues(stage, body.values);
  if (!grouped.ok) return NextResponse.json({ error: grouped.error }, { status: 400 });
  if (grouped.count === 0) return NextResponse.json({ error: 'nothing to save' }, { status: 400 });
  const { byTable } = grouped;

  let saved: boolean;
  try {
    saved = await withUser(session, async (client) => {
      const project = await client.query('select id from public.projects where id = $1', [id]);
      if (!project.rows[0]) return false;

      await writeStageValues(client, id, stage, byTable);

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
