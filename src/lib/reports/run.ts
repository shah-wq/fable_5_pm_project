import { withUser, type SessionIdentity } from '../db';
import { sanitizeDefinition, type ReportDefinition } from './definition';
import { visibleFields } from './fields';
import { buildReportQuery } from './query';
import { summarise, type ReportResult } from './summarise';

/**
 * Runs a report definition for a session: sanitize → build → execute →
 * summarise. Preview asks for 50 rows for instant feedback; an export asks for
 * more. Everything runs under the caller's claims, so a report shared with a
 * lower-privileged user returns their permitted rows, not the author's
 * (spec §8).
 */

export const PREVIEW_ROWS = 50;
export const EXPORT_ROW_CAP = 20000;

export function allowedKeysFor(session: SessionIdentity, includeInternalNotes: boolean): Set<string> {
  return new Set(visibleFields(session.role, includeInternalNotes).map((f) => f.key));
}

export async function runReport(
  session: SessionIdentity,
  rawDefinition: unknown,
  options: { limit?: number } = {}
): Promise<{ result: ReportResult; definition: ReportDefinition; durationMs: number }> {
  const started = Date.now();
  // The notes flag is honoured only for roles that may see notes at all; the
  // key set is what the generator will accept, so a gated field simply is not
  // resolvable no matter what the definition asks for.
  const wantsNotes = (rawDefinition as { includeInternalNotes?: boolean } | null)?.includeInternalNotes === true;
  const allowed = allowedKeysFor(session, wantsNotes);
  const definition = sanitizeDefinition(rawDefinition, allowed);

  const built = buildReportQuery(definition, {
    userId: session.userId,
    limit: options.limit ?? PREVIEW_ROWS,
    allowedFieldKeys: allowed,
  });

  const { rows, total } = await withUser(session, async (client) => {
    const data = await client.query(built.sql, built.params);
    const count = await client.query<{ n: number }>(built.countSql, built.countParams);
    return { rows: data.rows, total: count.rows[0]?.n ?? data.rows.length };
  });

  return {
    result: summarise(definition, built, rows, total),
    definition,
    durationMs: Date.now() - started,
  };
}

/** Run history — who ran or exported what, for when a number is disputed. */
export async function recordRun(
  session: SessionIdentity,
  entry: {
    reportId?: string | null;
    reportName: string;
    format: 'preview' | 'xlsx' | 'csv' | 'print' | 'schedule';
    rowCount: number;
    durationMs?: number;
  }
): Promise<void> {
  await withUser(session, (client) =>
    client.query(
      `insert into public.report_runs
         (report_id, report_name, ran_by, format, row_count, duration_ms)
       values ($1, $2, $3, $4, $5, $6)`,
      [entry.reportId ?? null, entry.reportName.slice(0, 200), session.userId,
       entry.format, entry.rowCount, entry.durationMs ?? null]
    )
  ).catch(() => undefined);
}
