// ---------------------------------------------------------------------------
// Ollama Cloud request construction.
//
// OLLAMA_URL is read once at module load but the key is read per request, and the
// model comes from env at request time too, so the defaults here are just the
// fallback when the environment says nothing.
// ---------------------------------------------------------------------------
const OLLAMA_URL = process.env.OLLAMA_URL || 'https://ollama.com/api/chat';

// Ollama Cloud does not support the `format` JSON-schema parameter (re-verified
// 2026-08-02 — the docs still say so and GitHub issues #12362/#13967 remain open), so
// this tool definition is the only structure available. It is a request, not a
// guarantee: the model can return fields that do not validate, and the client's review
// gate (src/domain/proposal.js) is what makes that safe. Do not remove that gate on the
// strength of this schema.
//
// Note the schema stays plain JSON Schema on purpose: Cloud rejects tool schemas that
// use oneOf/anyOf with a 400 (issue #13967), so the proposal fields are all plain
// properties and arrays.
const PROPOSE_TOOL = {
  type: 'function',
  function: {
    name: 'propose_query',
    description: 'Propose changes to the query being edited. Only include fields you are changing.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        query: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        severity: { type: 'string', enum: ['Informational', 'Low', 'Medium', 'High', 'Critical'] },
        attack: {
          type: 'object',
          properties: {
            tactics: { type: 'array', items: { type: 'string' } },
            techniques: { type: 'array', items: { type: 'string' } },
          },
        },
        falsePositives: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

function systemPrompt(schemas, knownTables = []) {
  const rendered = schemas.map((s) => {
    const cols = s.columns.map((c) => `${c.name}:${c.type}`).join(', ');
    return `${s.name}\n  columns: ${cols}${s.notes ? `\n  notes: ${s.notes}` : ''}`;
  }).join('\n\n');

  const lines = [
    'You help a detection engineer adapt KQL queries for Microsoft Sentinel and Defender XDR.',
    'Only use columns that appear in the schemas below. If a needed column is absent, say so rather than inventing one.',
    'Values written as <SOMETHING_1> are redacted placeholders. Keep them exactly as they are; never guess what they stood for.',
    'When you change the query or its metadata, call propose_query. Explain your reasoning in the message text.',
    '',
    'Available table schemas:',
    rendered || '(none provided)',
  ];

  // The client sends full schemas only for tables the conversation names; the rest of
  // the store arrives as bare names so the model can still point the operator at a
  // table — whose columns then travel on the next turn once it has been named.
  if (knownTables.length > 0) {
    lines.push(
      '',
      'Other tables that exist (columns not shown — a table named in the conversation gets its schema on the next message):',
      knownTables.join(', '),
    );
  }

  return lines.join('\n');
}

module.exports = { OLLAMA_URL, PROPOSE_TOOL, systemPrompt };
