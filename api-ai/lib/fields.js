// ---------------------------------------------------------------------------
// Field-level redaction for one request.
//
// lib/redact.js works on a single string. This works on the three fields that make up a
// query, sharing ONE marker namespace across them: a watchlist name appearing in both the
// description and the query body must become the same placeholder in both. Two
// placeholders for one value tells the model they are two different things, and it will
// write a query that treats them as such.
//
// Unlike the backup job, this redaction is allowed to substitute globally (every
// occurrence of a value becomes its marker). The job keeps match-local replacement for
// byte-identical commits; the AI service wants the model to see a consistent picture, and
// the marker -> original mapping is held client-side for the conversation, so there is no
// committed-output contract here to preserve.
// ---------------------------------------------------------------------------
const { scan } = require('./redact');

const FIELDS = ['name', 'description', 'query'];

/** <PRIVATE_IPV4_1>, <EMAIL_2>. Typed and readable, on purpose — see redact.js's header. */
const makeMarker = (rule, index) => `<${rule.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${index}>`;

/** Every SECRET hit across the fields, as {rule, field}. Values are deliberately dropped. */
function collectSecrets(fields) {
  const out = [];
  for (const field of FIELDS) {
    const text = fields[field];
    if (typeof text !== 'string') continue;
    for (const hit of scan(text).secrets) out.push({ rule: hit.rule, field });
  }
  return out;
}

function redactFields(fields, allow = new Set()) {
  const assigned = new Map();
  const applied = [];
  const redacted = {};

  for (const field of FIELDS) {
    const text = fields[field];
    if (typeof text !== 'string' || !text) continue;
    for (const { rule, value } of scan(text).disclosures) {
      if (allow.has(value.toLowerCase()) || assigned.has(value)) continue;
      const marker = makeMarker(rule, assigned.size + 1);
      assigned.set(value, marker);
      applied.push({ rule, value, marker });
    }
  }

  // Longest first: replacing a short value cannot then corrupt a longer one containing it.
  const ordered = [...assigned].sort((a, b) => b[0].length - a[0].length);
  for (const field of FIELDS) {
    const text = fields[field];
    if (typeof text !== 'string') continue;
    let out = text;
    for (const [value, marker] of ordered) out = out.split(value).join(marker);
    redacted[field] = out;
  }

  return { redacted, applied };
}

/** Put the originals back. Used on the model's response, where markers may have moved. */
function unredact(text, applied) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const { value, marker } of applied) out = out.split(marker).join(value);
  return out;
}

module.exports = { FIELDS, makeMarker, collectSecrets, redactFields, unredact };
