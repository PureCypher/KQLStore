// ---------------------------------------------------------------------------
// A fetch double for the storage suites.
//
// The point of these tests is the wire: which URL, which method, which body and which
// mode the SPA actually sends, and what it makes of the response it gets back. So the
// stub records requests rather than pretending to be a server, and the assertions are
// made against the recording.
//
// The response object enforces single-read semantics on the body, which a real Response
// also does. Without that, a call site that read res.json() and then handed the same
// response to the error path would pass here and throw "body stream already read" in the
// browser — the one place the mistake is expensive.
// ---------------------------------------------------------------------------
import { vi } from 'vitest';

/** Build a stub Response. `body` may be an object (encoded as JSON) or a raw string. */
function response(body, { status = 200, statusText = 'OK', contentType = 'application/json' } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  let used = false;
  const consume = () => {
    if (used) throw new TypeError('body stream already read');
    used = true;
    return raw;
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    async text() { return consume(); },
    async json() { return JSON.parse(consume()); },
  };
}

/** A response with no body at all, as a 204 or a proxy timeout can be. */
function emptyResponse({ status = 500, statusText = '' } = {}) {
  return response('', { status, statusText, contentType: 'text/plain' });
}

/**
 * Install a global fetch that routes through `handler({ url, method, body })`.
 *
 * Returning undefined from the handler is how a test says "nothing answered": fetch
 * rejects with a TypeError, exactly as it does when the pod is unreachable.
 */
function stubFetch(handler) {
  const calls = [];
  const fn = vi.fn(async (url, init = {}) => {
    const call = {
      url,
      method: init.method || 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      credentials: init.credentials,
    };
    calls.push(call);
    const res = await handler(call);
    if (!res) throw new TypeError('Failed to fetch');
    return res;
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

/** Requests to a path, in order. Handy because every suite asserts on one endpoint. */
function callsTo(calls, path, method) {
  return calls.filter((c) => c.url.includes(path) && (!method || c.method === method));
}

export { response, emptyResponse, stubFetch, callsTo };
