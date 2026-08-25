import { Pool, types, type PoolClient } from 'pg';
import type { UserRole } from './auth/roles';

/**
 * A `date` column comes back as the text the database holds — '2026-08-16' —
 * and not as a JavaScript Date.
 *
 * node-postgres parses date columns into a Date at *local* midnight by default,
 * which is wrong twice over. A calendar date has no time and no zone, so
 * turning it into an instant invents both: run the app in a UTC-negative zone
 * and a survey completed on the 16th starts printing as the 15th. And a Date
 * that reaches a form stringifies as 'Sun Aug 16 2026 00:00:00 GMT+0000 (…)',
 * which an <input type="date"> cannot display at all — it renders an empty box,
 * so a PM who reopened a finished stage saw every date they had entered gone.
 *
 * Registered here because this module is the only door to the database, so
 * every query in the app — including `select *` into a form — gets the same
 * shape. Timestamps are left as Date objects: those really are instants.
 */
types.setTypeParser(types.builtins.DATE, (value) => value);

/**
 * Plain-Postgres data access. Every query runs inside a transaction that
 * (1) sets `request.jwt.claims` to the caller's session claims and
 * (2) SET LOCAL ROLE authenticated,
 * so the RLS policies from the migrations keep enforcing the §2 matrix in
 * the database itself — including when DATABASE_URL is a privileged user.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Claims {
  sub?: string;
  role?: 'authenticated';
  user_role?: UserRole;
  email?: string;
}

declare global {
  // Reused across hot reloads / route invocations.
  var __pmPool: Pool | undefined;
}

function getPool(): Pool {
  if (!globalThis.__pmPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is required.');
    }
    globalThis.__pmPool = new Pool({
      connectionString,
      max: 10,
      ssl:
        process.env.DATABASE_SSL === 'require'
          ? { rejectUnauthorized: false }
          : undefined,
    });
  }
  return globalThis.__pmPool;
}

/** Run `fn` in a transaction carrying the given identity claims. */
export async function withClaims<T>(
  claims: Claims,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(claims),
    ]);
    await client.query('set local role authenticated');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** No user identity (login flows, grant-token paths). RLS still applies. */
export function withAnon<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withClaims({}, fn);
}

export interface SessionIdentity {
  userId: string;
  email: string | null;
  role: UserRole;
}

/** Queries on behalf of a signed-in user — their §2 slice, nothing more. */
export function withUser<T>(
  identity: SessionIdentity,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  return withClaims(
    {
      sub: identity.userId,
      role: 'authenticated',
      user_role: identity.role,
      email: identity.email ?? undefined,
    },
    fn
  );
}
