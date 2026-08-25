import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AGGREGATIONS,
  FIELD_BY_KEY,
  JOIN_SQL,
  REPORT_FIELDS,
  allowedAggregations,
  visibleFields,
} from './fields.ts';

/**
 * The registry checks that used to be done by dragging a field onto the canvas.
 *
 * A field whose `needs` names a join with no SQL behind it generates a query
 * referencing an alias that is never in the FROM clause. Postgres calls that
 * 42P01 — the same code as a missing table — so it surfaces to the user as
 * 'the database is missing part of a recent migration', sending them off to run
 * catch-up SQL that cannot possibly help. That is exactly what happened to the
 * seven customer-rating fields: `needs: ['feedback']` with no `feedback` entry
 * in JOIN_SQL. One assertion here is cheaper than the whole trail.
 */

test('every join a field needs has SQL behind it', () => {
  const haveSql = new Set(JOIN_SQL.map((j) => j.key));
  for (const field of REPORT_FIELDS) {
    for (const need of field.needs ?? []) {
      assert.ok(
        haveSql.has(need),
        `${field.key} needs the '${need}' join, which has no entry in JOIN_SQL`
      );
    }
  }
});

test('every join declares the alias its fields use', () => {
  // Each entry ends in the alias it introduces ('… s1 on s1.project_id = p.id',
  // '… ) fb on true'), and the fields that need it must use that alias — a
  // field pointing at the wrong prefix fails the same way as a missing join.
  const aliasOf = new Map<string, string>();
  for (const join of JOIN_SQL) {
    const lateral = /\)\s+(\w+)\s+on\s+true/.exec(join.sql);
    const plain = /join\s+public\.\w+\s+(\w+)\s+on/.exec(join.sql);
    const alias = lateral?.[1] ?? plain?.[1];
    assert.ok(alias, `the '${join.key}' join does not name an alias`);
    aliasOf.set(join.key, alias);
  }

  for (const field of REPORT_FIELDS) {
    const needs = field.needs ?? [];
    if (needs.length === 0) continue;
    // p.* is the projects table itself, always in scope.
    const prefix = /^(\w+)\./.exec(field.sql)?.[1];
    if (!prefix || prefix === 'p') continue;
    const allowed = needs.map((n) => aliasOf.get(n));
    assert.ok(
      allowed.includes(prefix),
      `${field.key} reads '${prefix}.…' but only declares ${JSON.stringify(needs)} ` +
        `(aliases ${JSON.stringify(allowed)})`
    );
  }
});

test('joins that depend on another join come after it', () => {
  const seen = new Set<string>();
  for (const join of JOIN_SQL) {
    if (join.after) {
      assert.ok(
        seen.has(join.after),
        `the '${join.key}' join reads from '${join.after}', which is emitted later`
      );
    }
    seen.add(join.key);
  }
});

test('field keys are unique and reachable by key', () => {
  assert.equal(FIELD_BY_KEY.size, REPORT_FIELDS.length, 'two fields share a key');
});

test('every field offers at least one aggregation, and only real ones', () => {
  for (const field of REPORT_FIELDS) {
    const aggs = allowedAggregations(field);
    assert.ok(aggs.length > 0, `${field.key} can be summarised in no way at all`);
    for (const agg of aggs) {
      assert.ok(AGGREGATIONS.includes(agg), `${field.key} offers unknown aggregate ${agg}`);
    }
  }
});

test('money is admin/finance only, and verbatims need the notes permission', () => {
  const forOps = visibleFields('ops', true).map((f) => f.key);
  const financial = REPORT_FIELDS.filter((f) => f.financial).map((f) => f.key);
  for (const key of financial) {
    assert.ok(!forOps.includes(key), `${key} is financial but reaches ops`);
  }
  // A rating comment is a customer's own words: internal, like a PM's notes.
  assert.ok(!visibleFields('ops', false).some((f) => f.key === 'feedback.comments'));
  assert.ok(visibleFields('ops', true).some((f) => f.key === 'feedback.comments'));
  assert.ok(!visibleFields('finance', true).some((f) => f.key === 'feedback.comments'));
});
