import { NextResponse } from 'next/server';
import { tryLogAuditEvent } from '@/lib/audit';
import { getSession } from '@/lib/auth/session';
import { dbErrorResponse } from '@/lib/db-error';
import { withUser } from '@/lib/db';
import { sanitizeDefinition } from '@/lib/reports/definition';
import { allowedKeysFor } from '@/lib/reports/run';

/**
 * Save / list saved reports. The definition is stored as JSON exactly as the
 * canvas produced it (after sanitizing against the field registry), so a saved
 * report is re-runnable against live data rather than a frozen result set.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = ['admin', 'ops', 'finance', 'designer'];

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!['admin', 'ops', 'finance'].includes(session.role) || !session.isActive) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    id?: string;
    name?: string;
    description?: string | null;
    definition?: unknown;
    visibility?: string;
    sharedRoles?: string[];
    sharedUsers?: string[];
  } | null;

  const name = body?.name?.trim().slice(0, 120);
  if (!name) return NextResponse.json({ error: 'a report name is required' }, { status: 400 });

  const wantsNotes = (body?.definition as { includeInternalNotes?: boolean } | null)
    ?.includeInternalNotes === true;
  const definition = sanitizeDefinition(body?.definition, allowedKeysFor(session, wantsNotes));

  const visibility = ['private', 'role', 'users'].includes(String(body?.visibility))
    ? String(body!.visibility)
    : 'private';
  const sharedRoles = Array.isArray(body?.sharedRoles)
    ? body!.sharedRoles.map(String).filter((r) => ROLES.includes(r))
    : [];
  const sharedUsers = Array.isArray(body?.sharedUsers)
    ? body!.sharedUsers.map(String).filter((u) => UUID_RE.test(u))
    : [];

  try {
    const id = await withUser(session, async (client) => {
      if (body?.id && UUID_RE.test(body.id)) {
        const { rows } = await client.query<{ id: string }>(
          `update public.report_definitions
           set name = $2, description = $3, definition = $4::jsonb,
               visibility = $5, shared_roles = $6, shared_users = $7
           where id = $1
           returning id`,
          [body.id, name, body.description?.slice(0, 500) ?? null,
           JSON.stringify(definition), visibility, sharedRoles, sharedUsers]
        );
        return rows[0]?.id ?? null;
      }
      const { rows } = await client.query<{ id: string }>(
        `insert into public.report_definitions
           (name, description, definition, owner_id, visibility, shared_roles, shared_users)
         values ($1, $2, $3::jsonb, $4, $5, $6, $7)
         returning id`,
        [name, body?.description?.slice(0, 500) ?? null, JSON.stringify(definition),
         session.userId, visibility, sharedRoles, sharedUsers]
      );
      return rows[0]?.id ?? null;
    });

    if (!id) {
      return NextResponse.json(
        { error: 'Could not save — a shared report can only be changed by its owner.' },
        { status: 403 }
      );
    }

    await tryLogAuditEvent(session, {
      action: body?.id ? 'report.updated' : 'report.created',
      entityType: 'report_definitions',
      entityId: id,
      context: { name, visibility },
    });
    return NextResponse.json({ id }, { status: body?.id ? 200 : 201 });
  } catch (e) {
    return dbErrorResponse(e, 'Saving the report');
  }
}
