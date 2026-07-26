// ---------------------------------------------------------------------------
// StorageAdapter: error reporting and the import mode on the wire.
//
// Two defects are pinned here.
//
// Every wrapper used to throw `API ${status}: ${statusText}` and drop the response body,
// so the server-side validation added with schema v4 reached the user as "API 400: Bad
// Request" — a message that names neither the query nor the field that was refused. The
// body says exactly that, and these tests assert it survives all the way out of every
// call site, not just the one that was noticed.
//
// The import endpoint has supported newer-wins upsert since the API grew a mode
// parameter, and the SPA never sent one. The mode is asserted on the request body because
// that is the only place its absence was visible.
// ---------------------------------------------------------------------------
import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import { StorageAdapter } from '../adapter.js';
import { response, emptyResponse, stubFetch, callsTo } from './fetchStub.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SAMPLE = { id: 'a1', name: 'Rule', query: 'DeviceEvents' };

// Every wrapper that talks to the API, with the arguments needed to invoke it. The list is
// the test: a new endpoint that forgets to surface the body shows up as a missing entry.
const CALL_SITES = [
  ['fetchAll', () => StorageAdapter.fetchAll()],
  ['createQuery', () => StorageAdapter.createQuery(SAMPLE)],
  ['updateQuery', () => StorageAdapter.updateQuery('a1', SAMPLE)],
  ['deleteQuery', () => StorageAdapter.deleteQuery('a1')],
  ['importQueries', () => StorageAdapter.importQueries([SAMPLE])],
  ['exportQueries', () => StorageAdapter.exportQueries()],
  ['healthCheck', () => StorageAdapter.healthCheck()],
];

describe('server error bodies reach the caller', () => {
  it.each(CALL_SITES)('%s surfaces the message the server sent', async (_name, invoke) => {
    stubFetch(() => response(
      { error: '"tags" exceeds 20 entries' },
      { status: 400, statusText: 'Bad Request' },
    ));

    await expect(invoke()).rejects.toThrow('"tags" exceeds 20 entries');
  });

  it.each(CALL_SITES)('%s keeps the status line alongside the message', async (_name, invoke) => {
    stubFetch(() => response({ error: 'category must be one of: Detection, Hunting' }, { status: 400, statusText: 'Bad Request' }));

    await expect(invoke()).rejects.toThrow(/^API 400: Bad Request — category must be one of/);
  });

  it('exposes the status code on the error for callers that branch on it', async () => {
    stubFetch(() => response({ error: 'Query not found' }, { status: 404, statusText: 'Not Found' }));

    const err = await StorageAdapter.updateQuery('missing', SAMPLE).catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.detail).toBe('Query not found');
  });

  it('reads the 409 body from the optimistic-concurrency check', async () => {
    stubFetch(() => response(
      { error: 'Query was modified by another client', currentUpdated: '2026-07-26T10:00:00.000Z' },
      { status: 409, statusText: 'Conflict' },
    ));

    await expect(StorageAdapter.updateQuery('a1', SAMPLE)).rejects.toThrow('Query was modified by another client');
  });

  it('falls back to the status line when a proxy returns an HTML error page', async () => {
    // nginx and Cloudflare Access both do this. Pasting the markup into a toast helps
    // nobody, so the page is discarded rather than quoted.
    stubFetch(() => response(
      '<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>',
      { status: 502, statusText: 'Bad Gateway', contentType: 'text/html' },
    ));

    const err = await StorageAdapter.fetchAll().catch((e) => e);
    expect(err.message).toBe('API 502: Bad Gateway');
    expect(err.message).not.toContain('<');
  });

  it('quotes a short plain-text body that is not from our error handler', async () => {
    stubFetch(() => response('request entity too large', { status: 413, statusText: 'Payload Too Large', contentType: 'text/plain' }));

    await expect(StorageAdapter.createQuery(SAMPLE)).rejects.toThrow('API 413: Payload Too Large — request entity too large');
  });

  it('survives an empty body', async () => {
    stubFetch(() => emptyResponse({ status: 500, statusText: 'Internal Server Error' }));

    await expect(StorageAdapter.fetchAll()).rejects.toThrow('API 500: Internal Server Error');
  });

  it('survives a status line with no statusText', async () => {
    stubFetch(() => emptyResponse({ status: 503, statusText: '' }));

    await expect(StorageAdapter.healthCheck()).rejects.toThrow('API 503');
  });

  it('still reports a transport failure when nothing answers at all', async () => {
    stubFetch(() => undefined);

    await expect(StorageAdapter.fetchAll()).rejects.toThrow(/Failed to fetch/);
  });
});

describe('importQueries mode', () => {
  const ok = () => response({ mode: 'insert', imported: 1, inserted: 1, updated: 0, results: [], rejected: [] });

  it('defaults to insert, the non-destructive mode', async () => {
    const { calls } = stubFetch(ok);

    await StorageAdapter.importQueries([SAMPLE]);

    const [req] = callsTo(calls, '/api/queries/import', 'POST');
    expect(req.body).toEqual({ queries: [SAMPLE], mode: 'insert' });
  });

  it('sends upsert when the caller asks for it by name', async () => {
    const { calls } = stubFetch(ok);

    await StorageAdapter.importQueries([SAMPLE], { mode: 'upsert' });

    expect(callsTo(calls, '/api/queries/import', 'POST')[0].body.mode).toBe('upsert');
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['an unrecognised mode', { mode: 'overwrite' }],
    ['a non-string mode', { mode: true }],
    ['an object that is not options at all', { type: 'click', target: {} }],
  ])('falls back to insert given %s', async (_label, options) => {
    const { calls } = stubFetch(ok);

    await StorageAdapter.importQueries([SAMPLE], options);

    expect(callsTo(calls, '/api/queries/import', 'POST')[0].body.mode).toBe('insert');
  });

  it('returns the server report unchanged, including rejected rows', async () => {
    stubFetch(() => response({
      mode: 'upsert', total: 2, imported: 1, inserted: 0, updated: 1,
      skippedOlder: 1, skippedExisting: 0, results: [], rejected: [{ index: 1, reason: '"name" is required' }],
    }));

    const report = await StorageAdapter.importQueries([SAMPLE], { mode: 'upsert' });

    expect(report.updated).toBe(1);
    expect(report.rejected).toEqual([{ index: 1, reason: '"name" is required' }]);
  });
});
