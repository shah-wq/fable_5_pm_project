import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { migrationState } from '@/lib/db-migrations';

/**
 * Applying the application's own migrations, from the application.
 *
 * The product is operated from a browser: the code reaches Vercel on push, and
 * the SQL has been pasted into a hosted console by a person. That last step is
 * where the trouble has lived — a console parses the paste itself, shows a tab
 * per statement, and when something in a 48 KB script does not take, it does
 * not reliably say so. Weeks of "the database has not caught up" have come from
 * exactly this.
 *
 * So the application applies them. It has a connection to the right database
 * already (the same one every page uses), the files are bundled into the
 * deployment, and each one is sent to PostgreSQL as a single query — the server
 * parses the script, dollar-quoted bodies and all, and runs it as one
 * transaction. Nothing is split client-side, nothing is pasted, and any error
 * comes back verbatim to the screen that asked.
 *
 * Only the files the catalogue says are missing are applied, in order, stopping
 * at the first failure. Every file is idempotent, so a partial run followed by
 * another click is the intended recovery.
 */

const MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations');

export interface AppliedFile {
  file: string;
  ok: boolean;
  /** PostgreSQL's own message, verbatim, when it refused. */
  error?: string;
  ms: number;
}

/** The migration files bundled with this deployment, in order. */
export function bundledMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{14}_.*\.sql$/.test(f))
    .sort();
}

/**
 * Apply what is missing. Returns one line per file attempted, then the state
 * afterwards so the caller can show both what happened and where that leaves
 * the database.
 */
export async function applyPending(client: PoolClient): Promise<{
  applied: AppliedFile[];
  behind: string[];
}> {
  const before = await migrationState(client);
  const bundled = new Set(bundledMigrations());
  const applied: AppliedFile[] = [];

  for (const file of before.behind) {
    if (!bundled.has(file)) {
      applied.push({ file, ok: false, ms: 0,
        error: 'this deployment does not carry that file — redeploy from the latest main first' });
      break;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const started = Date.now();
    try {
      // One query, no parameters: the simple protocol, so PostgreSQL executes
      // the whole file as a single implicit transaction and parses it itself.
      await client.query(sql);
      // The same bookkeeping `npm run db:migrate` keeps, so the two never
      // disagree about what has been run.
      await client.query(`create table if not exists public.schema_migrations (
        name text primary key, applied_at timestamptz not null default now())`);
      await client.query(
        `insert into public.schema_migrations (name) values ($1) on conflict (name) do nothing`,
        [file]
      );
      applied.push({ file, ok: true, ms: Date.now() - started });
    } catch (error) {
      const e = error as { message?: string; detail?: string; hint?: string; code?: string };
      applied.push({
        file,
        ok: false,
        ms: Date.now() - started,
        error: [e.message, e.detail && `DETAIL: ${e.detail}`, e.hint && `HINT: ${e.hint}`,
                e.code && `(${e.code})`].filter(Boolean).join(' — '),
      });
      break;
    }
  }

  const after = await migrationState(client);
  return { applied, behind: after.behind };
}
