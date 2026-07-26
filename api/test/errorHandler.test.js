// ---------------------------------------------------------------------------
// The error handler is the only thing standing between an escaped exception and the
// caller, so it is tested both in isolation and through a real 500.
// ---------------------------------------------------------------------------

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { useTempDatabase, startServer, api, makeQuery } = require('./helpers');

useTempDatabase();
const app = require('../app');
const errorHandler = require('../middleware/errorHandler');

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

// The handler logs on every call; keep the test output readable and capture what it said.
const realError = console.error;
const realWarn = console.warn;
let logged;

beforeEach(() => {
  logged = { error: [], warn: [] };
  console.error = (...args) => logged.error.push(args.join(' '));
  console.warn = (...args) => logged.warn.push(args.join(' '));
});

afterEach(() => {
  console.error = realError;
  console.warn = realWarn;
});

function fakeExchange() {
  const res = {
    headersSent: false,
    statusCode: null,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
  return { req: { method: 'GET', originalUrl: '/api/queries' }, res };
}

test('an unexpected error is generic to the caller and detailed in the log', () => {
  const { req, res } = fakeExchange();
  const err = new Error('UNIQUE constraint failed: queries.id');

  errorHandler(err, req, res, () => {});

  assert.strictEqual(res.statusCode, 500);
  assert.deepStrictEqual(res.payload, { error: 'Internal Server Error' });
  assert.ok(logged.error.some((line) => line.includes('UNIQUE constraint failed')));
});

test('a deliberate 4xx keeps its message, which was written for the caller', () => {
  const { req, res } = fakeExchange();
  const err = new Error('"tags" exceeds 20 entries');
  err.statusCode = 400;

  errorHandler(err, req, res, () => {});

  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.payload, { error: '"tags" exceeds 20 entries' });
});

test('4xx logs one line and no stack — an unauthenticated caller cannot inflate the log', () => {
  const { req, res } = fakeExchange();
  const err = new Error('bad input');
  err.statusCode = 422;

  errorHandler(err, req, res, () => {});

  assert.strictEqual(logged.error.length, 0);
  assert.strictEqual(logged.warn.length, 1);
});

test('body-parser style errors carry .status and are honoured', () => {
  const { req, res } = fakeExchange();
  const err = new Error('Unexpected token in JSON');
  err.status = 400;

  errorHandler(err, req, res, () => {});

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.payload.error, 'Unexpected token in JSON');
});

test('a nonsensical statusCode falls back to 500 rather than being sent as-is', () => {
  const { req, res } = fakeExchange();
  const err = new Error('boom');
  err.statusCode = 200;

  errorHandler(err, req, res, () => {});

  assert.strictEqual(res.statusCode, 500);
  assert.deepStrictEqual(res.payload, { error: 'Internal Server Error' });
});

test('a part-written response is handed to express rather than appended to', () => {
  const { req, res } = fakeExchange();
  res.headersSent = true;
  let delegated = null;

  errorHandler(new Error('late failure'), req, res, (e) => { delegated = e; });

  assert.strictEqual(res.statusCode, null);
  assert.strictEqual(delegated.message, 'late failure');
});

test('end to end: a real SQLite failure does not name the table or the constraint', async () => {
  const body = makeQuery({ id: 'duplicate-me' });
  const first = await api(base, '/api/queries', { method: 'POST', body });
  assert.strictEqual(first.status, 201);

  const second = await api(base, '/api/queries', { method: 'POST', body });

  assert.strictEqual(second.status, 500);
  assert.deepStrictEqual(second.body, { error: 'Internal Server Error' });
  assert.doesNotMatch(second.text, /queries|constraint|SQLITE/i);
});

test('end to end: malformed JSON is a 400, not a 500', async () => {
  const res = await api(base, '/api/queries', { method: 'POST', body: '{"name": ' });

  assert.strictEqual(res.status, 400);
});
