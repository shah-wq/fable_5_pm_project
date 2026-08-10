#!/usr/bin/env node
// Build browser-pasteable bootstrap files from db/migrations for environments
// where running `npm run db:migrate` isn't practical (e.g. the Neon console's
// SQL Editor). Produces db/dist/bootstrap-part1.sql, -part2.sql, -part3.sql:
//
//   part 1 — migrations up to and including 000800 (adds the 'ops' enum value)
//   part 2 — up to and including 001500 (adds the 'complete' enum value)
//   part 3 — the rest, plus schema_migrations records so a later
//            `npm run db:migrate` recognizes everything as applied
//
// Split into parts because a pasted batch may run as a single transaction,
// and PostgreSQL forbids USING an enum value in the transaction that added it
// — each split point sits right after an `alter type … add value`.
//
// Usage: node scripts/build-sql-bootstrap.mjs

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'db', 'migrations');
const distDir = join(root, 'db', 'dist');

// Each entry is the last migration of a part; the final part takes the rest.
const SPLIT_AFTER = [
  '20260803000800_add_ops_role.sql',
  '20260803001500_complete_hold_cancel.sql',
];

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

const groups = [];
let start = 0;
for (const splitFile of SPLIT_AFTER) {
  const i = files.indexOf(splitFile);
  if (i === -1) throw new Error(`split point ${splitFile} not found`);
  groups.push(files.slice(start, i + 1));
  start = i + 1;
}
groups.push(files.slice(start));

const total = groups.length;
const header = (n, contents) => `-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
-- Bootstrap part ${n} of ${total} for a fresh database via a SQL console (e.g. Neon SQL Editor).
-- Run the parts in order, each as its own execution.
-- Includes: ${contents}
-- ============================================================================

`;

async function concat(names) {
  const parts = [];
  for (const name of names) {
    parts.push(`-- >>> ${name}\n`);
    parts.push(await readFile(join(migrationsDir, name), 'utf8'));
    parts.push('\n');
  }
  return parts.join('\n');
}

const tracking = `-- >>> migration bookkeeping (lets \`npm run db:migrate\` skip these later)
create table if not exists public.schema_migrations (
  name       text primary key,
  applied_at timestamptz not null default now()
);
insert into public.schema_migrations (name) values
${files.map((f) => `  ('${f}')`).join(',\n')}
on conflict (name) do nothing;
`;

await mkdir(distDir, { recursive: true });
for (let n = 1; n <= total; n++) {
  const names = groups[n - 1];
  const last = n === total;
  const body =
    header(n, names.join(', ') + (last ? ', migration bookkeeping' : '')) +
    (await concat(names)) +
    (last ? '\n' + tracking : '');
  await writeFile(join(distDir, `bootstrap-part${n}.sql`), body);
  console.log(
    `wrote db/dist/bootstrap-part${n}.sql (${names.length} migrations${last ? ' + bookkeeping' : ''})`
  );
}
