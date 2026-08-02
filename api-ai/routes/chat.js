// ---------------------------------------------------------------------------
// POST /api/ai/chat — the streaming conversation endpoint.
//
// Flow: refuse if the key is absent (503); refuse if anything carries a credential
// (422 — the override covers disclosures, never secrets); redact the draft unless
// allowVerbatim; forward to Ollama Cloud as a streaming chat with the propose_query
// tool; relay text chunks as NDJSON; on the final event, un-redact the tool-call
// arguments and emit them as a proposal.
//
// Two things never happen here:
//   * The OLLAMA_API_KEY never appears in a response, a log line, or an error
//     message. The Authorization header is set from process.env and nothing echoes it.
//   * An upstream error body is never relayed — Ollama can echo the request in an
//     error, and the request contains query text. On any non-ok response the caller
//     gets a fixed string.
// ---------------------------------------------------------------------------
const { Router } = require('express');
const { collectSecrets, redactFields, unredact } = require('../lib/fields');
const { OLLAMA_URL, PROPOSE_TOOL, systemPrompt } = require('../lib/ollama');

const router = Router();

const MODEL = () => process.env.OLLAMA_MODEL || 'deepseek-v4-flash:cloud';

/** Recursively substitute markers for originals in every string of a parsed object. */
function unredactDeep(value, applied) {
  if (typeof value === 'string') return unredact(value, applied);
  if (Array.isArray(value)) return value.map((v) => unredactDeep(v, applied));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = unredactDeep(v, applied);
    return out;
  }
  return value;
}

/** Split a streamed NDJSON body into JSON events, tolerating lines split across chunks. */
async function* readEvents(body) {
  let buffer = '';
  // undici's fetch yields plain Uint8Array chunks, never Buffer. Buffer.isBuffer()
  // was false for every real chunk, String(chunk) rendered them as comma-joined byte
  // values, and every line failed JSON.parse — the stream came back empty in
  // production while Buffer-based test mocks passed. TextDecoder handles Buffer,
  // Uint8Array and multi-byte UTF-8 split across chunk boundaries.
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; } // partial JSON on the wire: skip
      if (evt) yield evt;
    }
  }
}

/** All message text plus the draft, as one blob for secret scanning. */
function collectAllSecrets(messages, draft) {
  const out = collectSecrets(draft);
  for (const m of messages) {
    if (typeof m?.content === 'string' && m.content) {
      // The field name is only for reporting; message text is scanned as the query slot.
      for (const hit of collectSecrets({ query: m.content })) out.push(hit);
    }
  }
  return out;
}

router.post('/', async (req, res, next) => {
  try {
    const key = process.env.OLLAMA_API_KEY;
    if (!key) {
      // 503, and nothing that names the missing key's purpose beyond "not configured".
      return res.status(503).json({ error: 'AI service is not configured' });
    }

    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const schemas = Array.isArray(body.schemas) ? body.schemas : [];
    // Bare table names for the system prompt's known-tables line. External input:
    // keep strings only, and bound both count and length so a hostile payload cannot
    // inflate the prompt.
    const knownTables = (Array.isArray(body.knownTables) ? body.knownTables : [])
      .filter((n) => typeof n === 'string' && n.length > 0 && n.length <= 200)
      .slice(0, 1000);
    const draft = {
      name: typeof body.draft?.name === 'string' ? body.draft.name : '',
      description: typeof body.draft?.description === 'string' ? body.draft.description : '',
      query: typeof body.draft?.query === 'string' ? body.draft.query : '',
    };
    const allowVerbatim = body.allowVerbatim === true;

    // Secrets are refused outright, even with allowVerbatim. There is no version of
    // "send the credential anyway" that is correct, and the operator's next move is to
    // remove it from the query.
    const secrets = collectAllSecrets(messages, draft);
    if (secrets.length > 0) {
      return res.status(422).json({
        blocked: true,
        secrets,
        error: 'This query appears to contain a credential. Remove it before using AI assistance.',
      });
    }

    // Redact the draft unless the operator overrode. Message text arrives from the client
    // already redacted (the preview flow redacts on every send); re-redacting it here
    // would need the client's marker mapping, which stays on the client.
    const { redacted, applied } = allowVerbatim
      ? { redacted: draft, applied: [] }
      : redactFields(draft);

    const system = { role: 'system', content: systemPrompt(schemas, knownTables) };
    const draftMessage = {
      role: 'user',
      content: `Current draft:\nName: ${redacted.name}\nDescription: ${redacted.description}\nQuery:\n${redacted.query}`,
    };
    const upstreamMessages = [system, ...messages, draftMessage];

    const upstream = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: MODEL(),
        messages: upstreamMessages,
        tools: [PROPOSE_TOOL],
        stream: true,
      }),
    });

    if (!upstream.ok || !upstream.body) {
      // Never relay the upstream body: it can echo the request, and the request contains
      // query text. The fixed string is all the caller needs.
      return res.json({ type: 'error', value: 'The model service failed.' });
    }

    res.setHeader('Content-Type', 'application/x-ndjson');

    const toolCalls = [];
    for await (const evt of readEvents(upstream.body)) {
      const content = evt?.message?.content;
      if (typeof content === 'string' && content) {
        res.write(JSON.stringify({ type: 'text', value: content }) + '\n');
      }
      if (Array.isArray(evt?.message?.tool_calls)) {
        for (const call of evt.message.tool_calls) {
          if (call?.function?.arguments) toolCalls.push(call.function.arguments);
        }
      }
      if (evt?.done) break;
    }

    // Ollama serialises tool-call arguments as JSON strings; tolerate an object in case
    // a future version stops doing that.
    const proposals = toolCalls.map((args) => {
      let parsed = args;
      if (typeof args === 'string') {
        try { parsed = JSON.parse(args); } catch { return null; }
      }
      return parsed && typeof parsed === 'object' ? unredactDeep(parsed, applied) : null;
    }).filter(Boolean);

    if (proposals.length > 0) {
      res.write(JSON.stringify({ type: 'proposal', fields: proposals[0] }) + '\n');
    }
    res.end();
  } catch (err) {
    // If the stream broke before any header was sent, express's error handler answers.
    // If headers were already sent, end the stream so the client stops waiting.
    if (res.headersSent) { res.end(); return; }
    next(err);
  }
});

module.exports = router;
