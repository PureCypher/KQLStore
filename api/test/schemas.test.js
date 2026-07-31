const test = require('node:test');
const assert = require('node:assert');
const { useTempDatabase, startServer, api } = require('./helpers');

useTempDatabase();
const app = require('../app');

let server;
test.before(async () => { server = await startServer(app); });
test.after(async () => { await server.close(); });

const body = { columns: [{ name: 'TimeGenerated', type: 'datetime' }], notes: '30 day retention' };

test('starts empty', async () => {
  const res = await api(server.url, '/api/schemas');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, []);
});

test('creates and reads back a schema', async () => {
  const put = await api(server.url, '/api/schemas/SigninLogs', { method: 'PUT', body });
  assert.strictEqual(put.status, 200);
  assert.strictEqual(put.body.name, 'SigninLogs');
  assert.deepStrictEqual(put.body.columns, [{ name: 'TimeGenerated', type: 'datetime' }]);
  assert.strictEqual(put.body.notes, '30 day retention');
  assert.ok(put.body.updated, 'updated timestamp must be set');

  const get = await api(server.url, '/api/schemas/SigninLogs');
  assert.strictEqual(get.status, 200);
  assert.strictEqual(get.body.name, 'SigninLogs');
});

test('a second PUT replaces rather than duplicating', async () => {
  await api(server.url, '/api/schemas/SigninLogs', {
    method: 'PUT',
    body: { columns: [{ name: 'ResultType', type: 'string' }] },
  });
  const list = await api(server.url, '/api/schemas');
  const matches = list.body.filter((s) => s.name === 'SigninLogs');
  assert.strictEqual(matches.length, 1);
  assert.deepStrictEqual(matches[0].columns, [{ name: 'ResultType', type: 'string' }]);
});

test('404s an unknown schema', async () => {
  const res = await api(server.url, '/api/schemas/NoSuchTable');
  assert.strictEqual(res.status, 404);
});

test('deletes a schema', async () => {
  const del = await api(server.url, '/api/schemas/SigninLogs', { method: 'DELETE' });
  assert.strictEqual(del.status, 200);
  const after = await api(server.url, '/api/schemas/SigninLogs');
  assert.strictEqual(after.status, 404);
});

test('404s a delete for something that is not there', async () => {
  const res = await api(server.url, '/api/schemas/Ghost', { method: 'DELETE' });
  assert.strictEqual(res.status, 404);
});

test('rejects an invalid payload with 400 and a usable message', async () => {
  const res = await api(server.url, '/api/schemas/Bad', { method: 'PUT', body: { columns: 'nope' } });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /"columns" must be an array/);
});

test('a malformed columns row does not 500 the list, and coexists with valid rows', async () => {
  const db = require('../db');
  // Insert a good row
  db.prepare(`
    INSERT INTO table_schemas (name, columns, notes, source, updated)
    VALUES ('GoodSchema', '[]', 'a valid row', 'manual', '2026-01-01T00:00:00Z')
  `).run();
  // Insert a malformed row
  db.prepare(`
    INSERT INTO table_schemas (name, columns, notes, source, updated)
    VALUES ('Broken', '{not json', '', 'manual', '2026-01-01T00:00:00Z')
  `).run();
  const res = await api(server.url, '/api/schemas');
  assert.strictEqual(res.status, 200);
  // Verify the good row is present with intact columns
  const good = res.body.find((s) => s.name === 'GoodSchema');
  assert.ok(good, 'good row must be in the list');
  assert.deepStrictEqual(good.columns, [], 'good row columns are intact');
  // Verify the malformed row is present with degraded columns
  const broken = res.body.find((s) => s.name === 'Broken');
  assert.ok(broken, 'malformed row must be in the list');
  assert.deepStrictEqual(broken.columns, [], 'unparseable columns degrade to empty, not a 500');
});

test('a name in the path is used, not one in the body', async () => {
  await api(server.url, '/api/schemas/PathWins', { method: 'PUT', body: { name: 'BodyLoses', columns: [] } });
  const res = await api(server.url, '/api/schemas/PathWins');
  assert.strictEqual(res.status, 200);
  const loser = await api(server.url, '/api/schemas/BodyLoses');
  assert.strictEqual(loser.status, 404);
});

test('a padded name in the path is trimmed consistently across PUT, GET, and DELETE', async () => {
  const paddedPath = '/%20%20Padded%20%20';
  // PUT with padded path
  const put = await api(server.url, `/api/schemas${paddedPath}`, {
    method: 'PUT',
    body: { columns: [{ name: 'Col1', type: 'string' }] },
  });
  assert.strictEqual(put.status, 200, 'PUT with padded path returns 200');
  assert.strictEqual(put.body.name, 'Padded', 'stored name is trimmed');
  assert.deepStrictEqual(put.body.columns, [{ name: 'Col1', type: 'string' }]);

  // GET with same padded path must succeed (not 404)
  const get = await api(server.url, `/api/schemas${paddedPath}`);
  assert.strictEqual(get.status, 200, 'GET with padded path returns 200');
  assert.strictEqual(get.body.name, 'Padded');

  // DELETE with same padded path must succeed (not 404)
  const del = await api(server.url, `/api/schemas${paddedPath}`, { method: 'DELETE' });
  assert.strictEqual(del.status, 200, 'DELETE with padded path returns 200');
  assert.strictEqual(del.body.deleted, 'Padded', 'deleted name is trimmed');

  // Verify it is truly gone
  const afterDelete = await api(server.url, `/api/schemas${paddedPath}`);
  assert.strictEqual(afterDelete.status, 404);
});
