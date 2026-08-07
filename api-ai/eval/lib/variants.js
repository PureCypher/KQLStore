// ---------------------------------------------------------------------------
// Prompt variants for the eval harness.
//
// Every variant is a surgical edit of the LIVE systemPrompt() output, spliced at
// marker lines, so a variant differs from baseline by exactly the change under
// test — if lib/ollama.js changes, the markers throw rather than silently
// measuring against a stale prompt. Variants may also swap the tool definition
// (the `tooldesc` lever). Nothing here is production code.
// ---------------------------------------------------------------------------
const { PROPOSE_TOOL, systemPrompt } = require('../../lib/ollama');

const BP_START = 'KQL best practices — apply them to every query you write or rewrite:';
const BP_END = '\nAvailable table schemas:';

function splitPrompt(schemas, knownTables) {
  const full = systemPrompt(schemas, knownTables);
  const start = full.indexOf(BP_START);
  const end = full.indexOf(BP_END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error('variant markers not found — lib/ollama.js systemPrompt changed shape');
  }
  return {
    before: full.slice(0, start),          // intro + house style, ends just before BP block
    practices: full.slice(start, end),     // the best-practices block (trailing blank line included)
    after: full.slice(end),                // '\nAvailable table schemas:' onward
  };
}

// The same ten rules, restated as an imperative numbered checklist. No rule is
// dropped; only the phrasing changes. This is the `checklist` lever.
const CHECKLIST_RULES = [
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

// One compact worked example: request → reasoning → propose_query arguments.
// This is the `fewshot` lever; it rides every turn, so its token cost is part of
// what the eval measures.
//
// The multi-line string values are rendered with REAL newlines, not \n escapes:
// an earlier revision showed the JSON-encoded form and the model copied literal
// backslash-n into 9 of 11 proposed descriptions. Show the model what the field
// should contain, not how JSON encodes it.
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
  '',
].join('\n');

// The `selfcheck` lever: an explicit pre-call verification pass.
const SELF_CHECK = [
  'Before calling propose_query, verify silently:',
  '1. Every column you reference exists in the schemas below for the table you read it from. If one does not, remove it and say which column is missing instead of inventing it.',
  '2. The time-RANGE filter is on TimeGenerated (Sentinel) or Timestamp (Defender XDR) and is the first pipe.',
  '3. The description matches the house style exactly: prose, blank line, "Use Case:", "- " bullets.',
  '4. table, category and falsePositives are all set.',
  'Fix any violation before you propose.',
  '',
].join('\n');

// The `tooldesc` lever: restate the three highest-leverage KQL rules inside the
// tool's own parameter description, where the model reads them at call time.
const QUERY_PARAM_RULES = 'The KQL query text. Requirements: the first pipe after the table reference filters the time range on the indexed timestamp (TimeGenerated for Sentinel, Timestamp for Defender XDR); string predicates use has/has_cs or case-sensitive ==/in, not contains or =~; only columns present in the provided table schemas may be referenced.';

function toolWithQueryRules() {
  const t = JSON.parse(JSON.stringify(PROPOSE_TOOL));
  t.function.parameters.properties.query = { type: 'string', description: QUERY_PARAM_RULES };
  return t;
}

const VARIANTS = {
  baseline: (schemas, knownTables) => ({
    system: systemPrompt(schemas, knownTables),
    tool: PROPOSE_TOOL,
  }),
  checklist: (schemas, knownTables) => {
    const { before, after } = splitPrompt(schemas, knownTables);
    return { system: before + CHECKLIST_RULES + '\n' + after, tool: PROPOSE_TOOL };
  },
  fewshot: (schemas, knownTables) => {
    const { before, practices, after } = splitPrompt(schemas, knownTables);
    return { system: before + FEWSHOT_EXAMPLE + '\n' + practices + after, tool: PROPOSE_TOOL };
  },
  selfcheck: (schemas, knownTables) => {
    const { before, practices, after } = splitPrompt(schemas, knownTables);
    return { system: before + practices + '\n' + SELF_CHECK + after, tool: PROPOSE_TOOL };
  },
  tooldesc: (schemas, knownTables) => ({
    system: systemPrompt(schemas, knownTables),
    tool: toolWithQueryRules(),
  }),
  combo: (schemas, knownTables) => {
    const { before, after } = splitPrompt(schemas, knownTables);
    return {
      system: before + FEWSHOT_EXAMPLE + '\n' + CHECKLIST_RULES + '\n\n' + SELF_CHECK + after,
      tool: toolWithQueryRules(),
    };
  },
};

function buildVariant(name, schemas, knownTables) {
  const fn = VARIANTS[name];
  if (!fn) throw new Error(`unknown prompt variant: ${name}`);
  return fn(schemas, knownTables);
}

module.exports = { buildVariant, VARIANTS };
