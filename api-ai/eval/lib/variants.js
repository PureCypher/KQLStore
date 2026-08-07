// ---------------------------------------------------------------------------
// Prompt variants for the eval harness.
//
// As of the implementation commit that followed the 2026-08 investigation, the
// production prompt IS the measured `combo` shape (few-shot worked example +
// numbered rules + self-check + query-parameter rules). `baseline` therefore
// means "what production sends today", and `legacy` reconstructs the pre-combo
// prompt so old-vs-new stays measurable. The historical single-lever variants
// (fewshot/checklist/selfcheck/tooldesc) were merged into production and removed
// here; their measurements live in the investigation report and, locally, in the
// gitignored results directories.
//
// `legacy` is built by marker-spliced surgery on the LIVE prompt, so it throws
// rather than silently drifting if lib/ollama.js changes shape.
// ---------------------------------------------------------------------------
const { PROPOSE_TOOL, systemPrompt } = require('../../lib/ollama');

const FEWSHOT_START = 'Worked example of a good exchange:';
const SELFCHECK_END = 'Fix any violation before you propose.';
const SCHEMAS_MARK = '\nAvailable table schemas:';

// The pre-combo best-practices prose, verbatim from lib/ollama.js as of PR #51,
// kept so the old prompt stays reconstructable after the checklist replaced it.
const LEGACY_BEST_PRACTICES = [
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

/** Everything before the worked example, and everything from the schemas block on. */
function splitPrompt(schemas, knownTables) {
  const full = systemPrompt(schemas, knownTables);
  const start = full.indexOf(FEWSHOT_START);
  const checkEnd = full.indexOf(SELFCHECK_END);
  const schemasAt = full.indexOf(SCHEMAS_MARK);
  if (start < 0 || checkEnd < 0 || schemasAt < 0 || !(start < checkEnd && checkEnd < schemasAt)) {
    throw new Error('variant markers not found — lib/ollama.js systemPrompt changed shape');
  }
  return { before: full.slice(0, start), after: full.slice(schemasAt) };
}

/** The pre-combo tool: identical shape, query parameter without the rules text. */
function legacyTool() {
  const t = JSON.parse(JSON.stringify(PROPOSE_TOOL));
  t.function.parameters.properties.query = { type: 'string' };
  return t;
}

const VARIANTS = {
  baseline: (schemas, knownTables) => ({
    system: systemPrompt(schemas, knownTables),
    tool: PROPOSE_TOOL,
  }),
  legacy: (schemas, knownTables) => {
    const { before, after } = splitPrompt(schemas, knownTables);
    return { system: before + LEGACY_BEST_PRACTICES + '\n' + after, tool: legacyTool() };
  },
};

function buildVariant(name, schemas, knownTables) {
  const fn = VARIANTS[name];
  if (!fn) throw new Error(`unknown prompt variant: ${name}`);
  return fn(schemas, knownTables);
}

module.exports = { buildVariant, VARIANTS };
