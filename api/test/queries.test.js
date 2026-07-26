// ---------------------------------------------------------------------------
// GET /api/queries — unbounded by default (the SPA holds the whole store and filters
// client-side), with optional paging for anything that cannot.
// ---------------------------------------------------------------------------

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { useTempDatabase, startServer, api, makeQuery } = require('./helpers');

useTempDatabase();
const app = require('../app');

const TOTAL = 12;

let base;
let stop;

before(async () => {
  const server = await startServer(app);
  base = server.url;
  stop = server.close;

  // Distinct, descending timestamps so ordering assertions are exact.
  const queries = Array.from({ length: TOTAL }, (_, i) => makeQuery({
    id: `page-${String(i).padStart(2, '0')}`,
    name: `Query ${i}`,
    created: '2024-01-01T00:00:00.000Z',
    updated: `2025-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
  }));
  const res = await api(base, '/api/queries/import', { method: 'POST', body: { queries } });
  assert.strictEqual(res.body.inserted, TOTAL);
});

after(async () => {
  await stop();
});

test('with no parameters the whole table comes back, newest first', async () => {
  const res = await api(base, '/api/queries');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.length, TOTAL);
  assert.strictEqual(res.body[0].id, 'page-11');
  assert.strictEqual(res.body[TOTAL - 1].id, 'page-00');
});

test('limit truncates from the newest end', async () => {
  const res = await api(base, '/api/queries?limit=3');

  assert.strictEqual(res.body.length, 3);
  assert.deepStrictEqual(res.body.map((q) => q.id), ['page-11', 'page-10', 'page-09']);
});

test('limit and offset page without gaps or repeats', async () => {
  const first = await api(base, '/api/queries?limit=5&offset=0');
  const second = await api(base, '/api/queries?limit=5&offset=5');
  const third = await api(base, '/api/queries?limit=5&offset=10');

  const ids = [...first.body, ...second.body, ...third.body].map((q) => q.id);
  assert.strictEqual(ids.length, TOTAL);
  assert.strictEqual(new Set(ids).size, TOTAL);
});

test('offset alone skips without imposing a limit', async () => {
  const res = await api(base, '/api/queries?offset=10');

  assert.strictEqual(res.body.length, 2);
  assert.strictEqual(res.body[0].id, 'page-01');
});

test('an offset past the end is an empty list, not an error', async () => {
  const res = await api(base, '/api/queries?offset=500');

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, []);
});

test('paging parameters are validated', async () => {
  for (const qs of ['limit=abc', 'limit=0', 'limit=1001', 'limit=-1', 'offset=-1', 'offset=1.5']) {
    const res = await api(base, `/api/queries?${qs}`);
    assert.strictEqual(res.status, 400, `expected 400 for ?${qs}`);
    assert.match(res.body.error, /"(limit|offset)"/);
  }
});

test('rows sharing an updated timestamp still page deterministically', async () => {
  const tied = ['tie-a', 'tie-b', 'tie-c'].map((id) => makeQuery({
    id,
    created: '2024-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
  }));
  await api(base, '/api/queries/import', { method: 'POST', body: { queries: tied } });

  const first = await api(base, '/api/queries?limit=2&offset=0');
  const second = await api(base, '/api/queries?limit=2&offset=2');

  assert.deepStrictEqual(first.body.map((q) => q.id), ['tie-a', 'tie-b']);
  assert.strictEqual(second.body[0].id, 'tie-c');
});
