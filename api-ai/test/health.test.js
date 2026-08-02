// ---------------------------------------------------------------------------
// Health endpoint tests.
//
// The third test is the load-bearing one for this service's reason to exist: it
// asserts kqlstore-ai never loads better-sqlite3, which is the concrete form of
// "this pod cannot touch the query store". The AI pod is allowed to be reachable
// (and to reach Ollama), so the thing it must not have is a database.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const { once } = require('events');

const app = require('../app');

let server;
let base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((r) => server.close(r)));

test('health reports the configured model', async () => {
  process.env.OLLAMA_MODEL = 'deepseek-v4-flash:cloud';
  const res = await fetch(`${base}/api/ai/health`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.status, 'ok');
  assert.strictEqual(body.model, 'deepseek-v4-flash:cloud');
});

test('health reports whether a key is present without revealing it', async () => {
  process.env.OLLAMA_API_KEY = 'sk-secret-value-do-not-leak';
  const res = await fetch(`${base}/api/ai/health`);
  const text = await res.text();
  assert.ok(text.includes('"configured":true'));
  assert.ok(!text.includes('sk-secret-value-do-not-leak'), 'the key must never appear in a response');
});

test('the service does not import the database', () => {
  const loaded = Object.keys(require.cache).filter((p) => p.includes('better-sqlite3'));
  assert.deepStrictEqual(loaded, [], 'kqlstore-ai must never load the database driver');
});
