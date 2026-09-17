#!/usr/bin/env node
/**
 * Cut one migration into numbered parts small enough for a browser SQL editor.
 *
 *   node scripts/split-migration.mjs 20260803003400_crm_foundation.sql 6
 *
 * Why this exists: a hosted SQL console is not psql. It parses the paste itself,
 * shows a tab per statement, and what it does with a 48 KB script containing
 * two hundred statements and forty dollar-quoted function bodies is its own
 * business. When a file that applies cleanly everywhere else appears to do
 * nothing there, the way forward is smaller pastes — each one small enough that
 * the console's own error, whatever it is, lands next to the statement that
 * caused it.
 *
 * Every statement in these migrations is independently idempotent (create … if
 * not exists, add column if not exists, guarded do blocks), so cutting between
 * statements is safe and the parts can be run one after another, or re-run.
 *
 * The cut is made at top-level semicolons only: dollar-quoted bodies ($$ … $$,
 * $tag$ … $tag$), single-quoted strings, double-quoted identifiers, line
 * comments and block comments are all tracked, because a semicolon inside any of
 * them is not the end of anything.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/** Split SQL into top-level statements, keeping each one's trailing text. */
export function splitStatements(sql) {
  const out = [];
  let start = 0;
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];

    // Line comment.
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    // Block comment, which nests in PostgreSQL.
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth += 1; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth -= 1; i += 2; }
        else i += 1;
      }
      continue;
    }
    // Single-quoted string, with '' as the escape.
    if (ch === "'") {
      i += 1;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") { i += 1; break; }
        else i += 1;
      }
      continue;
    }
    // Quoted identifier.
    if (ch === '"') {
      i += 1;
      while (i < n && sql[i] !== '"') i += 1;
      i += 1;
      continue;
    }
    // Dollar-quoted body: $$ … $$ or $tag$ … $tag$.
    if (ch === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? n : close + tag[0].length;
        continue;
      }
    }
    if (ch === ';') {
      out.push(sql.slice(start, i + 1));
      start = i + 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  const tail = sql.slice(start);
  if (tail.trim()) out.push(tail);
  return out;
}

const [file, partsArg] = process.argv.slice(2);
if (!file) {
  console.error('usage: node scripts/split-migration.mjs <migration.sql> [parts]');
  process.exit(1);
}

const sql = readFileSync(join(ROOT, 'db/migrations', file), 'utf8');
const statements = splitStatements(sql);
const wanted = Number(partsArg) || 6;
const perPart = Math.ceil(statements.length / wanted);

const base = file.slice(0, 14) + '-' + file.slice(15).replace(/_/g, '-').replace(/\.sql$/, '');
mkdirSync(join(ROOT, 'db/dist/parts'), { recursive: true });

const chunks = [];
for (let i = 0; i < statements.length; i += perPart) chunks.push(statements.slice(i, i + perPart));

chunks.forEach((chunk, index) => {
  const name = `${base}-part${index + 1}-of-${chunks.length}.sql`;
  const header = `-- ============================================================================
-- GENERATED FILE — do not edit. Rebuild with:
--   node scripts/split-migration.mjs ${file} ${chunks.length}
--
--   ${file} · part ${index + 1} of ${chunks.length}
--
-- The same migration, cut into pieces small enough for a browser SQL console.
-- Run the parts in order, each as its own execution, and stop at the first one
-- that reports an error — that error is the thing worth sending on.
--
-- Safe to run again: every statement skips work already done.
-- ============================================================================

`;
  writeFileSync(join(ROOT, 'db/dist/parts', name), header + chunk.join('') + '\n');
  console.log(`wrote db/dist/parts/${name} (${chunk.length} statements)`);
});
