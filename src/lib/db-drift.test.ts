import assert from 'node:assert/strict';
import test from 'node:test';
import { isSchemaDrift } from './db-drift.ts';

/**
 * Which failures mean "the database has not caught up" and which do not.
 *
 * The distinction matters because the two answers send somebody to different
 * places: drift sends them to the SQL editor, and everything else is ours to
 * fix. Both mistakes have been made here already — a report builder bug that
 * told the operator to run migrations, and a missing enum value that arrived as
 * a bare 500 with no hint at all.
 */

test('a missing table, column, function or type is drift', () => {
  for (const code of ['42P01', '42703', '42883', '42704']) {
    assert.equal(isSchemaDrift({ code, message: 'relation "x" does not exist' }), true, code);
  }
});

test('an enum value the database does not have yet is drift', () => {
  assert.equal(
    isSchemaDrift({ code: '22P02', message: 'invalid input value for enum user_role: "sales"' }),
    true
  );
});

test('a malformed uuid is not drift, even though it shares the code', () => {
  assert.equal(
    isSchemaDrift({ code: '22P02', message: 'invalid input syntax for type uuid: "banana"' }),
    false
  );
});

test('a query naming an alias it never joined is not drift', () => {
  assert.equal(
    isSchemaDrift({ code: '42P01', message: 'missing FROM-clause entry for table "f"' }),
    false
  );
});

test('an ordinary failure is not drift', () => {
  assert.equal(isSchemaDrift({ code: '23505', message: 'duplicate key value' }), false);
  assert.equal(isSchemaDrift(null), false);
  assert.equal(isSchemaDrift(new Error('socket hang up')), false);
});
