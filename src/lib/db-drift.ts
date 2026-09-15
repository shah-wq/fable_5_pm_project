/**
 * Telling "the database has not caught up" apart from "this is our bug".
 *
 * Kept apart from db-error.ts, which pulls in Next's server runtime: this
 * decision is pure and the unit tests want it without booting a framework. Both
 * mistakes it guards against have already been made here — a report-builder bug
 * that told the operator to run migrations, and an enum value the database did
 * not have yet that arrived as a bare 500 with no hint at all.
 */

export interface PgError {
  code?: string;
  message?: string;
  detail?: string;
  column?: string;
  table?: string;
  constraint?: string;
}

/** Missing table / missing column / undefined function / undefined type. */
export const DRIFT_CODES = new Set(['42P01', '42703', '42883', '42704']);

/**
 * 42P01 is also what Postgres returns for a query that names an alias it never
 * put in the FROM clause — a bug in the query builder, not a migration the
 * operator forgot. Telling them to run catch-up SQL for it sends them to the SQL
 * editor to fix something that is not broken there.
 */
const NOT_DRIFT = /missing FROM-clause entry/i;

/**
 * The other shape of drift: a value the code knows about that the database's
 * enum type does not have yet — 'sales' before the file that adds it has been
 * run. Postgres reports it as 22P02, which is also the code for a malformed uuid
 * or a bad number, so the message has to decide. Those are real bugs and must
 * keep throwing.
 */
const MISSING_ENUM_VALUE = /invalid input value for enum/i;

export function isMissingEnumValue(error: unknown): boolean {
  const e = (error ?? {}) as PgError;
  return String(e.code) === '22P02' && MISSING_ENUM_VALUE.test(e.message ?? '');
}

export function isSchemaDrift(error: unknown): boolean {
  const e = (error ?? {}) as PgError;
  if (isMissingEnumValue(error)) return true;
  if (!DRIFT_CODES.has(String(e.code))) return false;
  return !NOT_DRIFT.test(e.message ?? '');
}
