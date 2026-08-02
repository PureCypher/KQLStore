import { describe, it, expect, afterEach, vi } from 'vitest';
import { response, stubFetch, callsTo } from './fetchStub.js';
import { StorageAdapter } from '../adapter.js';

describe('schema adapter', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('fetches the schema list', async () => {
    const { calls } = stubFetch(() => response([
      { name: 'SigninLogs', columns: [], notes: '', source: 'getschema', updated: 'x' },
    ]));
    const out = await StorageAdapter.fetchSchemas();
    expect(out).toHaveLength(1);
    expect(calls[0].url).toBe('/api/schemas');
    expect(calls[0].credentials).toBe('include');
  });

  it('PUTs a schema to its encoded name', async () => {
    const { calls } = stubFetch(() => response({
      name: 'My Table', columns: [], notes: '', source: 'manual', updated: 'x',
    }));
    await StorageAdapter.saveSchema('My Table', { columns: [], notes: '', source: 'manual' });
    const [put] = callsTo(calls, '/api/schemas', 'PUT');
    expect(put.url).toBe('/api/schemas/My%20Table');
    expect(put.body).toEqual({ columns: [], notes: '', source: 'manual' });
  });

  it('surfaces the server message on failure', async () => {
    stubFetch(() => response(
      { error: '"columns" must be an array' },
      { status: 400, statusText: 'Bad Request' },
    ));
    await expect(StorageAdapter.saveSchema('T', { columns: 'nope' }))
      .rejects.toThrow(/"columns" must be an array/);
  });

  it('DELETEs by encoded name', async () => {
    const { calls } = stubFetch(() => response({ deleted: 'T' }));
    await StorageAdapter.deleteSchema('T');
    const [del] = callsTo(calls, '/api/schemas', 'DELETE');
    expect(del.url).toBe('/api/schemas/T');
  });

  it('rejects when the pod is unreachable', async () => {
    stubFetch(() => undefined);
    await expect(StorageAdapter.fetchSchemas()).rejects.toThrow(/Failed to fetch/);
  });
});
