import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { logAuditEvent } from '@/lib/audit';
import { withUser } from '@/lib/db';
import { dbErrorResponse } from '@/lib/db-error';
import { optionalRows } from '@/lib/db-optional';
import { loadSuggestions, type Suggestion } from '@/lib/ai/documents';

const ROLES = ['admin', 'ops'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ExceptionRow {
  id: string;
  project_id: string | null;
  project_code: string | null;
  project_name: string | null;
  customer_name: string | null;
  entity_type: string | null;
  entity_id: string | null;
  severity: string;
  status: string;
  summary: string;
  details: Record<string, unknown>;
  raised_by: string;
  assigned_to: string | null;
  assigned_name: string | null;
  pending_suggestions: number;
  created_at: string;
  suggestions?: Suggestion[];
}

/**
 * The exceptions queue: everything open that this person may see, with the
 * pending AI suggestions attached to each document exception so the screen
 * can decide them in place.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!ROLES.includes(session.role) || !session.isActive)
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  try {
    const out = await withUser(session, async (c) => {
      const rows = await optionalRows<Omit<ExceptionRow, 'created_at'> & { created_at: unknown }>(
        c,
        'the exceptions queue (public.open_exceptions)',
        'select * from public.open_exceptions()'
      );
      const suggestions = await loadSuggestions(c, { status: 'pending' }).catch(
        () => [] as Suggestion[]
      );
      const byDoc = new Map<string, Suggestion[]>();
      for (const s of suggestions) {
        if (!s.documentId) continue;
        byDoc.set(s.documentId, [...(byDoc.get(s.documentId) ?? []), s]);
      }
      return {
        items: rows.map((r) => ({
          ...r,
          created_at:
            r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
          suggestions:
            r.entity_type === 'documents' && r.entity_id ? (byDoc.get(r.entity_id) ?? []) : [],
        })),
      };
    });
    return NextResponse.json(out);
  } catch (e) {
    return dbErrorResponse(e, 'Loading the exceptions queue');
  }
}

/** Change an exception's status: acknowledged, in_progress, resolved or dismissed. */
export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!ROLES.includes(session.role) || !session.isActive)
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const body = (await request.json().catch(() => null)) as {
    id?: unknown;
    status?: unknown;
    notes?: unknown;
  } | null;
  const id = typeof body?.id === 'string' && UUID_RE.test(body.id) ? body.id : null;
  const status = typeof body?.status === 'string' ? body.status : null;
  if (
    !id ||
    !status ||
    !['acknowledged', 'in_progress', 'resolved', 'dismissed'].includes(status)
  ) {
    return NextResponse.json({ error: 'id and a valid status are required' }, { status: 400 });
  }
  const notes = typeof body?.notes === 'string' ? body.notes.slice(0, 2000) : null;
  try {
    const updated = await withUser(session, async (c) => {
      const closing = status === 'resolved' || status === 'dismissed';
      const r = await c.query<{ project_id: string | null }>(
        `update public.exceptions
            set status = $2::public.exception_status,
                resolved_by = case when $3 then $4::uuid else resolved_by end,
                resolved_at = case when $3 then now() else resolved_at end,
                resolution_notes = coalesce($5, resolution_notes)
          where id = $1 returning project_id`,
        [id, status, closing, session.userId, notes]
      );
      if (r.rowCount === 0) return null;
      if (closing) {
        // Suggestions nobody decided are closed with the exception, not applied.
        await c
          .query(
            `update public.ai_suggestions s set status = 'rejected', decided_by = $2, decided_at = now()
             from public.exceptions e
            where e.id = $1 and e.entity_type = 'documents' and s.document_id::text = e.entity_id and s.status = 'pending'`,
            [id, session.userId]
          )
          .catch(() => undefined);
      }
      return r.rows[0];
    });
    if (!updated) return NextResponse.json({ error: 'No such exception.' }, { status: 404 });
    await logAuditEvent(session, {
      action: `exception.${status}`,
      entityType: 'exceptions',
      entityId: id,
      projectId: updated.project_id ?? undefined,
      context: notes ? { notes } : {},
    }).catch(() => undefined);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return dbErrorResponse(e, 'Updating the exception');
  }
}
