import type { PoolClient, QueryResultRow } from 'pg';

/**
 * A query for something a *newer* migration introduced.
 *
 * The database and the deployment move separately here: code ships to Vercel the
 * moment it is pushed, while the SQL is pasted into a console by a person, maybe
 * an hour later. In that window the app is newer than the schema — and a panel
 * belonging to the newest module must not take down a page that has worked for
 * months. A project page losing its 'asks' card is a blemish; a project page
 * returning "Application error" is a PM unable to work.
 *
 * So: a missing table, column, function or type degrades to an empty result and
 * a server-log line naming the fix. Every other error still throws, because a
 * genuine bug must stay loud.
 *
 * The savepoint is the whole trick. Every query in this app runs inside a
 * transaction (src/lib/db.ts opens one to carry the RLS claims), and in
 * PostgreSQL a single failed statement aborts the entire transaction — every
 * later query returns 25P02 "current transaction is aborted". Catching the
 * error is therefore not enough: the transaction has to be rewound to the point
 * just before the attempt, or the page dies anyway on its next query.
 */

/** Undefined table / column / function / object — the schema is behind. */
const SCHEMA_BEHIND = new Set(['42P01', '42703', '42883', '42704']);

const warned = new Set<string>();
let counter = 0;

export async function optionalRows<T extends QueryResultRow = QueryResultRow>(
  client: PoolClient,
  what: string,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  // Name is generated, never interpolated from input — savepoint names cannot
  // be parameterised.
  const savepoint = `sf_optional_${(counter = (counter + 1) % 1_000_000)}`;
  await client.query(`savepoint ${savepoint}`);

  try {
    const { rows } = await client.query<T>(sql, params);
    await client.query(`release savepoint ${savepoint}`);
    return rows;
  } catch (error) {
    // Rewind, so the caller's remaining queries still work.
    await client.query(`rollback to savepoint ${savepoint}`).catch(() => undefined);

    const code = (error as { code?: string }).code;
    if (!code || !SCHEMA_BEHIND.has(code)) throw error;

    // Once per process per feature: enough to diagnose, not enough to drown
    // the log on every request.
    if (!warned.has(what)) {
      warned.add(what);
      console.warn(
        `[schema behind] ${what} is unavailable (${code}: ${(error as Error).message}). ` +
          `The database is missing part of a recent migration — run the newest file in ` +
          `db/dist/ in the SQL editor. Continuing without it.`
      );
    }
    return [];
  }
}
