import { withClaims, type Json, type SessionIdentity } from './db';

/**
 * Audit-log writer — the shared utility every module calls for events that
 * aren't plain row DML (those are captured automatically by the `audit_row`
 * database triggers).
 *
 * Wraps `public.log_audit_event` (SECURITY DEFINER): the actor's identity
 * and role are taken from the request claims inside the database, so entries
 * can't be written on someone else's behalf, and the audit_log table itself
 * accepts no direct inserts, updates, or deletes.
 */

export interface AuditEvent {
  /** Verb, dot-namespaced by module: 'design.shared', 'auth.signed_in', ... */
  action: string;
  /** What kind of thing was acted on — usually the table name. */
  entityType: string;
  /** Primary key of the entity, if any. */
  entityId?: string;
  /** Project the event belongs to; fills the project timeline. */
  projectId?: string;
  /** Free-form extra context (channel, counts, reasons, ...). */
  context?: Json;
}

/** Write one audit event as `actor` (null = unattributed system event). */
export async function logAuditEvent(
  actor: SessionIdentity | null,
  event: AuditEvent
): Promise<number> {
  const claims = actor
    ? {
        sub: actor.userId,
        role: 'authenticated' as const,
        user_role: actor.role,
        email: actor.email ?? undefined,
      }
    : {};
  const { rows } = await withClaims(claims, (c) =>
    c.query<{ id: number }>(
      'select public.log_audit_event($1, $2, $3, $4, $5) as id',
      [
        event.action,
        event.entityType,
        event.entityId ?? null,
        event.projectId ?? null,
        JSON.stringify(event.context ?? {}),
      ]
    )
  );
  return rows[0].id;
}

/**
 * Fire-and-forget variant for hot paths where an audit failure must not
 * break the user-facing operation.
 */
export async function tryLogAuditEvent(
  actor: SessionIdentity | null,
  event: AuditEvent,
  onError: (error: unknown) => void = (e) => console.error('audit write failed:', e)
): Promise<number | null> {
  try {
    return await logAuditEvent(actor, event);
  } catch (error) {
    onError(error);
    return null;
  }
}
