// ---------------------------------------------------------------------------
// /api/health and /api/health/ready.
//
// The endpoint is reachable without credentials because kubelet probes it, so it must
// disclose nothing about the store — and it must be able to tell "readable" from
// "writable", because a full or read-only PVC breaks only the second one.
// ---------------------------------------------------------------------------

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { useTempDatabase, startServer, api, sleep, makeQuery } = require('./helpers');

useTempDatabase();
// Short enough to exercise the cache and its expiry without a slow test.
const WRITE_TTL_MS = 500;
process.env.HEALTH_WRITE_TTL_MS = String(WRITE_TTL_MS);

const app = require('../app');
const db = require('../db');

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

const probeValue = () => db.prepare('SELECT checked FROM health_probe WHERE id = 1').get()?.checked;

test('health reports status, writability and time — and nothing about the store', async () => {
  await api(base, '/api/queries', { method: 'POST', body: makeQuery() });

  const res = await api(base, '/api/health');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'ok');
  assert.strictEqual(res.body.writable, true);
  assert.ok(!Number.isNaN(Date.parse(res.body.timestamp)));
  assert.deepStrictEqual(Object.keys(res.body).sort(), ['status', 'timestamp', 'writable']);
  assert.strictEqual(res.text.includes('ount'), false, 'response must not carry a count of any kind');
});

test('the write check is cached, so a 10s probe interval does not thrash the disk', async () => {
  await api(base, '/api/health');
  const first = probeValue();

  await sleep(5);
  await api(base, '/api/health');
  await api(base, '/api/health/ready');
  await api(base, '/api/health');

  assert.strictEqual(probeValue(), first, 'repeat probes inside the TTL must not write again');
});

test('the write check runs again once its TTL expires', async () => {
  await api(base, '/api/health');
  const first = probeValue();

  await sleep(WRITE_TTL_MS + 50);
  await api(base, '/api/health');

  assert.notStrictEqual(probeValue(), first);
});

test('readiness is 200 while the database is writable', async () => {
  const res = await api(base, '/api/health/ready');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.writable, true);
});

// Kept last: query_only turns the shared connection into the read-only database a full
// or remounted PVC produces — reads keep working, every write raises SQLITE_READONLY.
test('a read-only database fails readiness but not liveness', async () => {
  db.pragma('query_only = ON');
  await sleep(WRITE_TTL_MS + 50);

  try {
    const live = await api(base, '/api/health');
    assert.strictEqual(live.status, 200, 'liveness must not restart a pod that is still serving reads');
    assert.strictEqual(live.body.status, 'degraded');
    assert.strictEqual(live.body.writable, false);

    const ready = await api(base, '/api/health/ready');
    assert.strictEqual(ready.status, 503);
    assert.strictEqual(ready.body.writable, false);
  } finally {
    db.pragma('query_only = OFF');
  }
});
