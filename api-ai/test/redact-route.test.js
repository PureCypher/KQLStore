// ---------------------------------------------------------------------------
// Redaction-preview endpoint tests.
//
// The two tests that matter for the security property: a request carrying a
// credential is refused outright (422) AND the response does not echo the
// credential — rules only, never the matched value. Everything else is the
// convenience of the preview (what will be replaced, with which marker).
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const { once } = require('events');
const app = require('../app');

let server, base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((r) => server.close(r)));

const post = async (body) => {
  const res = await fetch(`${base}/api/ai/redact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

test('redacts a private IP and returns the mapping', async () => {
  const res = await post({ fields: { query: 'DeviceIP == "10.1.2.3"' } });
  assert.strictEqual(res.status, 200);
  assert.ok(!res.body.redacted.query.includes('10.1.2.3'));
  assert.match(res.body.redacted.query, /<PRIVATE_IPV4_1>/);
  assert.strictEqual(res.body.applied[0].value, '10.1.2.3');
});

test('blocks a request carrying a credential', async () => {
  const res = await post({ fields: { query: 'let k = "AKIAIOSFODNN7EXAMPLE";' } });
  assert.strictEqual(res.status, 422);
  assert.strictEqual(res.body.blocked, true);
  assert.strictEqual(res.body.secrets[0].rule, 'AWS access key id');
});

test('a blocked response does not echo the credential', async () => {
  const res = await fetch(`${base}/api/ai/redact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { query: 'let k = "AKIAIOSFODNN7EXAMPLE";' } }),
  });
  const text = await res.text();
  assert.ok(!text.includes('AKIAIOSFODNN7EXAMPLE'), 'a blocked secret must not come back in the response');
});

test('numbers markers per rule across fields', async () => {
  const res = await post({ fields: { name: 'host dc01.corp', query: 'DeviceIP == "10.0.0.1"' } });
  const rules = res.body.applied.map((a) => a.rule).sort();
  assert.deepStrictEqual(rules, ['Internal hostname', 'Private IPv4']);
});

test('the same value across two fields gets one marker', async () => {
  const res = await post({ fields: { description: 'see 10.0.0.9', query: 'IP == "10.0.0.9"' } });
  assert.strictEqual(res.body.applied.length, 1);
  assert.ok(res.body.redacted.description.includes(res.body.applied[0].marker));
  assert.ok(res.body.redacted.query.includes(res.body.applied[0].marker));
});

test('clean input passes through unchanged', async () => {
  const res = await post({ fields: { query: 'SigninLogs | where ResultType != 0' } });
  assert.strictEqual(res.body.redacted.query, 'SigninLogs | where ResultType != 0');
  assert.deepStrictEqual(res.body.applied, []);
});

test('rejects a body with no fields object', async () => {
  const res = await post({});
  assert.strictEqual(res.status, 400);
});
