import { NextResponse } from 'next/server';
import { isSchemaDrift, type PgError } from './db-drift';

export { isSchemaDrift } from './db-drift';

/**
 * Turns a database failure into a message that names the actual cause.
 * 'Could not create the project (500)' costs more time than it saves: these
 * endpoints are staff-only, so the response carries PostgreSQL's own error
 * text, and schema drift (a migration not yet applied) says exactly what to
 * do about it.
 */

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
      `Open Admin → Database and click Apply, then try again.`
    : `${action} failed: ${detail} (${code}).`;

  return NextResponse.json({ error: message, dbCode: code }, { status: 500 });
}
