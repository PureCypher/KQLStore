const test = require('node:test');
const assert = require('node:assert');
const { validateSchemaPayload } = require('../validate');

test('accepts a minimal schema', () => {
  const out = validateSchemaPayload({ name: 'SigninLogs', columns: [{ name: 'TimeGenerated', type: 'datetime' }] });
  assert.strictEqual(out.name, 'SigninLogs');
  assert.deepStrictEqual(JSON.parse(out.columns), [{ name: 'TimeGenerated', type: 'datetime' }]);
  assert.strictEqual(out.notes, '');
  assert.strictEqual(out.source, 'getschema');
});

test('requires a name', () => {
  assert.throws(() => validateSchemaPayload({ columns: [] }), /"name" is required/);
});

test('rejects a non-array columns value', () => {
  assert.throws(() => validateSchemaPayload({ name: 'T', columns: 'nope' }), /"columns" must be an array/);
});

test('rejects a column without a name', () => {
  assert.throws(
    () => validateSchemaPayload({ name: 'T', columns: [{ type: 'string' }] }),
    /every column needs a "name"/,
  );
});

test('defaults a missing column type rather than rejecting', () => {
  const out = validateSchemaPayload({ name: 'T', columns: [{ name: 'Foo' }] });
  assert.deepStrictEqual(JSON.parse(out.columns), [{ name: 'Foo', type: 'unknown' }]);
});

test('rejects more than 500 columns', () => {
  const columns = Array.from({ length: 501 }, (_, i) => ({ name: `c${i}`, type: 'string' }));
  assert.throws(() => validateSchemaPayload({ name: 'T', columns }), /"columns" exceeds 500 entries/);
});

test('rejects an unknown source', () => {
  assert.throws(() => validateSchemaPayload({ name: 'T', columns: [], source: 'guesswork' }), /"source" must be one of/);
});

test('rejects notes over the limit', () => {
  assert.throws(
    () => validateSchemaPayload({ name: 'T', columns: [], notes: 'x'.repeat(5001) }),
    /"notes" exceeds 5000 characters/,
  );
});

test('strips unknown column keys', () => {
  const out = validateSchemaPayload({ name: 'T', columns: [{ name: 'A', type: 'string', evil: 1 }] });
  assert.deepStrictEqual(JSON.parse(out.columns), [{ name: 'A', type: 'string' }]);
});
