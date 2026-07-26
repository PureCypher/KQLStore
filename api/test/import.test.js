// ---------------------------------------------------------------------------
// POST /api/queries/import — insert (default) and upsert (opt-in) semantics.
//
// The regression these guard: the SPA pushes offline work through this endpoint, and
// under INSERT OR IGNORE every edit to an id the server already held was discarded
// while the response still said success.
// ---------------------------------------------------------------------------

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { useTempDatabase, startServer, api, makeQuery } = require('./helpers');

useTempDatabase();
const app = require('../app');

let base;
let stop;

before(async () => {
  const server = await startServer(app);
  base = server.url;
  stop = server.close;
});

after(async () => {
  await stop();
});

const importQueries = (queries, extra = {}) =>
  api(base, '/api/queries/import', { method: 'POST', body: { queries, ...extra } });

const seed = (id, updated, overrides = {}) => makeQuery({
  id,
  created: '2024-01-01T00:00:00.000Z',
  updated,
  ...overrides,
});

test('default mode inserts new rows and reports them', async () => {
  const res = await importQueries([seed('insert-1', '2024-05-01T00:00:00.000Z')]);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.mode, 'insert');
  assert.strictEqual(res.body.inserted, 1);
  assert.strictEqual(res.body.imported, 1);
  assert.deepStrictEqual(res.body.results, [{ index: 0, id: 'insert-1', outcome: 'inserted' }]);
});

test('default mode leaves an existing row untouched and says so', async () => {
  await importQueries([seed('insert-2', '2024-05-01T00:00:00.000Z', { name: 'Original' })]);

  const res = await importQueries([
    seed('insert-2', '2025-01-01T00:00:00.000Z', { name: 'Edited offline' }),
  ]);

  assert.strictEqual(res.body.imported, 0);
  assert.strictEqual(res.body.skippedExisting, 1);
  assert.strictEqual(res.body.results[0].outcome, 'skipped-existing');

  const stored = await api(base, '/api/queries/insert-2');
  assert.strictEqual(stored.body.name, 'Original');
});

test('upsert applies an edit whose timestamp is newer than the stored row', async () => {
  await importQueries([seed('upsert-1', '2024-05-01T00:00:00.000Z', { name: 'Original' })]);

  const res = await importQueries(
    [seed('upsert-1', '2025-01-01T00:00:00.000Z', { name: 'Edited offline', tags: ['identity', 'sync'] })],
    { mode: 'upsert' },
  );

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.mode, 'upsert');
  assert.strictEqual(res.body.updated, 1);
  assert.strictEqual(res.body.inserted, 0);
  assert.strictEqual(res.body.imported, 1);
  assert.strictEqual(res.body.results[0].outcome, 'updated');

  const stored = await api(base, '/api/queries/upsert-1');
  assert.strictEqual(stored.body.name, 'Edited offline');
  assert.deepStrictEqual(stored.body.tags, ['identity', 'sync']);
  assert.strictEqual(stored.body.updated, '2025-01-01T00:00:00.000Z');
});

test('upsert refuses an older edit — a stale tab cannot roll the server back', async () => {
  await importQueries([seed('upsert-2', '2025-06-01T00:00:00.000Z', { name: 'Server truth' })]);

  const res = await importQueries(
    [seed('upsert-2', '2024-01-02T00:00:00.000Z', { name: 'Ancient tab' })],
    { mode: 'upsert' },
  );

  assert.strictEqual(res.body.skippedOlder, 1);
  assert.strictEqual(res.body.imported, 0);
  assert.strictEqual(res.body.results[0].outcome, 'skipped-older');

  const stored = await api(base, '/api/queries/upsert-2');
  assert.strictEqual(stored.body.name, 'Server truth');
});

test('upsert is idempotent — replaying the same timestamp changes nothing', async () => {
  const item = seed('upsert-3', '2025-02-01T00:00:00.000Z', { name: 'Same' });
  await importQueries([item], { mode: 'upsert' });

  const res = await importQueries([item], { mode: 'upsert' });

  assert.strictEqual(res.body.updated, 0);
  assert.strictEqual(res.body.skippedOlder, 1);
});

test('upsert compares instants, not strings — an offset timestamp still wins', async () => {
  // 09:00+01:00 is 08:00Z, an hour after the stored 07:00Z, but sorts before it lexically.
  await importQueries([seed('upsert-tz', '2025-03-01T07:00:00.000Z', { name: 'Stored' })]);

  const res = await importQueries(
    [seed('upsert-tz', '2025-03-01T09:00:00.000+01:00', { name: 'Newer with offset' })],
    { mode: 'upsert' },
  );

  assert.strictEqual(res.body.updated, 1);
  const stored = await api(base, '/api/queries/upsert-tz');
  assert.strictEqual(stored.body.name, 'Newer with offset');
});

test('upsert never overwrites on an unparseable incoming timestamp', async () => {
  await importQueries([seed('upsert-bad-ts', '2025-03-01T00:00:00.000Z', { name: 'Stored' })]);

  const res = await importQueries(
    [seed('upsert-bad-ts', 'not-a-date', { name: 'Junk timestamp' })],
    { mode: 'upsert' },
  );

  assert.strictEqual(res.body.skippedOlder, 1);
  const stored = await api(base, '/api/queries/upsert-bad-ts');
  assert.strictEqual(stored.body.name, 'Stored');
});

test('upsert keeps the original created date and the higher usage count', async () => {
  await importQueries([
    seed('upsert-4', '2025-01-01T00:00:00.000Z', { usageCount: 10 }),
  ]);

  await importQueries(
    [makeQuery({
      id: 'upsert-4',
      created: '2030-01-01T00:00:00.000Z',
      updated: '2025-09-01T00:00:00.000Z',
      usageCount: 3,
    })],
    { mode: 'upsert' },
  );

  const stored = await api(base, '/api/queries/upsert-4');
  assert.strictEqual(stored.body.created, '2024-01-01T00:00:00.000Z');
  assert.strictEqual(stored.body.usageCount, 10);
});

test('upsert inserts ids the server has never seen', async () => {
  const res = await importQueries(
    [seed('upsert-new', '2025-01-01T00:00:00.000Z')],
    { mode: 'upsert' },
  );

  assert.strictEqual(res.body.inserted, 1);
  assert.strictEqual(res.body.results[0].outcome, 'inserted');
});

test('an unknown mode is rejected rather than silently falling back to insert', async () => {
  const res = await importQueries([seed('mode-typo', '2025-01-01T00:00:00.000Z')], { mode: 'upset' });

  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /"mode" must be one of/);
});

test('a malformed item is rejected individually, not as a 500 for the batch', async () => {
  const res = await importQueries([
    { ...makeQuery(), id: 42 },
    seed('valid-alongside-bad', '2025-01-01T00:00:00.000Z'),
  ]);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.rejected.length, 1);
  assert.strictEqual(res.body.rejected[0].index, 0);
  assert.match(res.body.rejected[0].reason, /"id" must be a string/);
  assert.strictEqual(res.body.inserted, 1);
});

test('an oversized batch is refused outright', async () => {
  const many = Array.from({ length: 1001 }, (_, i) => seed(`bulk-${i}`, '2025-01-01T00:00:00.000Z'));
  const res = await importQueries(many);

  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /exceeds 1000 entries/);
});

test('a body without a queries array is refused', async () => {
  const res = await api(base, '/api/queries/import', { method: 'POST', body: { queries: 'all' } });

  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /"queries" array/);
});
