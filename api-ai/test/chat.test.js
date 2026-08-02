// ---------------------------------------------------------------------------
// Chat route tests.
//
// Ollama is stubbed before the app loads: this suite touches no network. The two
// tests that carry the security property are "redacts the draft before it reaches
// the model" (a disclosure becomes a marker before egress) and "a secret is refused
// even with allowVerbatim" (the override covers disclosures, never credentials).
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const { once } = require('events');

// Stub Ollama before the route loads. No network is touched by this suite.
// The stub must intercept ONLY the route's outbound call to ollama.com and pass local
// requests (this suite's own fetch to the test server) through to the real fetch —
// otherwise the suite's chat() helper gets the fake Response back and res.text() breaks.
const upstream = { lastRequest: null, reply: null };
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  if (String(url).includes('ollama.com')) {
    upstream.lastRequest = { url, init, body: JSON.parse(init.body) };
    return {
      ok: true,
      status: 200,
      // Yield what undici's fetch actually yields: plain Uint8Array chunks, never
      // Buffer. A Buffer-based mock passed while production streams came back empty
      // (readEvents only handled Buffer). Split mid-line so the cross-chunk
      // reassembly path is exercised too.
      body: (async function* () {
        const bytes = new TextEncoder().encode(upstream.reply);
        const mid = Math.ceil(bytes.length / 2);
        yield bytes.slice(0, mid);
        yield bytes.slice(mid);
      })(),
    };
  }
  return realFetch(url, init);
};

const app = require('../app');
let server, base;
test.before(async () => {
  process.env.OLLAMA_API_KEY = 'test-key';
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((r) => server.close(r)));

const chat = async (body) => {
  const res = await fetch(`${base}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
};

const baseBody = {
  messages: [{ role: 'user', content: 'make this detect Okta' }],
  schemas: [{ name: 'OktaLogs', columns: [{ name: 'eventType', type: 'string' }], notes: '' }],
  draft: { name: 'Entra risky sign-in', description: 'd', query: 'SigninLogs | take 1' },
  allowVerbatim: false,
};

test('sends the configured model and a bearer token', async () => {
  upstream.reply = JSON.stringify({ message: { content: 'done' }, done: true }) + '\n';
  await chat(baseBody);
  assert.match(upstream.lastRequest.url, /ollama\.com/);
  assert.strictEqual(upstream.lastRequest.body.model, 'deepseek-v4-flash:cloud');
  assert.strictEqual(upstream.lastRequest.init.headers.Authorization, 'Bearer test-key');
});

test('redacts the draft before it reaches the model', async () => {
  upstream.reply = JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n';
  await chat({ ...baseBody, draft: { ...baseBody.draft, query: 'IP == "10.1.2.3"' } });
  const sent = JSON.stringify(upstream.lastRequest.body);
  assert.ok(!sent.includes('10.1.2.3'), 'an unredacted private IP reached the model');
  assert.ok(sent.includes('<PRIVATE_IPV4_1>'));
});

test('allowVerbatim sends the original text', async () => {
  upstream.reply = JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n';
  await chat({ ...baseBody, draft: { ...baseBody.draft, query: 'IP == "10.1.2.3"' }, allowVerbatim: true });
  assert.ok(JSON.stringify(upstream.lastRequest.body).includes('10.1.2.3'));
});

test('a secret is refused even with allowVerbatim', async () => {
  const res = await chat({
    ...baseBody,
    draft: { ...baseBody.draft, query: 'let k = "AKIAIOSFODNN7EXAMPLE";' },
    allowVerbatim: true,
  });
  assert.strictEqual(res.status, 422, 'allowVerbatim covers disclosures, never credentials');
});

test('includes the supplied schemas in the prompt', async () => {
  upstream.reply = JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n';
  await chat(baseBody);
  assert.ok(JSON.stringify(upstream.lastRequest.body).includes('OktaLogs'));
});

test('renders knownTables as a names-only line in the system prompt', async () => {
  upstream.reply = JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n';
  await chat({ ...baseBody, knownTables: ['DeviceEvents', 'ZTSGraph'] });
  const system = upstream.lastRequest.body.messages[0].content;
  assert.match(system, /Other tables that exist/);
  assert.match(system, /DeviceEvents, ZTSGraph/);
});

test('omits the known-tables line when knownTables is absent or empty', async () => {
  upstream.reply = JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n';
  await chat(baseBody);
  assert.doesNotMatch(upstream.lastRequest.body.messages[0].content, /Other tables that exist/);
});

test('ignores non-string entries in knownTables', async () => {
  upstream.reply = JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n';
  await chat({ ...baseBody, knownTables: ['DeviceEvents', 42, null, { name: 'x' }] });
  const system = upstream.lastRequest.body.messages[0].content;
  assert.match(system, /DeviceEvents/);
  assert.ok(!system.includes('42') && !system.includes('[object Object]'));
});

test('streams text chunks as NDJSON', async () => {
  upstream.reply = [
    JSON.stringify({ message: { content: 'Hel' }, done: false }),
    JSON.stringify({ message: { content: 'lo' }, done: true }),
  ].join('\n') + '\n';
  const res = await chat(baseBody);
  const lines = res.text.trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(lines.filter((l) => l.type === 'text').map((l) => l.value), ['Hel', 'lo']);
});

test('emits a proposal from a tool call', async () => {
  upstream.reply = JSON.stringify({
    message: {
      content: '',
      tool_calls: [{ function: { name: 'propose_query', arguments: { name: 'Okta risky sign-in', tags: ['okta'] } } }],
    },
    done: true,
  }) + '\n';
  const res = await chat(baseBody);
  const proposal = res.text.trim().split('\n').map(JSON.parse).find((l) => l.type === 'proposal');
  assert.strictEqual(proposal.fields.name, 'Okta risky sign-in');
});

test('un-redacts markers in the proposal before returning', async () => {
  upstream.reply = JSON.stringify({
    message: { content: '', tool_calls: [{ function: { name: 'propose_query', arguments: { query: 'IP == "<PRIVATE_IPV4_1>"' } } }] },
    done: true,
  }) + '\n';
  const res = await chat({ ...baseBody, draft: { ...baseBody.draft, query: 'IP == "10.1.2.3"' } });
  const proposal = res.text.trim().split('\n').map(JSON.parse).find((l) => l.type === 'proposal');
  assert.strictEqual(proposal.fields.query, 'IP == "10.1.2.3"', 'markers must be restored on the way back');
});

test('a missing API key fails without contacting anything', async () => {
  const saved = process.env.OLLAMA_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  const res = await chat(baseBody);
  assert.strictEqual(res.status, 503);
  assert.ok(!res.text.includes('Bearer'));
  process.env.OLLAMA_API_KEY = saved;
});

test('an upstream failure does not echo the upstream body', async () => {
  const saved = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes('ollama.com')) {
      return { ok: false, status: 500, text: async () => 'upstream said: SigninLogs | where secret' };
    }
    return realFetch(url, init);
  };
  const res = await chat(baseBody);
  assert.ok(!res.text.includes('SigninLogs'), 'an upstream error body can contain the request');
  global.fetch = saved;
});
