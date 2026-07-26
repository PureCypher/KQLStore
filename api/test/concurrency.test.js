// ---------------------------------------------------------------------------
// PUT /api/queries/:id — opt-in optimistic concurrency.
//
// Two browsers on the same query used to overwrite each other silently, the later save
// winning by accident. The precondition must stay optional: the SPA does not send it.
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

// Seeded through /import rather than POST because import writes the supplied timestamps
// verbatim: every assertion below then compares against a value the test chose, not
// against whatever millisecond the create happened to land in.
const SEED_UPDATED = '2024-01-01T00:00:00.000Z';
let seq = 0;

async function createQuery(overrides = {}) {
  const id = `conc-${++seq}`;
  const res = await api(base, '/api/queries/import', {
    method: 'POST',
    body: { queries: [makeQuery({ id, created: SEED_UPDATED, updated: SEED_UPDATED, ...overrides })] },
  });
  assert.strictEqual(res.body.inserted, 1);
  const row = await api(base, `/api/queries/${id}`);
  return row.body;
}

test('a PUT without a precondition still wins, as the SPA expects', async () => {
  const created = await createQuery({ name: 'Unconditional' });

  const res = await api(base, `/api/queries/${created.id}`, {
    method: 'PUT',
    body: { name: 'Changed' },
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.name, 'Changed');
});

test('a PUT carrying the current timestamp is accepted', async () => {
  const created = await createQuery({ name: 'Conditional' });

  const res = await api(base, `/api/queries/${created.id}`, {
    method: 'PUT',
    body: { name: 'Changed', expectedUpdated: created.updated },
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.name, 'Changed');
  assert.notStrictEqual(res.body.updated, created.updated);
});

test('a PUT based on a superseded read is refused with 409 and does not write', async () => {
  const created = await createQuery({ name: 'Contended' });

  // Browser A saves first.
  const first = await api(base, `/api/queries/${created.id}`, {
    method: 'PUT',
    body: { name: 'Browser A' },
  });
  assert.strictEqual(first.status, 200);

  // Browser B is still working from the pre-A copy.
  const second = await api(base, `/api/queries/${created.id}`, {
    method: 'PUT',
    body: { name: 'Browser B', expectedUpdated: created.updated },
  });

  assert.strictEqual(second.status, 409);
  assert.strictEqual(second.body.currentUpdated, first.body.updated);
  assert.strictEqual(second.body.current.name, 'Browser A');

  const stored = await api(base, `/api/queries/${created.id}`);
  assert.strictEqual(stored.body.name, 'Browser A');
});

test('the precondition also travels as the X-Expected-Updated header', async () => {
  const created = await createQuery({ name: 'Header path' });

  const stale = await api(base, `/api/queries/${created.id}`, {
    method: 'PUT',
    body: { name: 'Via header' },
    headers: { 'X-Expected-Updated': '2000-01-01T00:00:00.000Z' },
  });
  assert.strictEqual(stale.status, 409);

  const fresh = await api(base, `/api/queries/${created.id}`, {
    method: 'PUT',
    body: { name: 'Via header' },
    headers: { 'X-Expected-Updated': created.updated },
  });
  assert.strictEqual(fresh.status, 200);
  assert.strictEqual(fresh.body.name, 'Via header');
});

test('a non-string precondition is a 400, not a silent no-op', async () => {
  const created = await createQuery({ name: 'Bad precondition' });

  const res = await api(base, `/api/queries/${created.id}`, {
    method: 'PUT',
    body: { name: 'Changed', expectedUpdated: 1735689600000 },
  });

  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /"expectedUpdated" must be a string/);
});

test('a missing row is still a 404 even with a precondition attached', async () => {
  const res = await api(base, '/api/queries/does-not-exist', {
    method: 'PUT',
    body: { name: 'Ghost', expectedUpdated: '2025-01-01T00:00:00.000Z' },
  });

  assert.strictEqual(res.status, 404);
});
