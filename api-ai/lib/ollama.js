// ---------------------------------------------------------------------------
// Ollama Cloud request construction.
//
// OLLAMA_URL is read once at module load but the key is read per request, and the
// model comes from env at request time too, so the defaults here are just the
// fallback when the environment says nothing.
//
// The prompt below is the `combo` variant that measured best in the 2026-08
// quality-gap eval (docs/superpowers/specs/2026-08-06-ai-assist-quality-gap.md §4:
// 100% tool-call rate, 0 schema-visible invented columns, house style 10/11,
// ~2x faster than the prose-block predecessor at +17% prompt tokens). Its pieces —
// the worked example, the numbered rules, the self-check, and the query-parameter
// rules on the tool — were measured one at a time and compose; edit them against
// the eval harness (api-ai/eval/), not by eye.
// ---------------------------------------------------------------------------
const OLLAMA_URL = process.env.OLLAMA_URL || 'https://ollama.com/api/chat';

// Ollama Cloud does not support structured outputs. Re-verified 2026-08-06: the
// `format` JSON-schema parameter is now silently IGNORED (it used to 400), and
// tool schemas with oneOf/anyOf no longer 400 either — but nothing enforces this
// tool's shape at the provider. It is a request, not a guarantee: the model can
// return fields that do not validate, and the client's review gate
// (src/domain/proposal.js) is what makes that safe. Do not remove that gate on
// the strength of this schema.
const QUERY_PARAM_RULES = 'The KQL query text. Requirements: the first pipe after the table reference filters the time range on the indexed timestamp (TimeGenerated for Sentinel, Timestamp for Defender XDR); string predicates use has/has_cs or case-sensitive ==/in, not contains or =~; only columns present in the provided table schemas may be referenced.';

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
        // Deliberate duplication, same convention as the description house style:
        // the core KQL rules live in the system prompt AND here, where the model
        // reads them at call time. Change one, change both, or they drift.
        query: { type: 'string', description: QUERY_PARAM_RULES },
        // Absent until now, which is why a new query kept the editor's 'Custom' default
        // however plainly its KQL read from a known table: the field was unproposable.
        table: {
          type: 'string',
          description: 'The primary table the query reads from, exactly as it is spelled in KQL — for example SigninLogs, DeviceProcessEvents. Use Custom only when the table is not one of the known Sentinel or Defender tables.',
        },
        // Enumerated rather than free text: the SPA validates against this exact
        // vocabulary, so anything else comes back pre-rejected at the review gate.
        // Kept in step with CATEGORIES in src/constants.js.
        category: {
          type: 'string',
          enum: ['Detection', 'Hunting', 'Investigation', 'Monitoring', 'Reporting', 'Enrichment', 'Utility'],
          description: 'What the query is for: Detection for alerting logic, Hunting for exploratory analysis, Investigation for pivoting on a known incident, Monitoring for health and coverage, Reporting for summaries, Enrichment for lookups feeding other queries, Utility for everything else.',
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

// The same requirements the prose block distilled from
// learn.microsoft.com/kusto/query/best-practices (2025-06-09 revision), restated
// as an imperative checklist — the small-model-friendly phrasing that measured
// best. No rule was dropped in the rewrite; the event-time SPLIT in rules 1 and 3
// (range filter on the indexed timestamp, analysis on the semantic event-time
// column) is a settled product decision — do not "simplify" it into filtering on
// CreatedDateTime, that defeats the shard index.
const KQL_RULES = [
  'KQL rules — follow every one of these. Check each before you propose:',
  '1. First pipe after the table reference: `where` on the indexed timestamp — TimeGenerated for Sentinel tables, Timestamp for Defender XDR tables. The time-RANGE filter always goes here.',
  '2. Order the remaining filters: term-level string/dynamic predicates (`has`/`has_cs`) by selectivity first, then numeric predicates, then unindexed scans last.',
  "3. If the table has a real event-time column (example: SigninLogs.CreatedDateTime is the sign-in initiation time), use THAT column for bin(), project, sort and correlation — but NEVER for the range filter in rule 1.",
  '4. Strings: use `has`/`has_cs`, not `contains`. Use case-sensitive `==`, `in`, `contains_cs`, not `=~`, `in~`. If you need case-insensitive matching write `Col =~ "value"`, never `tolower(Col) == "value"`. Search specific columns; never `search *`.',
  '5. Dynamic columns: when looking for a rare value, put `where DynCol has "value"` BEFORE `where DynCol.key == "value"` so JSON parsing runs only on the survivors.',
  '6. Filter on stored table columns directly (`T | where predicate(Expr)`), never on an extended/calculated copy (`T | extend v = Expr | where predicate(v)`).',
  '7. `project` only the columns the query needs, as early as the logic allows.',
  '8. Joins: put the table with the fewest rows on the left. Prefer `in` over a left-semi join to filter on one column. Use `lookup` when the right side is a small dimension table. Add `hint.strategy=broadcast` when the left side is under ~100MB; `hint.shufflekey=<key>` when both sides are large or a summarize groups by keys with millions of distinct values.',
  '9. A subquery referenced more than once: wrap it in `let` + `materialize()`, with filters and projections pushed inside the materialized expression.',
  '10. Use one `parse` statement for strings sharing a format instead of several `extract()` calls; `extract()` only for irregular patterns. While a query is untested, end it with `| take <n>` or a `count` so it stays bounded.',
].join('\n');

// One compact worked example: request → reasoning → propose_query arguments. It
// rides every turn (~400 tokens) and is what moved tool-call reliability to 11/11
// in the eval. The multi-line field values are rendered with REAL newlines, not
// \n escapes: an earlier revision showed the JSON-encoded form and the model
// copied literal backslash-n into 9 of 11 proposed descriptions. Show the model
// what the field should contain, not how JSON encodes it.
const FEWSHOT_EXAMPLE = [
  'Worked example of a good exchange:',
  '',
  'User request: "Find devices beaconing to a single external IP on a regular interval."',
  '',
  'Assistant reasoning (message text): Beaconing shows up as many low-jitter connections from one device to one public IP. I will bucket connection times per device/IP pair and flag pairs with many buckets and low variance. Range filter on Timestamp first, project early, bounded output.',
  '',
  'Then the assistant calls propose_query. Its arguments, with each field\'s real content shown between the field markers:',
  '',
  'name:',
  'Possible beaconing to a single external IP',
  '',
  'description (prose, blank line, "Use Case:" heading, bullets — as actual lines):',
  'Detects devices making regular, repeated connections to one public IP address by bucketing outbound connections per device and remote IP and flagging pairs that appear in most buckets with low interval variance.',
  '',
  'Use Case:',
  '- Surface C2 beaconing that blends into normal traffic volumes.',
  '- Identify unauthorized monitoring agents calling home on a fixed schedule.',
  '',
  'query:',
  'let lookback = 1d;',
  'let bucket = 5m;',
  'DeviceNetworkEvents',
  '| where Timestamp > ago(lookback)',
  '| where RemoteIPType == "Public" and ActionType == "ConnectionSuccess"',
  '| project Timestamp, DeviceId, DeviceName, RemoteIP, RemotePort, InitiatingProcessFileName',
  '| summarize Connections = count(), Buckets = dcount(bin(Timestamp, bucket)), FirstSeen = min(Timestamp), LastSeen = max(Timestamp) by DeviceId, DeviceName, RemoteIP, RemotePort, InitiatingProcessFileName',
  '| where Buckets >= 24 and Connections >= Buckets',
  '| order by Buckets desc',
  '| take 100',
  '',
  'table: DeviceNetworkEvents · category: Hunting · severity: Medium',
  'attack: tactics ["command-and-control"], techniques ["T1071"]',
  'falsePositives: ["Update agents and telemetry collectors that poll a fixed endpoint on a schedule.", "Monitoring probes or uptime checkers running from user devices."]',
].join('\n');

// A cheap pre-call verification pass; in the eval it eliminated schema-visible
// invented columns and, standalone, produced the point-at-the-table behavior on
// no-schema turns instead of a fabricated proposal.
const SELF_CHECK = [
  'Before calling propose_query, verify silently:',
  '1. Every column you reference exists in the schemas below for the table you read it from. If one does not, remove it and say which column is missing instead of inventing it.',
  '2. The time-RANGE filter is on TimeGenerated (Sentinel) or Timestamp (Defender XDR) and is the first pipe.',
  '3. The description matches the house style exactly: prose, blank line, "Use Case:", "- " bullets.',
  '4. table, category and falsePositives are all set.',
  'Fix any violation before you propose.',
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
    'Three fields are easy to leave behind and should not be. Whenever you propose or rewrite a',
    'query, also set `table` to the primary table the query reads from, spelled exactly as it',
    'appears in the KQL — the editor defaults it to Custom and only you can correct that. Set',
    '`category` to what the query is actually for; the editor defaults it to Utility, which is',
    'rarely right for a detection or a hunt. And',
    'propose `falsePositives`: at least two concrete benign situations that would trigger this',
    'detection, each naming the activity rather than saying "legitimate use" — a maintenance',
    'window, a vulnerability scanner, a shared NAT egress address, a service account with an',
    'expired password. They are what makes a detection tunable by whoever inherits it.',
    '',
    FEWSHOT_EXAMPLE,
    '',
    KQL_RULES,
    '',
    SELF_CHECK,
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
