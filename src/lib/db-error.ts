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

export function isSchemaDrift(error: unknown): boolean {
  return DRIFT_CODES.has(String((error as PgError)?.code));
}

export function dbErrorResponse(error: unknown, action: string): NextResponse {
  const e = (error ?? {}) as PgError;
  const code = e.code ?? 'unknown';
  const detail = [e.message, e.detail].filter(Boolean).join(' — ') || String(error);

  console.error(`[db] ${action} failed:`, code, detail);

  const message = isSchemaDrift(error)
    ? `${action} failed because the database is missing part of a recent migration: ${detail} (${code}). ` +
      `Run db/dist/catch-up-1.sql then catch-up-2.sql in the SQL editor, then try again.`
    : `${action} failed: ${detail} (${code}).`;

  return NextResponse.json({ error: message, dbCode: code }, { status: 500 });
}
