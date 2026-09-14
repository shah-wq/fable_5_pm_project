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
  /** What kind of activity this is — CRM timelines group by it. */
  kind?:
    | 'call' | 'email' | 'sms' | 'meeting' | 'note' | 'form' | 'download'
    | 'login' | 'system' | 'field_change' | 'stage_move';
  /** Deal this belongs to; fills the deal timeline. */
  dealId?: string;
  /** Person this belongs to; fills their Activity tab. */
  clientId?: string;
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
  const args = [
    event.action,
    event.entityType,
    event.entityId ?? null,
    event.projectId ?? null,
    JSON.stringify(event.context ?? {}),
  ];

  // The CRM columns go through the eight-argument overload (migration 003500).
  // A database that has not caught up yet still gets the row — without the deal
  // and person relations, which is a poorer timeline rather than a lost event.
  const wantsCrm = Boolean(event.kind || event.dealId || event.clientId);
  const { rows } = await withClaims(claims, async (c) => {
    if (wantsCrm) {
      try {
        return await c.query<{ id: number }>(
          'select public.log_audit_event($1, $2, $3, $4, $5, $6, $7, $8) as id',
          [...args, event.kind ?? null, event.dealId ?? null, event.clientId ?? null]
        );
      } catch (error) {
        // 42883 is 'no function matches' — the only failure worth degrading on.
        if ((error as { code?: string })?.code !== '42883') throw error;
      }
    }
    return c.query<{ id: number }>(
      'select public.log_audit_event($1, $2, $3, $4, $5) as id',
      args
    );
  });
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
