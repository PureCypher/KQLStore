// ---------------------------------------------------------------------------
// Test harness.
//
// db.js opens its file at require() time from DB_PATH, so useTempDatabase() has to run
// before anything pulls in ../app. node:test gives each file its own process, so a
// per-file temp database is genuinely isolated.
// ---------------------------------------------------------------------------

const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');

function useTempDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kqlstore-api-test-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  return dir;
}

async function startServer(app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Minimal fetch wrapper: no supertest, no dependencies. */
async function api(base, route, { method = 'GET', body, headers = {} } = {}) {
  const hasBody = body !== undefined;
  const res = await fetch(base + route, {
    method,
    headers: hasBody ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: hasBody ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, body: json, text };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A valid query payload; override anything a given test cares about. */
function makeQuery(overrides = {}) {
  return {
    name: 'Failed sign-ins',
    query: 'SigninLogs | where ResultType != 0',
    description: 'Baseline hunt',
    category: 'Hunting',
    table: 'SigninLogs',
    tags: ['identity'],
    favorite: false,
    usageCount: 0,
    ...overrides,
  };
}

module.exports = { useTempDatabase, startServer, api, sleep, makeQuery };
