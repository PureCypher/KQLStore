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
        description: {
          type: 'string',
          description: 'A prose summary of what the query detects and how, then a blank line, then a line reading exactly "Use Case:" followed by one "- " bullet per use case.',
        },
        query: { type: 'string' },
        // Absent until now, which is why a new query kept the editor's 'Custom' default
        // however plainly its KQL read from a known table: the field was unproposable.
        table: {
          type: 'string',
          description: 'The primary table the query reads from, exactly as it is spelled in KQL — for example SigninLogs, DeviceProcessEvents. Use Custom only when the table is not one of the known Sentinel or Defender tables.',
        },
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

// Distilled from learn.microsoft.com/kusto/query/best-practices (2025-06-09 revision).
// Kept compact on purpose: this rides every conversation turn. The event-time guidance
// splits the operator's concern in two — the RANGE filter stays on the indexed ingestion
// timestamp (that is Microsoft's first rule: datetime predicates use the shard index),
// while the ANALYSIS uses the semantically correct column when the table has one.
const KQL_BEST_PRACTICES = [
  'KQL best practices — apply them to every query you write or rewrite:',
  '- Filter early: `where` immediately after the table reference; datetime-column predicates first (they use the shard index), then term-level string/dynamic predicates ordered by selectivity, then numeric predicates, then unindexed scans last.',
  "- Time semantics: filter the time RANGE on the table's indexed timestamp (TimeGenerated in Sentinel tables, Timestamp in Defender XDR tables). When the table carries a more meaningful event-time column, use THAT column for the analysis — projection, bin(), sorting, correlation. Example: SigninLogs' CreatedDateTime is the sign-in initiation time; prefer it over TimeGenerated in output and logic.",
  '- Strings: prefer `has`/`has_cs` over `contains`; prefer case-sensitive `==`, `in`, `contains_cs` over `=~`, `in~`. For case-insensitive matching use `Col =~ "value"`, never `tolower(Col) == "value"`. Search specific columns; never `search *`.',
  '- Dynamic columns: when looking for a rare value, pre-filter with `where DynamicCol has "value"` before `where DynamicCol.key == "value"`, so JSON parsing runs only on the survivors.',
  '- Filter on table columns, not calculated ones: `T | where predicate(Expr)`, not `T | extend v = Expr | where predicate(v)`.',
  '- Project only the columns the query needs, as early as the logic allows.',
  '- Joins: put the table with the fewest rows on the left; use `in` instead of a left-semi join to filter on one column; use `lookup` when the right side is a small dimension table; `hint.strategy=broadcast` when the left side is under ~100MB; `hint.shufflekey=<key>` when both sides are large or a summarize groups by keys with millions of distinct values.',
  '- Reuse: wrap a subquery referenced more than once in `let` + `materialize()`, pushing filters and projections inside the materialized expression.',
  '- Parsing: one `parse` statement for strings sharing a format instead of several `extract()` calls; `extract()` only for irregular patterns.',
  '- Exploration: while a query is untested, end it with `| take <n>` or a `count` so it stays bounded.',
].join('\n');

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
    // The library's own convention, counted across the stored descriptions rather than
    // invented: "Use Case:" then one "- " bullet per case, each a full sentence.
    'A description follows the library house style: a prose paragraph saying what the query',
    'detects and how, then a blank line, then a line reading exactly "Use Case:", then one',
    'bullet per use case, each starting with "- " on its own line and written as a full',
    'sentence. For example:',
    '',
    'Detects failed sign-ins from a single source against many distinct accounts.',
    '',
    'Use Case:',
    '- Detect password spraying against numerous accounts from one source.',
    '- Identify brute-force attempts against a small number of accounts.',
    '',
    'Two fields are easy to leave behind and should not be. Whenever you propose or rewrite a',
    'query, also set `table` to the primary table the query reads from, spelled exactly as it',
    'appears in the KQL — the editor defaults it to Custom and only you can correct that. And',
    'propose `falsePositives`: at least two concrete benign situations that would trigger this',
    'detection, each naming the activity rather than saying "legitimate use" — a maintenance',
    'window, a vulnerability scanner, a shared NAT egress address, a service account with an',
    'expired password. They are what makes a detection tunable by whoever inherits it.',
    '',
    KQL_BEST_PRACTICES,
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
