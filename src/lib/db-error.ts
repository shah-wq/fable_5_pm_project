import { NextResponse } from 'next/server';

/**
 * Turns a database failure into a message that names the actual cause.
 * 'Could not create the project (500)' costs more time than it saves: these
 * endpoints are staff-only, so the response carries PostgreSQL's own error
 * text, and schema drift (a migration not yet applied) says exactly what to
 * do about it.
 */

interface PgError {
  code?: string;
  message?: string;
  detail?: string;
  column?: string;
  table?: string;
  constraint?: string;
}

/** Missing table / missing column / undefined function: the deployed code is
 *  ahead of the database. */
const DRIFT_CODES = new Set(['42P01', '42703', '42883', '42704']);

/**
 * 42P01 is also what Postgres returns for a query that names an alias it never
 * put in the FROM clause — which is a bug in the query builder, not a migration
 * the operator forgot. Telling them to run catch-up SQL for it sends them to
 * the SQL editor to fix something that is not broken there; the report builder
 * did exactly this when a field declared a join that had no SQL behind it.
 */
const NOT_DRIFT = /missing FROM-clause entry/i;

export function isSchemaDrift(error: unknown): boolean {
  const e = (error ?? {}) as PgError;
  if (!DRIFT_CODES.has(String(e.code))) return false;
  return !NOT_DRIFT.test(e.message ?? '');
}

export function dbErrorResponse(error: unknown, action: string): NextResponse {
  const e = (error ?? {}) as PgError;
  const code = e.code ?? 'unknown';
  const detail = [e.message, e.detail].filter(Boolean).join(' — ') || String(error);

  console.error(`[db] ${action} failed:`, code, detail);

  // 42501 is RLS or a definer function saying no. That is not a server fault —
  // it is the answer — so it must not arrive as a 500. A customer who tapped a
  // rating on somebody else's project got 'Saving your rating failed … (42501)'
  // with a 500 attached, which reads to every client, log and status page as a
  // broken app rather than a refused request.
  //
  // The wording still comes from the database where the database wrote one: the
  // definer functions raise sentences meant to be read ('you may only edit your
  // own messages'), and replacing those with a house phrase would throw away
  // the only part that tells somebody what to do differently. A bare RLS
  // rejection is the opposite — it names tables and policies — so that one is
  // answered generically.
  if (code === '42501') {
    const authored =
      e.message && !/row-level security|permission denied for/i.test(e.message)
        ? e.message.charAt(0).toUpperCase() + e.message.slice(1)
        : `${action} is not allowed for this account.`;
    return NextResponse.json({ error: authored, dbCode: code }, { status: 403 });
  }

  const message = isSchemaDrift(error)
    ? `${action} failed because the database is missing part of a recent migration: ${detail} (${code}). ` +
      `Run db/dist/catch-up-1.sql then catch-up-2.sql in the SQL editor, then try again.`
    : `${action} failed: ${detail} (${code}).`;

  return NextResponse.json({ error: message, dbCode: code }, { status: 500 });
}
