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

// --- Catch-up files ---------------------------------------------------------
// For a database that already ran the early migrations and needs topping up
// (the Neon-console workflow). Everything from CATCH_UP_FROM is re-runnable,
// so these two pastes can be run repeatedly and in any state. Two files, not
// one, because PostgreSQL cannot use an enum value the same transaction added
// and a pasted script is one transaction — the split lands on that boundary.
const CATCH_UP_FROM = '20260803001400_stage_fields.sql';
const CATCH_UP_SPLIT = '20260803001500_complete_hold_cancel.sql';

const catchUpAll = files.slice(files.indexOf(CATCH_UP_FROM));
const splitAt = catchUpAll.indexOf(CATCH_UP_SPLIT);
const catchUp = [catchUpAll.slice(0, splitAt + 1), catchUpAll.slice(splitAt + 1)];

const catchUpHeader = (n, names, withTracking) => `-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · catch-up ${n} of 2 · newest migration: ${files[files.length - 1]}
--
-- Paste this whole file into a SQL console (e.g. the Neon SQL Editor) and run
-- it. Safe to run more than once: every statement below skips work already
-- done, so 'already exists' errors cannot happen. NOTICE lines saying
-- 'does not exist, skipping' are normal.
--
-- Run catch-up 1 first, then catch-up 2, each as its own execution.
-- Includes: ${names.join(', ')}${withTracking ? ', migration bookkeeping' : ''}
-- ============================================================================

`;

for (let n = 1; n <= 2; n++) {
  const names = catchUp[n - 1];
  const last = n === 2;
  await writeFile(
    join(distDir, `catch-up-${n}.sql`),
    catchUpHeader(n, names, last) + (await concat(names)) + (last ? '\n' + tracking : '')
  );
  console.log(`wrote db/dist/catch-up-${n}.sql (${names.length} migrations)`);
}

// --- Per-module top-up ------------------------------------------------------
// A database that is already current except for the newest module only needs
// that module. One small paste is less error-prone than re-running ten
// migrations, and the file is named after the module so a stale copy in a
// browser cache cannot masquerade as the new one — the commonest failure of
// this whole workflow.
const newest = files[files.length - 1];
const moduleName = newest.replace(/^\d+_/, '').replace(/\.sql$/, '').replaceAll('_', '-');
const moduleFile = `${newest.slice(0, 14)}-${moduleName}.sql`;

await writeFile(
  join(distDir, moduleFile),
  `-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · newest module only · ${newest}
--
-- For a database that is already up to date apart from this module. Paste the
-- whole file into a SQL console (e.g. the Neon SQL Editor) and run it once.
-- Safe to run again: every statement skips work already done, so 'already
-- exists' errors cannot happen. NOTICE lines saying 'does not exist, skipping'
-- are normal. The bookkeeping row at the end is included.
--
-- Behind by more than this module? Run catch-up-1.sql then catch-up-2.sql
-- instead — they cover everything from 001400 onwards.
-- ============================================================================

-- >>> ${newest}
${await readFile(join(migrationsDir, newest), 'utf8')}

-- >>> migration bookkeeping
create table if not exists public.schema_migrations (
  name       text primary key,
  applied_at timestamptz not null default now()
);
insert into public.schema_migrations (name) values ('${newest}')
on conflict (name) do nothing;
`
);
console.log(`wrote db/dist/${moduleFile} (newest module only)`);
