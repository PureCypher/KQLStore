// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// useKQLStorage against a stubbed fetch — no network, no database.
//
// Three defects are pinned here, all of them invisible from the UI and all of them about
// requests the hook did or did not send:
//
//   1. Import could not update. An incoming query whose id already existed was skipped as
//      a "Duplicate ID", so a shared detection pack was receive-once. The API has
//      supported newer-wins upsert throughout; the SPA never asked for it.
//
//   2. The reconnect sync pushed offline work up in insert mode, which means the server
//      kept its own older copy and answered 200. The edit made while offline was lost
//      with a success response.
//
//   3. The retry latch. apiAvailableRef was raised from a bare health check before the
//      sync ran, so a sync that then failed left the flag up — and the retry loop only
//      runs while it is down. Background sync stopped for the rest of the session.
//
// The assertions are made on the recorded requests rather than on state, because in every
// one of these cases the local state looked correct and the server never heard about it.
// ---------------------------------------------------------------------------
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useKQLStorage } from '../useKQLStorage.js';
import { STORAGE_KEY } from '../../constants.js';
import { response, stubFetch, callsTo } from './fetchStub.js';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const RETRY_MS = 30000;

function stored(overrides = {}) {
  return {
    id: ID_A,
    name: 'Encoded PowerShell',
    query: 'DeviceProcessEvents | where ProcessCommandLine has "-enc"',
    description: 'Finds encoded command lines',
    category: 'Detection',
    table: 'DeviceProcessEvents',
    tags: ['powershell'],
    favorite: false,
    usageCount: 7,
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const IMPORT_OK = () => response({ mode: 'insert', imported: 0, inserted: 0, updated: 0, results: [], rejected: [] });

/**
 * Route by path. `queries` is what GET /api/queries answers with; anything the test does
 * not override gets a bland success.
 */
function routes({ queries = [], health = () => response({ status: 'ok', queriesCount: 0 }), onImport = IMPORT_OK } = {}) {
  return (call) => {
    if (call.url.includes('/api/health')) return health(call);
    if (call.url.includes('/api/queries/import')) return onImport(call);
    if (call.url.endsWith('/api/queries')) {
      return call.method === 'POST' ? response(call.body, { status: 201, statusText: 'Created' }) : response(queries);
    }
    return response({ ok: true });
  };
}

/**
 * A working localStorage. jsdom hands this environment an inert object with no methods on
 * it, and the hook's cache path is not the subject here — but it runs on every load, so it
 * has to be real enough not to throw.
 */
function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
    clear: () => { data.clear(); },
    key: (i) => [...data.keys()][i] ?? null,
    get length() { return data.size; },
  };
}

