// ---------------------------------------------------------------------------
// validate.js in isolation — no database, no server. These are the functions that
// decide what reaches the statement binder.
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert');
const {
  validateSyncFields,
  validateImportMode,
  validateExpectedUpdated,
  validatePagination,
  LIMITS,
} = require('../validate');

test('sync fields pass through when they are strings', () => {
  const out = validateSyncFields({
    id: 'q-1',
    created: '2024-01-01T00:00:00.000Z',
    updated: '2025-01-01T00:00:00.000Z',
    name: 'ignored here',
  });

  assert.deepStrictEqual(out, {
    id: 'q-1',
    created: '2024-01-01T00:00:00.000Z',
    updated: '2025-01-01T00:00:00.000Z',
  });
});

test('sync fields are all optional', () => {
  assert.deepStrictEqual(validateSyncFields({}), {});
});

test('a non-string or empty id is rejected before it reaches the binder', () => {
  assert.throws(() => validateSyncFields({ id: 42 }), /"id" must be a string/);
  assert.throws(() => validateSyncFields({ id: '   ' }), /"id" must not be empty/);
  assert.throws(() => validateSyncFields({ id: 'x'.repeat(LIMITS.id + 1) }), /exceeds 200 characters/);
});

test('an oversized timestamp cannot be used to smuggle a payload', () => {
  assert.throws(
    () => validateSyncFields({ updated: 'x'.repeat(LIMITS.timestamp + 1) }),
    /"updated" exceeds 64 characters/,
  );
});

test('import mode defaults to insert and rejects anything unrecognised', () => {
  assert.strictEqual(validateImportMode(undefined), 'insert');
  assert.strictEqual(validateImportMode(null), 'insert');
  assert.strictEqual(validateImportMode('upsert'), 'upsert');
  assert.throws(() => validateImportMode('UPSERT'), /"mode" must be one of/);
  assert.throws(() => validateImportMode(true), /"mode" must be one of/);
});

test('the update precondition is optional but must be a usable string', () => {
  assert.strictEqual(validateExpectedUpdated(undefined), undefined);
  assert.strictEqual(validateExpectedUpdated('2025-01-01T00:00:00.000Z'), '2025-01-01T00:00:00.000Z');
  assert.throws(() => validateExpectedUpdated(1735689600000), /must be a string/);
  assert.throws(() => validateExpectedUpdated(''), /must not be empty/);
});

test('paging defaults to unbounded', () => {
  assert.deepStrictEqual(validatePagination({}), { limit: undefined, offset: undefined });
  assert.deepStrictEqual(validatePagination({ limit: '', offset: '' }), { limit: undefined, offset: undefined });
});

test('paging accepts integers inside the bounds and rejects the rest', () => {
  assert.deepStrictEqual(validatePagination({ limit: '10', offset: '5' }), { limit: 10, offset: 5 });
  assert.deepStrictEqual(validatePagination({ limit: String(LIMITS.pageSize) }).limit, LIMITS.pageSize);
  assert.throws(() => validatePagination({ limit: String(LIMITS.pageSize + 1) }), /between 1 and 1000/);
  assert.throws(() => validatePagination({ limit: '0' }), /between 1 and 1000/);
  assert.throws(() => validatePagination({ offset: '-3' }), /non-negative integer/);
  // Repeated query parameters arrive as an array; it must not be coerced.
  assert.throws(() => validatePagination({ limit: ['1', '2'] }), /non-negative integer/);
});
