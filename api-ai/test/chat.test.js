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
// `reply` serves every call; `queue` (when a non-empty array) serves calls in
// order instead — that is how the retry tests hand attempt 1 and attempt 2
// different streams. `calls` counts upstream requests so a test can assert the
// route retried exactly once.
const upstream = { lastRequest: null, reply: null, queue: null, calls: 0 };
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  if (String(url).includes('ollama.com')) {
    upstream.calls += 1;
    upstream.lastRequest = { url, init, body: JSON.parse(init.body) };
    const replyText = Array.isArray(upstream.queue) && upstream.queue.length
      ? upstream.queue.shift()
      : upstream.reply;
    if (replyText === '__THROW__') throw new TypeError('fetch failed');
    return {
      ok: true,
      status: 200,
      // Yield what undici's fetch actually yields: plain Uint8Array chunks, never
      // Buffer. A Buffer-based mock passed while production streams came back empty
      // (readEvents only handled Buffer). Split mid-line so the cross-chunk
      // reassembly path is exercised too.
      body: (async function* () {
        const bytes = new TextEncoder().encode(replyText);
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

test('the system prompt carries the KQL rules checklist', async () => {
  // The checklist phrasing measured best in the 2026-08 eval (see
  // docs/superpowers/specs/2026-08-06-ai-assist-quality-gap.md §4). The pins are
  // the REQUIREMENTS, not the prose: every rule the old block stated must survive.
  upstream.reply = JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n';
  await chat(baseBody);
  const system = upstream.lastRequest.body.messages[0].content;
  assert.match(system, /KQL rules — follow every one/);
  assert.match(system, /`has`\/`has_cs`, not `contains`/, 'string-operator guidance missing');
  assert.match(system, /indexed timestamp — TimeGenerated for Sentinel tables, Timestamp for Defender XDR/, 'range-filter-first guidance missing');
  assert.match(system, /CreatedDateTime/, 'semantic event-time example missing');
  assert.match(system, /NEVER for the range filter/, 'the event-time SPLIT must survive rephrasing');
  assert.match(system, /fewest rows on the left/i, 'join-ordering guidance missing');
  assert.match(system, /materialize\(\)/, 'reuse guidance missing');
  assert.match(system, /take <n>/, 'bounded-exploration guidance missing');
});

test('the system prompt carries a worked example with real newlines', async () => {
  upstream.reply = JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n';
  await chat(baseBody);
  const system = upstream.lastRequest.body.messages[0].content;
  assert.match(system, /Worked example of a good exchange:/);
  // The example's description must be shown as actual lines. An earlier eval arm
  // showed it JSON-encoded and the model copied literal backslash-n into 9 of 11
  // proposals — the example demonstrates field CONTENT, not JSON encoding.
  assert.ok(system.includes('\n\nUse Case:\n- Surface C2 beaconing'), 'example description must use real newlines');
  assert.ok(!system.includes('\\n\\nUse Case:'), 'example must not show JSON-escaped newlines');
});

test('the system prompt carries the pre-proposal self-check', async () => {
  upstream.reply = JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n';
  await chat(baseBody);
  const system = upstream.lastRequest.body.messages[0].content;
  assert.match(system, /Before calling propose_query, verify silently:/);
  assert.match(system, /every column you reference exists/i);
});

test('the system prompt states the library house style for a description', async () => {
  upstream.reply = JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n';
  await chat(baseBody);
  const system = upstream.lastRequest.body.messages[0].content;
  assert.match(system, /Use Case:/, 'the house-style heading is not named');
  assert.match(system, /- /, 'the bullet marker is not shown');
  assert.match(system, /description/i);
});

test('the propose_query tool lets the model set the table', async () => {
  // Without this the field is unproposable, so a new query keeps the editor's 'Custom'
  // default however plainly the KQL reads from SigninLogs.
  upstream.reply = JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n';
  await chat(baseBody);
  const props = upstream.lastRequest.body.tools[0].function.parameters.properties;
  assert.ok(props.table, 'table is not proposable');
  assert.match(props.table.description, /primary table/i);
});

test('the propose_query tool constrains category to the app vocabulary', async () => {
  // Same defect the table had: proposable in the SPA, absent from the tool schema, so a
  // new query kept the editor's 'Utility' default. An enum keeps the validator happy.
  upstream.reply = JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n';
  await chat(baseBody);
  const category = upstream.lastRequest.body.tools[0].function.parameters.properties.category;
  assert.ok(category, 'category is not proposable');
  assert.deepStrictEqual(category.enum,
    ['Detection', 'Hunting', 'Investigation', 'Monitoring', 'Reporting', 'Enrichment', 'Utility']);
});

test('the system prompt asks for the table and for false positives', async () => {
  upstream.reply = JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n';
  await chat(baseBody);
  const system = upstream.lastRequest.body.messages[0].content;
  assert.match(system, /table the query reads from/i, 'no table instruction');
  assert.match(system, /falsePositives/, 'no false-positive instruction');
});

test('the propose_query tool describes the description format too', async () => {
  upstream.reply = JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n';
  await chat(baseBody);
  const tool = upstream.lastRequest.body.tools[0];
  assert.match(tool.function.parameters.properties.description.description, /Use Case:/);
});

test('the rules block precedes the schemas so schemas stay closest to the task', async () => {
  upstream.reply = JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n';
  await chat(baseBody);
  const system = upstream.lastRequest.body.messages[0].content;
  const practices = system.indexOf('KQL rules — follow every one');
  const schemasAt = system.indexOf('Available table schemas:');
  assert.ok(practices >= 0 && schemasAt >= 0, 'both sections must exist');
  assert.ok(practices < schemasAt);
});

test('the propose_query query parameter restates the core KQL rules', async () => {
  // Deliberate duplication, same convention as the description house style: the
  // rule lives in the prompt AND in the tool schema the model reads at call time.
  upstream.reply = JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n';
  await chat(baseBody);
  const query = upstream.lastRequest.body.tools[0].function.parameters.properties.query;
  assert.ok(query && query.description, 'query parameter carries no guidance');
  assert.match(query.description, /indexed timestamp/);
  assert.match(query.description, /has\/has_cs/);
});

test('sends a low temperature for KQL determinism', async () => {
  upstream.reply = JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n';
  await chat(baseBody);
  assert.strictEqual(upstream.lastRequest.body.options.temperature, 0.2);
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

// ---------------------------------------------------------------------------
// Reliability hardening. Ollama Cloud sometimes cuts the stream after the
// model's thinking phase: no content, no tool call, and no done event (measured
// at 3.4% of runs — see docs/superpowers/specs/2026-08-06-ai-assist-quality-gap.md
// §3a). Separately, the model often answers with a tool call and no message text
// (its reasoning stays in the discarded thinking channel). Both used to render
// as a blank turn.
// ---------------------------------------------------------------------------

const cutStream = JSON.stringify({ message: { thinking: 'working it out…' }, done: false }) + '\n';

test('retries once when the stream is cut before anything usable', async () => {
  upstream.calls = 0;
  upstream.queue = [
    cutStream,
    JSON.stringify({ message: { content: 'second try answer' }, done: true }) + '\n',
  ];
  const res = await chat(baseBody);
  assert.strictEqual(upstream.calls, 2, 'the empty cut must trigger exactly one retry');
  const lines = res.text.trim().split('\n').map(JSON.parse);
  assert.ok(lines.some((l) => l.type === 'text' && l.value === 'second try answer'));
});

test('a second empty cut becomes the fixed error line, not a blank turn', async () => {
  upstream.calls = 0;
  upstream.queue = [cutStream, cutStream];
  const res = await chat(baseBody);
  assert.strictEqual(upstream.calls, 2, 'one retry only — never a retry loop');
  const lines = res.text.trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(lines, [{ type: 'error', value: 'The model service failed.' }]);
});

test('retries a done-terminated turn that produced nothing usable', async () => {
  // A clean done event with no content and no tool call is just as blank for the
  // operator as a cut stream — and just as safe to retry, since nothing has
  // reached the client.
  upstream.calls = 0;
  upstream.queue = [
    JSON.stringify({ message: { content: '' }, done: true }) + '\n',
    JSON.stringify({ message: { content: 'second try answer' }, done: true }) + '\n',
  ];
  const res = await chat(baseBody);
  assert.strictEqual(upstream.calls, 2);
  const lines = res.text.trim().split('\n').map(JSON.parse);
  assert.ok(lines.some((l) => l.type === 'text' && l.value === 'second try answer'));
});

test('malformed tool-call arguments do not count as progress', async () => {
  // Unparseable arguments yield no proposal, so treating them as progress would
  // suppress the retry and end in a blank turn.
  upstream.calls = 0;
  upstream.queue = [
    JSON.stringify({ message: { content: '', tool_calls: [{ function: { name: 'propose_query', arguments: '{not json' } }] }, done: true }) + '\n',
    JSON.stringify({ message: { content: 'recovered' }, done: true }) + '\n',
  ];
  const res = await chat(baseBody);
  assert.strictEqual(upstream.calls, 2);
  const lines = res.text.trim().split('\n').map(JSON.parse);
  assert.ok(lines.some((l) => l.type === 'text' && l.value === 'recovered'));
});

test('a retry whose fetch rejects still ends with the error line, on the NDJSON contract', async () => {
  upstream.calls = 0;
  upstream.queue = [cutStream, '__THROW__'];
  const res = await chat(baseBody);
  assert.strictEqual(upstream.calls, 2);
  const lines = res.text.trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(lines, [{ type: 'error', value: 'The model service failed.' }]);
});

test('does not retry once text has already streamed to the client', async () => {
  upstream.calls = 0;
  // Text arrives, then the stream dies without a done event. A retry here would
  // duplicate content the client has already rendered.
  upstream.queue = [JSON.stringify({ message: { content: 'partial ' }, done: false }) + '\n'];
  const res = await chat(baseBody);
  assert.strictEqual(upstream.calls, 1);
  const lines = res.text.trim().split('\n').map(JSON.parse);
  assert.ok(lines.some((l) => l.type === 'text' && l.value === 'partial '));
});

test('a proposal with no message text gets the fixed notice line', async () => {
  upstream.reply = JSON.stringify({
    message: { content: '', tool_calls: [{ function: { name: 'propose_query', arguments: { name: 'Silent proposal' } } }] },
    done: true,
  }) + '\n';
  const res = await chat(baseBody);
  const lines = res.text.trim().split('\n').map(JSON.parse);
  const noticeAt = lines.findIndex((l) => l.type === 'text' && /no explanation this turn/.test(l.value));
  const proposalAt = lines.findIndex((l) => l.type === 'proposal');
  assert.ok(noticeAt >= 0, 'silent proposal must carry the notice');
  assert.ok(proposalAt >= 0, 'the proposal itself must still be emitted');
  assert.ok(noticeAt < proposalAt, 'notice reads before the proposal card');
});

test('no notice when the model explained itself', async () => {
  upstream.reply = JSON.stringify({
    message: { content: 'here is why', tool_calls: [{ function: { name: 'propose_query', arguments: { name: 'Explained' } } }] },
    done: true,
  }) + '\n';
  const res = await chat(baseBody);
  assert.ok(!/no explanation this turn/.test(res.text));
});