/** Mount the hook and let the initial load settle. */
async function mount(handler) {
  const stub = stubFetch(handler);
  const view = renderHook(() => useKQLStorage());
  await act(async () => {});
  return { ...stub, ...view };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('importQueries — insert mode is the default and is unchanged', () => {
  it('sends only the new rows, in insert mode', async () => {
    const { calls, result } = await mount(routes({ queries: [stored()] }));
    const file = JSON.stringify([
      { ...stored(), name: 'Renamed', updated: '2026-06-01T00:00:00.000Z' },
      stored({ id: ID_B, name: 'Second', query: 'SigninLogs | take 1' }),
    ]);

    let report;
    await act(async () => { report = await result.current.importQueries(file); });

    const [req] = callsTo(calls, '/api/queries/import', 'POST');
    expect(req.body.mode).toBe('insert');
    expect(req.body.queries.map((q) => q.id)).toEqual([ID_B]);
    expect(report).toMatchObject({ mode: 'insert', added: 1, skipped: 1, updated: 0 });
  });

  it('reports a collision as updatable without acting on it', async () => {
    // This is the whole point of the classification in insert mode: the user is told an
    // update exists rather than being told "Duplicate ID" and left to guess.
    const { result } = await mount(routes({ queries: [stored()] }));
    const file = JSON.stringify([{ ...stored(), name: 'Renamed', updated: '2026-06-01T00:00:00.000Z' }]);

    let report;
    await act(async () => { report = await result.current.importQueries(file); });

    expect(report).toMatchObject({ updatable: 1, updated: 0, skipped: 1 });
    expect(result.current.queries[0].name).toBe('Encoded PowerShell');
  });

  it.each([
    ['no options at all', undefined],
    ['a forwarded click event', { type: 'click', target: {}, preventDefault() {} }],
    ['an unrecognised mode', { mode: 'overwrite' }],
  ])('refuses to overwrite given %s', async (_label, options) => {
    const { calls, result } = await mount(routes({ queries: [stored()] }));
    const file = JSON.stringify([{ ...stored(), name: 'Renamed', updated: '2026-06-01T00:00:00.000Z' }]);

    await act(async () => { await result.current.importQueries(file, options); });

    expect(callsTo(calls, '/api/queries/import', 'POST')).toHaveLength(0);
    expect(result.current.queries[0].name).toBe('Encoded PowerShell');
  });
});

describe('importQueries — upsert mode', () => {
  it('sends the newer collisions with mode upsert and merges them locally', async () => {
    const { calls, result } = await mount(routes({ queries: [stored()] }));
    const file = JSON.stringify([{
      ...stored(),
      name: 'Encoded PowerShell v2',
      usageCount: 0,
      created: '2026-05-05T00:00:00.000Z',
      updated: '2026-06-01T00:00:00.000Z',
    }]);

    let report;
    await act(async () => { report = await result.current.importQueries(file, { mode: 'upsert' }); });

    const [req] = callsTo(calls, '/api/queries/import', 'POST');
    expect(req.body.mode).toBe('upsert');
    expect(req.body.queries).toHaveLength(1);
    expect(req.body.queries[0]).toMatchObject({
      id: ID_A,
      name: 'Encoded PowerShell v2',
      // The server's own merge rules, applied to the optimistic copy so the two agree.
      created: '2026-01-01T00:00:00.000Z',
      usageCount: 7,
    });
    expect(report).toMatchObject({ mode: 'upsert', updated: 1, added: 0, skipped: 0 });
    expect(result.current.queries[0].name).toBe('Encoded PowerShell v2');
  });

  it('carries the new rows in the same request as the updates', async () => {
    const { calls, result } = await mount(routes({ queries: [stored()] }));
    const file = JSON.stringify([
      { ...stored(), name: 'Renamed', updated: '2026-06-01T00:00:00.000Z' },
      stored({ id: ID_B, name: 'Second', query: 'SigninLogs | take 1' }),
    ]);

    await act(async () => { await result.current.importQueries(file, { mode: 'upsert' }); });

    const [req] = callsTo(calls, '/api/queries/import', 'POST');
    expect(req.body.queries.map((q) => q.id)).toEqual([ID_B, ID_A]);
  });

  it('leaves an older or identical collision alone even when asked to upsert', async () => {
    const { calls, result } = await mount(routes({ queries: [stored()] }));
    const file = JSON.stringify([
      { ...stored(), name: 'Stale rename', updated: '2025-01-01T00:00:00.000Z' },
      stored({ id: ID_B, name: 'Same', query: 'SigninLogs | take 1' }),
    ]);
    // The second row collides with nothing, so it is an add; the first is older.
    let report;
    await act(async () => { report = await result.current.importQueries(file, { mode: 'upsert' }); });

    expect(report).toMatchObject({ older: 1, updated: 0, added: 1, skipped: 1 });
    expect(callsTo(calls, '/api/queries/import', 'POST')[0].body.queries.map((q) => q.id)).toEqual([ID_B]);
    expect(result.current.queries.find((q) => q.id === ID_A).name).toBe('Encoded PowerShell');
  });

  it('records the fields that changed on the update detail', async () => {
    const { result } = await mount(routes({ queries: [stored()] }));
    const file = JSON.stringify([{ ...stored(), name: 'Renamed', tags: ['powershell', 'lolbin'], updated: '2026-06-01T00:00:00.000Z' }]);

    let report;
    await act(async () => { report = await result.current.importQueries(file, { mode: 'upsert' }); });

    const detail = report.details.find((d) => d.status === 'updated');
    expect(detail.changedFields).toEqual(['name', 'tags']);
    expect(detail.reason).toBe('Changes: name, tags');
  });
});

describe('importQueries — the API no longer fails quietly', () => {
  it('surfaces rows the server refused, which the client had accepted', async () => {
    const { result } = await mount(routes({
      queries: [],
      onImport: () => response({
        mode: 'insert', imported: 0, inserted: 0, updated: 0,
        results: [], rejected: [{ index: 0, reason: '"tags" exceeds 20 entries' }],
      }),
    }));

    let report;
    await act(async () => { report = await result.current.importQueries(JSON.stringify([stored()])); });

    expect(report.apiRejected).toBe(1);
    expect(report.errors).toBe(1);
    expect(report.details.some((d) => d.reason === 'Server rejected: "tags" exceeds 20 entries')).toBe(true);
  });

  it('reports the server message when the import request itself is refused', async () => {
    const { result } = await mount(routes({
      queries: [],
      onImport: () => response({ error: '"queries" exceeds 1000 entries' }, { status: 400, statusText: 'Bad Request' }),
    }));

    let report;
    await act(async () => { report = await result.current.importQueries(JSON.stringify([stored()])); });

    expect(report.apiError).toContain('"queries" exceeds 1000 entries');
    // The rows are still in the cache, so this is not counted as an import error — but it
    // is no longer invisible.
    expect(report.added).toBe(1);
    expect(report.errors).toBe(0);
  });

  it('reports a file it cannot read without contacting the API', async () => {
    const { calls, result } = await mount(routes({ queries: [] }));

    let report;
    await act(async () => { report = await result.current.importQueries('{ not json'); });

    expect(report.errors).toBe(1);
    expect(report.details[0].error).toMatch(/^Invalid JSON:/);
    expect(callsTo(calls, '/api/queries/import', 'POST')).toHaveLength(0);
  });
});

describe('the background retry latch', () => {
  it('stays armed when a sync attempt fails', async () => {
    // The health check passes but the store is unreadable — a pod that is up with a
    // broken volume, which is exactly the state the retry loop exists for.
    const { calls } = await mount((call) => {
      if (call.url.includes('/api/health')) return response({ status: 'ok', queriesCount: 0 });
      return undefined; // GET /api/queries never answers
    });

    expect(callsTo(calls, '/api/health')).toHaveLength(0);

    await act(async () => { await vi.advanceTimersByTimeAsync(RETRY_MS); });
    expect(callsTo(calls, '/api/health')).toHaveLength(1);

    // The flag must still be down, so the next tick tries again. Before the fix the
    // health check itself raised it and this second tick did nothing, permanently.
    await act(async () => { await vi.advanceTimersByTimeAsync(RETRY_MS); });
    expect(callsTo(calls, '/api/health')).toHaveLength(2);

    await act(async () => { await vi.advanceTimersByTimeAsync(RETRY_MS); });
    expect(callsTo(calls, '/api/health')).toHaveLength(3);
  });

  it('disarms once the data has actually round-tripped', async () => {
    let apiUp = false;
    const { calls } = await mount((call) => {
      if (call.url.includes('/api/health')) return apiUp ? response({ status: 'ok', queriesCount: 1 }) : undefined;
      if (call.url.includes('/api/queries/import')) return IMPORT_OK();
      return apiUp ? response([stored()]) : undefined;
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(RETRY_MS); });
    expect(callsTo(calls, '/api/health')).toHaveLength(1);

    apiUp = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(RETRY_MS); });
    expect(callsTo(calls, '/api/health')).toHaveLength(2);

    // Sync succeeded, so the loop stands down and stops polling.
    await act(async () => { await vi.advanceTimersByTimeAsync(RETRY_MS * 3); });
    expect(callsTo(calls, '/api/health')).toHaveLength(2);
  });

  it('does not attempt a sync while the health check is still failing', async () => {
    const { calls } = await mount(() => undefined);

    await act(async () => { await vi.advanceTimersByTimeAsync(RETRY_MS * 2); });

    expect(callsTo(calls, '/api/health')).toHaveLength(2);
    expect(callsTo(calls, '/api/queries/import', 'POST')).toHaveLength(0);
  });

  it('pushes offline work up in upsert mode so an offline edit is not discarded', async () => {
    // Seed the cache the way a session that worked offline would leave it, then let the
    // API come back. Under insert semantics the server keeps its older copy and answers
    // 200 — the edit vanishes with a success response.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      schemaVersion: 4,
      queries: [stored({ name: 'Edited while offline', updated: '2026-06-01T00:00:00.000Z' })],
      meta: { lastUpdated: '2026-06-01T00:00:00.000Z', totalQueries: 1 },
    }));

    let apiUp = false;
    const { calls } = await mount((call) => {
      if (call.url.includes('/api/health')) return apiUp ? response({ status: 'ok', queriesCount: 1 }) : undefined;
      if (call.url.includes('/api/queries/import')) return apiUp ? IMPORT_OK() : undefined;
      return apiUp ? response([stored({ name: 'Edited while offline', updated: '2026-06-01T00:00:00.000Z' })]) : undefined;
    });

    apiUp = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(RETRY_MS); });

    const [req] = callsTo(calls, '/api/queries/import', 'POST');
    expect(req.body.mode).toBe('upsert');
    expect(req.body.queries[0].name).toBe('Edited while offline');
  });
});

describe('write failures carry the server\'s reason', () => {
  it('names the rejected field when a save is refused', async () => {
    const { result } = await mount((call) => {
      if (call.url.includes('/api/health')) return response({ status: 'ok', queriesCount: 0 });
      if (call.url.endsWith('/api/queries') && call.method === 'GET') return response([]);
      return response({ error: '"name" exceeds 200 characters' }, { status: 400, statusText: 'Bad Request' });
    });

    let ok;
    await act(async () => { ok = await result.current.saveQuery(stored({ id: undefined })); });

    expect(ok).toBe(false);
    expect(result.current.error).toContain('"name" exceeds 200 characters');
    expect(result.current.savingState).toBe('error');
  });

  it('says a delete only happened locally, and why', async () => {
    const { result } = await mount((call) => {
      if (call.url.includes('/api/health')) return response({ status: 'ok', queriesCount: 1 });
      if (call.method === 'DELETE') return response({ error: 'Query not found' }, { status: 404, statusText: 'Not Found' });
      return response([stored()]);
    });

    await act(async () => { await result.current.deleteQuery(ID_A); });

    expect(result.current.error).toContain('Query not found');
    expect(result.current.error).toMatch(/removed locally only/);
  });
});
