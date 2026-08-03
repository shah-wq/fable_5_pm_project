#!/usr/bin/env node
// Build browser-pasteable bootstrap files from db/migrations for environments
// where running `npm run db:migrate` isn't practical (e.g. the Neon console's
// SQL Editor). Produces db/dist/bootstrap-part1.sql and -part2.sql:
//
//   part 1 — migrations up to and including 000800 (adds the 'ops' enum value)
//   part 2 — the rest, plus schema_migrations records so a later
//            `npm run db:migrate` recognizes everything as applied
//
// Two parts because a pasted batch may run as a single transaction, and
// PostgreSQL forbids USING an enum value in the transaction that added it.
//
// Usage: node scripts/build-sql-bootstrap.mjs

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'db', 'migrations');
const distDir = join(root, 'db', 'dist');

const SPLIT_AFTER = '20260803000800_add_ops_role.sql';

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
const splitIndex = files.indexOf(SPLIT_AFTER);
if (splitIndex === -1) throw new Error(`split point ${SPLIT_AFTER} not found`);

const header = (part, contents) => `-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
-- Bootstrap ${part} for a fresh database via a SQL console (e.g. Neon SQL Editor).
-- Run part 1 first, then part 2, each as its own execution.
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

const part1Files = files.slice(0, splitIndex + 1);
const part2Files = files.slice(splitIndex + 1);

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
await writeFile(
  join(distDir, 'bootstrap-part1.sql'),
  header('part 1 of 2', part1Files.join(', ')) + (await concat(part1Files))
);
await writeFile(
  join(distDir, 'bootstrap-part2.sql'),
  header('part 2 of 2', part2Files.join(', ') + ', migration bookkeeping') +
    (await concat(part2Files)) +
    '\n' +
    tracking
);

console.log(`wrote db/dist/bootstrap-part1.sql (${part1Files.length} migrations)`);
console.log(`wrote db/dist/bootstrap-part2.sql (${part2Files.length} migrations + bookkeeping)`);
