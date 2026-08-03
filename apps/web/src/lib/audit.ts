import type { Json } from './database.types';
import type { TypedClient } from './supabase/types';

/**
 * Audit-log writer — the shared utility every module calls for events that
 * aren't plain row DML (those are captured automatically by the `audit_row`
 * database triggers).
 *
 * Wraps the `public.log_audit_event` RPC (SECURITY DEFINER): the actor's
 * identity and role are taken from the caller's JWT inside the database, so
 * entries can't be written on someone else's behalf, and the audit_log table
 * itself accepts no direct inserts, updates, or deletes from clients.
 */

export interface AuditEvent {
  /** Verb, dot-namespaced by module: 'design.shared', 'permit.packet_downloaded', ... */
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

/** Write one audit event. Returns the audit_log row id. */
export async function logAuditEvent(
  supabase: TypedClient,
  event: AuditEvent
): Promise<number> {
  const { data, error } = await supabase.rpc('log_audit_event', {
    p_action: event.action,
    p_entity_type: event.entityType,
    p_entity_id: event.entityId,
    p_project_id: event.projectId,
    p_context: event.context ?? {},
  });
  if (error) {
    throw new Error(`Failed to write audit event '${event.action}': ${error.message}`);
  }
  return data;
}

/**
 * Fire-and-forget variant for hot paths where an audit failure must not break
 * the user-facing operation. Failures are reported to `onError` (default:
 * console.error) instead of throwing.
 */
export async function tryLogAuditEvent(
  supabase: TypedClient,
  event: AuditEvent,
  onError: (error: unknown) => void = (e) => console.error('audit write failed:', e)
): Promise<number | null> {
  try {
    return await logAuditEvent(supabase, event);
  } catch (error) {
    onError(error);
    return null;
  }
}
