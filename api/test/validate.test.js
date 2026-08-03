// ---------------------------------------------------------------------------
// validate.js in isolation — no database, no server. These are the functions that
// decide what reaches the statement binder.
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert');
const {
  validateQueryPayload,
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

// ---------------------------------------------------------------------------
// Fork lineage.
//
// parentId is bounded by LIMITS.id because it holds the same kind of value the id column
// does, and parentName by LIMITS.name because it is a copy of one. Resolvability is not
// checked here: whether the parent still exists is a question about the store, not about
// the payload, and the answer is allowed to be "no" (see api/db.js on why there is no
// foreign key). Format IS checked — parentId must be a UUID v4, the same rule the SPA's
// validateQuery applies — and a value that fails it is dropped, not rejected; see the
// "silently dropped" tests below for that half of the contract.
// ---------------------------------------------------------------------------

const VALID_PARENT_ID = '11111111-aaaa-4aaa-8aaa-111111111111';

test('accepts a UUID parentId and its parentName', () => {
  const out = validateQueryPayload({
    name: 'n', query: 'q', parentId: VALID_PARENT_ID, parentName: 'Entra risky sign-in',
  });
  assert.strictEqual(out.parentId, VALID_PARENT_ID);
  assert.strictEqual(out.parentName, 'Entra risky sign-in');
});

test('omits lineage fields when absent', () => {
  const out = validateQueryPayload({ name: 'n', query: 'q' });
  assert.ok(!('parentId' in out));
  assert.ok(!('parentName' in out));
});

test('rejects a parentId over the id limit', () => {
  assert.throws(
    () => validateQueryPayload({ name: 'n', query: 'q', parentId: 'x'.repeat(LIMITS.id + 1) }),
    /"parentId" exceeds 200 characters/,
  );
});

test('rejects a parentName over the name limit', () => {
  assert.throws(
    () => validateQueryPayload({ name: 'n', query: 'q', parentName: 'x'.repeat(LIMITS.name + 1) }),
    /"parentName" exceeds 200 characters/,
  );
});

test('rejects a non-string parentId', () => {
  assert.throws(
    () => validateQueryPayload({ name: 'n', query: 'q', parentId: 42 }),
    /"parentId" must be a string/,
  );
  assert.throws(
    () => validateQueryPayload({ name: 'n', query: 'q', parentId: { id: 'x' } }),
    /"parentId" must be a string/,
  );
});

test('a lineage pointer to a query that does not exist is still a valid payload', () => {
  // Deliberate: validation says nothing about resolvability, only format. An import
  // carrying a fork whose parent was never exported must still be storable — the pointer
  // just has to look like an id, which every id in this store does.
  const unresolvedButWellFormed = '99999999-bbbb-4bbb-8bbb-999999999999';
  const out = validateQueryPayload({
    name: 'n', query: 'q', parentId: unresolvedButWellFormed, parentName: 'Gone',
  });
  assert.strictEqual(out.parentId, unresolvedButWellFormed);
});

test('lineage survives a partial (PUT) payload', () => {
  const out = validateQueryPayload({ parentId: VALID_PARENT_ID }, { partial: true });
  assert.strictEqual(out.parentId, VALID_PARENT_ID);
});

test('lineage is not folded into the metadata document', () => {
  const out = validateQueryPayload({
    name: 'n', query: 'q', parentId: VALID_PARENT_ID, parentName: 'Parent', severity: 'High',
  });
  const metadata = JSON.parse(JSON.stringify(out.metadata));
  assert.ok(!('parentId' in metadata), 'parentId must not enter the v4 metadata blob');
  assert.ok(!('parentName' in metadata), 'parentName must not enter the v4 metadata blob');
  assert.strictEqual(metadata.severity, 'High');
});

// ---------------------------------------------------------------------------
// A non-UUID parentId — the format half of the rule. See docs/schema.md and the comment
// on this block in validate.js for why dropping beats rejecting.
// ---------------------------------------------------------------------------

test('a non-UUID parentId does not reject the payload — it is dropped, not stored', () => {
  const out = validateQueryPayload({
    name: 'n', query: 'q', parentId: 'not-a-uuid', parentName: 'Should vanish with it',
  });
  assert.ok(!('parentId' in out), 'a non-UUID pointer must not reach the row');
  assert.ok(!('parentName' in out), 'the paired name is dropped along with a bad parentId');
  // The rest of a good payload is unaffected — one bad pointer must not cost the record.
  assert.strictEqual(out.name, 'n');
  assert.strictEqual(out.query, 'q');
});

test('a non-UUID parentId is dropped even with no parentName riding along', () => {
  const out = validateQueryPayload({ name: 'n', query: 'q', parentId: 'legacy-id-42' });
  assert.ok(!('parentId' in out));
});

test('parentName alone (no parentId in the payload at all) is still accepted', () => {
  // Distinct from the case above: here parentId was never sent, so there is no pointer to
  // fail format on. A partial PUT touching only the name snapshot must still work.
  const out = validateQueryPayload({ parentName: 'Stale label' }, { partial: true });
  assert.strictEqual(out.parentName, 'Stale label');
});

test('the description bound matches the SPA, which has always allowed 10 000 characters', () => {
  // These bounds were retrofitted in f29873c when mutations moved behind the API, at 1 000
  // characters — a tenth of what src/domain/validate.js allows and less than the stored data
  // already contained. The mismatch made every long-described query unsaveable: incrementing
  // usageCount on copy became a 400, and the SPA fell back to localStorage-only.
  assert.strictEqual(LIMITS.description, 10000);
  const long = 'x'.repeat(3031); // the longest description in the live store
  assert.strictEqual(validateQueryPayload({ name: 'n', query: 'q', description: long }).description, long);
  assert.throws(
    () => validateQueryPayload({ name: 'n', query: 'q', description: 'x'.repeat(LIMITS.description + 1) }),
    /"description" exceeds 10000 characters/,
  );
});
