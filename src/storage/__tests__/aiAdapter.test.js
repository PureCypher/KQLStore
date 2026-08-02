// ---------------------------------------------------------------------------
// StorageAdapter's AI methods, at the wire.
//
// These exist because of a defect the component suites could not see. aiRedact
// originally threw on ANY non-ok status, including the 422 the service returns for
// "this query carries a credential". That 422 is not a failure — its body is the
// answer, and it is what RedactionPreview needs to name the rules that fired and
// offer no way through. Throwing it collapsed the whole blocked state into a generic
// error line, so the operator was told "something went wrong" instead of "this
// contains an AWS access key id".
//
// The component tests passed throughout, because they pass `blocked` in as a prop and
// never exercise the adapter. Found by driving the running app; pinned here.
// ---------------------------------------------------------------------------
import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import { StorageAdapter } from '../adapter.js';
import { response, stubFetch, callsTo } from './fetchStub.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const BLOCKED_BODY = {
  blocked: true,
  secrets: [{ rule: 'AWS access key id', field: 'query' }],
  error: 'This query appears to contain a credential. Remove it before using AI assistance.',
};

describe('aiRedact', () => {
  it('returns the mapping for a clean request', async () => {
    stubFetch(() => response({
      redacted: { query: 'IP == "<PRIVATE_IPV4_1>"' },
      applied: [{ rule: 'Private IPv4', value: '10.1.2.3', marker: '<PRIVATE_IPV4_1>' }],
      blocked: false,
    }));
    const out = await StorageAdapter.aiRedact({ query: 'IP == "10.1.2.3"' });
    expect(out.blocked).toBe(false);
    expect(out.applied[0].marker).toBe('<PRIVATE_IPV4_1>');
  });

  it('RESOLVES a 422 blocked response rather than throwing it', async () => {
    // The regression. A rejected promise here means the blocked gate never renders.
    stubFetch(() => response(BLOCKED_BODY, { status: 422, statusText: 'Unprocessable Entity' }));
    const out = await StorageAdapter.aiRedact({ query: 'let k = "AKIA…";' });
    expect(out.blocked).toBe(true);
    expect(out.secrets).toEqual([{ rule: 'AWS access key id', field: 'query' }]);
  });

  it('still throws on a real failure', async () => {
    stubFetch(() => response({ error: 'Internal error' }, { status: 500, statusText: 'Internal Server Error' }));
    await expect(StorageAdapter.aiRedact({ query: 'x' })).rejects.toThrow(/500/);
  });

  it('sends the fields under a "fields" key, as the route requires', async () => {
    const { calls } = stubFetch(() => response({ redacted: {}, applied: [], blocked: false }));
    await StorageAdapter.aiRedact({ name: 'n', description: 'd', query: 'q' });
    const [call] = callsTo(calls, '/api/ai/redact', 'POST');
    expect(call.body).toEqual({ fields: { name: 'n', description: 'd', query: 'q' } });
  });
});

describe('aiHealth', () => {
  it('returns the body when the service is up, so the caller can read the model', async () => {
    stubFetch(() => response({ status: 'ok', model: 'deepseek-v4-flash:cloud', configured: true }));
    const out = await StorageAdapter.aiHealth();
    expect(out.model).toBe('deepseek-v4-flash:cloud');
  });

  it('returns false when the service is scaled to zero rather than throwing', async () => {
    // A missing AI service is the normal disabled state, not an error: the SPA must
    // hide the assist toggle and carry on, never surface a failure to the user.
    stubFetch(() => undefined);
    await expect(StorageAdapter.aiHealth()).resolves.toBe(false);
  });

  it('returns false on a non-ok response', async () => {
    stubFetch(() => response('', { status: 502, statusText: 'Bad Gateway', contentType: 'text/html' }));
    await expect(StorageAdapter.aiHealth()).resolves.toBe(false);
  });
});

describe('aiChat', () => {
  it('returns the raw Response so the caller can read the NDJSON stream', async () => {
    stubFetch(() => response('{"type":"text","value":"hi"}\n', { contentType: 'application/x-ndjson' }));
    const res = await StorageAdapter.aiChat({ messages: [], schemas: [], draft: {}, allowVerbatim: false });
    // Not parsed here: this endpoint streams, so the adapter must hand back the Response.
    expect(typeof res.text).toBe('function');
    expect(res.ok).toBe(true);
  });

  it('does not throw on a 503, so the panel can read the reason out of the body', async () => {
    stubFetch(() => response({ error: 'AI service is not configured' }, { status: 503, statusText: 'Service Unavailable' }));
    const res = await StorageAdapter.aiChat({ messages: [], schemas: [], draft: {}, allowVerbatim: false });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/not configured/);
  });
});
