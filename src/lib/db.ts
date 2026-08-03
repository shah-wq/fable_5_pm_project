import { Pool, type PoolClient } from 'pg';
import type { UserRole } from './auth/roles';

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
