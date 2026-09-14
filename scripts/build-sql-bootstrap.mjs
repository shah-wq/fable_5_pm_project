#!/usr/bin/env node
// Build browser-pasteable bootstrap files from db/migrations for environments
// where running `npm run db:migrate` isn't practical (e.g. the Neon console's
// SQL Editor). Produces db/dist/bootstrap-part1.sql, -part2.sql, -part3.sql:
//
// A part ends at every migration that adds an enum value, and the last part
// also carries the schema_migrations records so a later `npm run db:migrate`
// recognises everything as applied.
//
// Split that way because a pasted batch runs as a single transaction and
// PostgreSQL forbids USING an enum value in the transaction that added it. The
// split points are computed from the migrations themselves rather than listed
// here: they were once a hardcoded pair of filenames, and when a third enum
// migration arrived the generated bundles started failing halfway through an
// upgrade with 'unsafe use of new value'.
//
// Usage: node scripts/build-sql-bootstrap.mjs

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'db', 'migrations');
const distDir = join(root, 'db', 'dist');

const ADDS_ENUM_VALUE = /alter\s+type\s+[\w."]+\s+add\s+value/i;

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

/** Split a list of migrations so no part uses an enum value it also adds. */
async function splitOnEnumBoundaries(names) {
  const parts = [[]];
  for (const name of names) {
    parts[parts.length - 1].push(name);
    const sql = await readFile(join(migrationsDir, name), 'utf8');
    if (ADDS_ENUM_VALUE.test(sql) && name !== names[names.length - 1]) parts.push([]);
  }
  return parts;
}

const groups = await splitOnEnumBoundaries(files);

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
// (the Neon-console workflow). Everything from CATCH_UP_FROM is re-runnable, so
// these pastes can be run repeatedly and in any state.
//
// They are split on enum boundaries, and the split is computed rather than
// listed: PostgreSQL cannot use an enum value in the transaction that added it,
// a pasted script is one transaction, so a migration that adds an enum value
// must be the LAST file in its part. This used to be a hardcoded filename, and
// the day a second enum migration arrived the bundle silently started failing
// with 'unsafe use of new value' halfway through somebody's upgrade.
const CATCH_UP_FROM = '20260803001400_stage_fields.sql';

const catchUp = await splitOnEnumBoundaries(files.slice(files.indexOf(CATCH_UP_FROM)));

const catchUpHeader = (n, names, withTracking) => `-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · catch-up ${n} of ${catchUp.length} · newest migration: ${files[files.length - 1]}
--
-- Paste this whole file into a SQL console (e.g. the Neon SQL Editor) and run
-- it. Safe to run more than once: every statement below skips work already
-- done, so 'already exists' errors cannot happen. NOTICE lines saying
-- 'does not exist, skipping' are normal.
--
-- Run the catch-up files in order, each as its own execution: ${
  Array.from({ length: catchUp.length }, (_, i) => `catch-up-${i + 1}.sql`).join(', ')
}.
-- Each break falls where one script adds a value to an enum and the next uses
-- it, which PostgreSQL will not allow in a single transaction.
-- Includes: ${names.join(', ')}${withTracking ? ', migration bookkeeping' : ''}
-- ============================================================================

`;

for (let n = 1; n <= catchUp.length; n++) {
  const names = catchUp[n - 1];
  const last = n === catchUp.length;
  await writeFile(
    join(distDir, `catch-up-${n}.sql`),
    catchUpHeader(n, names, last) + (await concat(names)) + (last ? '\n' + tracking : '')
  );
  console.log(`wrote db/dist/catch-up-${n}.sql (${names.length} migrations)`);
}

// --- Per-module top-up ------------------------------------------------------
// A database that is already current except for the newest module only needs
// that module. One small paste is less error-prone than re-running twenty
// migrations, and each file is named after its module so a stale copy in a
// browser cache cannot masquerade as the new one.
//
// The catch is that a module can arrive as several scripts that must be pasted
// separately — 003500 refuses to run without 003400, which refuses to run
// without 003300 — and shipping only the last one sends somebody to the SQL
// editor to be told off twice.
//
// So the top-up is the whole of the final catch-up group: everything added
// since the last enum boundary, in order, numbered. Following each file's guard
// backwards instead would be more precise and much worse — the guards name
// 000200 and 001900 as well, and offering those as 'step 1' to a live database
// would be an instruction to re-run the migration that creates every table.
const lastGroup = catchUp[catchUp.length - 1];
const previousGroup = catchUp[catchUp.length - 2] ?? [];
const enumTail = previousGroup[previousGroup.length - 1];
const chain =
  enumTail && ADDS_ENUM_VALUE.test(await readFile(join(migrationsDir, enumTail), 'utf8'))
    ? [enumTail, ...lastGroup]
    : [...lastGroup];

const named = (name) =>
  `${name.slice(0, 14)}-${name.replace(/^\d+_/, '').replace(/\.sql$/, '').replaceAll('_', '-')}.sql`;

for (const [i, name] of chain.entries()) {
  const step = chain.length > 1 ? ` · step ${i + 1} of ${chain.length}` : '';
  const order =
    chain.length > 1
      ? '-- Run these in order, each as its own execution:\n' +
        chain.map((n, k) => `--   ${k + 1}. ${named(n)}`).join('\n') +
        '\n-- Each break is where one script adds something the next one uses, which\n' +
        '-- PostgreSQL will not allow inside a single pasted transaction.\n--\n'
      : '';

  await writeFile(
    join(distDir, named(name)),
    `-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with: node scripts/build-sql-bootstrap.mjs
--
--   SolarFlow PM · newest module${step} · ${name}
--
-- For a database that is already up to date apart from this module. Paste the
-- whole file into a SQL console (e.g. the Neon SQL Editor) and run it once.
-- Safe to run again: every statement skips work already done, so 'already
-- exists' errors cannot happen. NOTICE lines saying 'does not exist, skipping'
-- are normal.
--
${order}-- Behind by more than this module? Run every db/dist/catch-up-*.sql in order
-- instead — they cover everything from 001400 onwards.
-- ============================================================================

-- >>> ${name}
${await readFile(join(migrationsDir, name), 'utf8')}
${i === chain.length - 1 ? '\n' + tracking : ''}`
  );
  console.log(`wrote db/dist/${named(name)}${step}`);
}
