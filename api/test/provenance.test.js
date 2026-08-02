// ---------------------------------------------------------------------------
// AI provenance column tests.
//
// The column exists so a query can record what a model authored AND the operator
// accepted — never what was merely proposed. These tests pin the bounds, the cap,
// and the two things that would silently corrupt the record: an unknown redaction
// state (rejected) and provenance leaking into the v4 detection metadata document
// (asserted absent).
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const { useTempDatabase, startServer, api, makeQuery } = require('./helpers');

useTempDatabase();
const app = require('../app');

let server;
test.before(async () => { server = await startServer(app); });
test.after(async () => { await server.close(); });

const record = (over = {}) => ({
  model: 'deepseek-v4-flash:cloud',
  generatedAt: '2026-07-31T14:02:11Z',
  redaction: 'applied',
  instruction: 'make this detect Okta instead of Entra',
  fields: ['query', 'name'],
  ...over,
});

test('round-trips a provenance record', async () => {
  const res = await api(server.url, '/api/queries', {
    method: 'POST', body: makeQuery({ aiProvenance: [record()] }),
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.aiProvenance.length, 1);
  assert.deepStrictEqual(res.body.aiProvenance[0].fields, ['query', 'name']);
});

test('defaults to an empty array', async () => {
  const res = await api(server.url, '/api/queries', { method: 'POST', body: makeQuery({ name: 'Plain' }) });
  assert.deepStrictEqual(res.body.aiProvenance, []);
});

test('caps at the 10 most recent, dropping the oldest', async () => {
  const many = Array.from({ length: 15 }, (_, i) => record({ instruction: `step ${i}` }));
  const res = await api(server.url, '/api/queries', { method: 'POST', body: makeQuery({ name: 'Many', aiProvenance: many }) });
  assert.strictEqual(res.body.aiProvenance.length, 10);
  assert.strictEqual(res.body.aiProvenance[9].instruction, 'step 14');
  assert.strictEqual(res.body.aiProvenance[0].instruction, 'step 5');
});

test('rejects an unknown redaction value', async () => {
  const res = await api(server.url, '/api/queries', {
    method: 'POST', body: makeQuery({ name: 'Bad', aiProvenance: [record({ redaction: 'maybe' })] }),
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /redaction/);
});

test('truncates an over-long instruction rather than rejecting', async () => {
  const res = await api(server.url, '/api/queries', {
    method: 'POST', body: makeQuery({ name: 'Long', aiProvenance: [record({ instruction: 'x'.repeat(2000) })] }),
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.aiProvenance[0].instruction.length, 1000);
});

test('provenance does not leak into the v4 metadata document', async () => {
  const res = await api(server.url, '/api/queries', {
    method: 'POST', body: makeQuery({ name: 'Separate', severity: 'High', aiProvenance: [record()] }),
  });
  const db = require('../db');
  const row = db.prepare('SELECT metadata FROM queries WHERE id = ?').get(res.body.id);
  assert.ok(!('aiProvenance' in JSON.parse(row.metadata)));
});

test('a malformed provenance column does not 500 the list', async () => {
  const db = require('../db');
  db.prepare(`
    INSERT INTO queries (id, name, query, ai_provenance, created, updated)
    VALUES ('bad1', 'n', 'q', '{not json', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
  `).run();
  const res = await api(server.url, '/api/queries');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.find((q) => q.id === 'bad1').aiProvenance, []);
});
