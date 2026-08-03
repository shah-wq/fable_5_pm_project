#!/usr/bin/env node
// Apply db/migrations/*.sql in order against DATABASE_URL, tracking applied
// files in public.schema_migrations. Each migration runs in its own
// transaction. Run as a privileged database user (it creates roles/schemas).
//
// Usage: DATABASE_URL=postgres://... npm run db:migrate

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Set DATABASE_URL to a postgres connection string.');
  process.exit(1);
}

const client = new pg.Client({
  connectionString,
  ssl: process.env.DATABASE_SSL === 'require' ? { rejectUnauthorized: false } : undefined,
});
await client.connect();

try {
  await client.query(`
    create table if not exists public.schema_migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const applied = new Set(
    (await client.query('select name from public.schema_migrations')).rows.map((r) => r.name)
  );

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    process.stdout.write(`applying ${file} ... `);
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into public.schema_migrations (name) values ($1)', [file]);
      await client.query('commit');
      console.log('ok');
      ran += 1;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      console.log('FAILED');
      console.error(error.message);
      process.exit(1);
    }
  }

  console.log(ran === 0 ? 'nothing to do — schema is up to date' : `applied ${ran} migration(s)`);
} finally {
  await client.end();
}
