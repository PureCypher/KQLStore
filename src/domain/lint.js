import { ALL_KNOWN_TABLES } from '../constants.js';
import { detectTableFromQuery, getTableDisplayName } from './tables.js';

// ============================================================
// KQL Linter
//
// A pure, dependency-free check for the mistakes that cost a Sentinel or Defender analyst
// real money and real detections: full-table substring scans, queries with no time bound,
// joins whose default kind silently drops rows, and predicates that cannot be answered
// from an index. It is deliberately NOT a parser — it is a lexer plus a set of shape
// checks, because the alternative (a real KQL grammar in the browser bundle) is an order
// of magnitude more code for findings nobody asked for.
//
// The design constraint that shapes everything below is FALSE POSITIVES. A linter that
// fires on correct queries is switched off within a week and then never catches the real
// defect either, so every rule here is written to under-report: it fires only on the shape
// it can be confident about, and stays silent when the intent is ambiguous. Concretely
// that means no rule ever fires on text inside a comment or a string literal, and rules
// that need to know what a value IS (rather than where it is) only fire on literals, never
// on expressions.
//
// Severity contract:
//   error   — the query is wrong: it will fail, or it will silently return the wrong rows.
//   warning — the query works but will scan far more data than it needs to, or its result
//             depends on a default the author probably did not choose.
//   info    — a clearer or cheaper way to express the same thing.
// ============================================================

// ------------------------------------------------------------
// Lexing
// ------------------------------------------------------------

// One alternation, not two passes: whichever of comment/string opens first wins. Splitting
// this into a comments pass and a strings pass is wrong in both orders — comments-first
// lets the // in "https://portal.azure.com" open a comment that swallows the next line,
// strings-first lets the apostrophe in `// don't` open a string. That defect (KQS-039) has
// already been fixed once in the highlighter; it is not being reintroduced here.
const COMMENT_OR_STRING = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|@?"(?:[^"\\\n]|\\.)*"|@?'(?:[^'\\\n]|\\.)*'/g;

const ESCAPES = { n: '\n', r: '\r', t: '\t', '0': '\0' };

/**
 * Lex the query once into everything the rules need.
 *
 * `masked` is the same length as the source with comment bodies and string bodies replaced
 * by spaces — equal length so that any index found in it points at the same character of
 * the original, and so line and column numbers need no translation. String DELIMITERS are
 * kept, because "is the operand of this operator a literal?" is a question several rules
 * ask and the answer is exactly "is there a quote here".
 *
 * @param {string} source
 * @returns {{ masked: string, literals: Map<number, {value: string, end: number}>, lineStarts: number[] }}
 */
function lex(source) {
  const literals = new Map();

  const masked = source.replace(COMMENT_OR_STRING, (m, offset) => {
    const blank = m.replace(/[^\n]/g, ' ');
    if (m.startsWith('//') || m.startsWith('/*')) return blank;

    const verbatim = m.startsWith('@');
    const open = verbatim ? 2 : 1;
    const body = m.slice(open, -1);
    // In a verbatim string a backslash is a backslash; in a normal one it escapes. Rules
    // that inspect regex literals need the string the KQL engine will actually see.
    const value = verbatim ? body : body.replace(/\\(.)/g, (_, c) => ESCAPES[c] ?? c);
    literals.set(offset, { value, end: offset + m.length });
    return m.slice(0, open) + blank.slice(open, -1) + m.slice(-1);
  });

  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') lineStarts.push(i + 1);
  }

  return { masked, literals, lineStarts };
}

/** 1-based line and column for a source offset. */
function positionAt(lineStarts, index) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (lineStarts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: index - lineStarts[low] + 1 };
}

// ------------------------------------------------------------
// Domain knowledge
// ------------------------------------------------------------

// Relative ingest volume, used only by join-order. Three coarse tiers is as much precision
// as a static list can honestly claim; the rule only fires when the tiers differ, so a
// table missing from this map produces silence rather than a guess.
const VOLUME_TIERS = {
  // Firehoses.
  DeviceNetworkEvents: 3, DeviceProcessEvents: 3, DeviceFileEvents: 3, DeviceImageLoadEvents: 3,
  DeviceEvents: 3, DeviceRegistryEvents: 3, CommonSecurityLog: 3, Syslog: 3, SecurityEvent: 3,
  AzureDiagnostics: 3, W3CIISLog: 3, DnsEvents: 3, CloudAppEvents: 3, OfficeActivity: 3,
  // Steady but bounded by user or device count.
  SigninLogs: 2, AADSignInEventsBeta: 2, AuditLogs: 2, DeviceLogonEvents: 2,
  IdentityLogonEvents: 2, IdentityQueryEvents: 2, IdentityDirectoryEvents: 2,
  EmailEvents: 2, EmailUrlInfo: 2, EmailAttachmentInfo: 2, UrlClickEvents: 2,
  ThreatIntelligenceIndicator: 2, Heartbeat: 2, AzureActivity: 2,
  // Reference-sized: one row per alert, incident or device.
  SecurityAlert: 1, SecurityIncident: 1, AlertInfo: 1, AlertEvidence: 1, DeviceInfo: 1,
  BehaviorInfo: 1, BehaviorEntities: 1, DeviceTvmSoftwareVulnerabilities: 1, Usage: 1,
};

// Tables with enough columns that returning all of them is never what the analyst wanted —
// DeviceProcessEvents alone is over forty, most of them empty for any given event.
const WIDE_TABLES = new Set([
  'DeviceProcessEvents', 'DeviceNetworkEvents', 'DeviceFileEvents', 'DeviceEvents',
  'DeviceImageLoadEvents', 'DeviceRegistryEvents', 'DeviceLogonEvents', 'CommonSecurityLog',
  'SigninLogs', 'AADSignInEventsBeta', 'AuditLogs', 'EmailEvents', 'CloudAppEvents',
  'OfficeActivity', 'SecurityEvent', 'IdentityLogonEvents', 'AzureDiagnostics',
  'DeviceTvmSoftwareVulnerabilities',
]);

// Columns whose distinct count is effectively unbounded, so `distinct` over them is a
// full shuffle that returns a result nobody can read.
const HIGH_CARDINALITY = /(?:CommandLine|CorrelationId|SessionId|OperationId|RequestId|ReportId|ProcessId|DeviceId|SHA256|Sha256|SHA1|Sha1|MD5|Md5|Hash|Url|Uri|UserAgent|Message|Token)$/;

// Columns that hold a datetime. Suffix-matched and case-sensitive, so `Runtime` (ends in a
// lowercase "time") and `LastUpdate` are not caught.
const DATETIME_COLUMN = /^(?:TimeGenerated|Timestamp|TimeStamp|ingestion_time|FirstSeen|LastSeen)$|(?:Time|DateTime|Date)$/;

const KNOWN_TABLE = new RegExp(
  `\\b(?:${[...ALL_KNOWN_TABLES].sort((a, b) => b.length - a.length).join('|')})\\b`
);

// Legacy spellings Microsoft still accepts but no longer documents. Each has a drop-in
// modern name, so this is a rename rather than a rewrite.
const DEPRECATED = [
  { pattern: /\bmvexpand\b/g, use: 'mv-expand' },
  { pattern: /\bmvapply\b/g, use: 'mv-apply' },
  { pattern: /\bmakeset\s*\(/g, use: 'make_set()' },
  { pattern: /\bmakelist\s*\(/g, use: 'make_list()' },
  { pattern: /\bmakeseries\b/g, use: 'make-series' },
];

// Operators whose right-hand side is a searched string, used by leading-wildcard.
const STRING_OPERATORS =
  /(?:\b(?:matches\s+regex|contains_cs|contains|startswith_cs|startswith|endswith_cs|endswith|has_cs|has_any|has_all|has|hasprefix|hassuffix)\b|==|=~)\s*(?=["'@])/g;

// ------------------------------------------------------------
// Rules
//
// Each rule is (ctx, add) => void. `add(rule, severity, index, message, hint)` converts the
// source offset into a line and column, so no rule has to count newlines itself.
// ------------------------------------------------------------

/** The literal that starts at `index`, or null when the operand is an expression. */
function literalAt(ctx, index) {
  return ctx.literals.get(index) ?? null;
}

function preferHas(ctx, add) {
  for (const m of ctx.masked.matchAll(/(!?)\bcontains\b\s*(?=["'@])/g)) {
    const lit = literalAt(ctx, m.index + m[0].length);
    // Only a bare term can be swapped for `has`: `has` matches whole terms, so anything
    // with a separator in it ("powershell.exe", "C:\\Users") may well be a deliberate
    // substring match and rewriting it would change the result.
    if (!lit || !/^[A-Za-z0-9_]{3,}$/.test(lit.value)) continue;
    const not = m[1];
    add('prefer-has', 'info', m.index,
      `'${not}contains "${lit.value}"' scans every substring of every value in the column.`,
      `"${lit.value}" is a single term, so '${not}has' answers it from the term index instead. Use '${not}has_cs' if case matters.`);
  }
}

function unboundedTimerange(ctx, add) {
  // A query with no recognisable source (a bare print, a datatable, a function definition)
  // has nothing to bound, so the rule would only ever be noise there.
  if (ctx.table === 'Custom') return;
  if (/\bago\s*\(/.test(ctx.masked)) return;
  if (/\bbetween\s*\(/.test(ctx.masked)) return;
  // A COMPARISON against the time column, not merely a mention of it: listing
  // TimeGenerated in a project or a summarize bounds nothing, and treating that as a bound
  // is how this rule would go quiet on exactly the queries it exists to catch.
  if (/\b(?:TimeGenerated|Timestamp|TimeStamp)\b\s*(?:>=|<=|[<>]|between\b)/.test(ctx.masked)) return;
  // An absolute literal is an explicit bound too, even on a column this linter cannot name.
  if (/\bdatetime\s*\(\s*\d{4}-/.test(ctx.masked)) return;

  add('unbounded-timerange', 'warning', 0,
    'No time bound: this reads the whole retention period of ' + ctx.tableName + '.',
    "Add '| where TimeGenerated > ago(7d)' as the first operator. In an analytics rule the bound must still be in the query — the rule period does not replace it.");
}

function leadingWildcard(ctx, add) {
  for (const m of ctx.masked.matchAll(STRING_OPERATORS)) {
    const lit = literalAt(ctx, m.index + m[0].length);
    if (!lit) continue;
    const op = m[0].trim();

    if (/^matches\s+regex$/.test(op)) {
      if (!/^\^?\.\*/.test(lit.value)) continue;
      add('leading-wildcard', 'warning', m.index,
        'A regex beginning with .* forces a scan of every row; the index cannot help.',
        "Anchor the pattern, or move the selective part into a 'has' predicate first and keep the regex for extraction.");
      continue;
    }

    if (!lit.value.startsWith('*')) continue;
    add('leading-wildcard', 'warning', m.index,
      `A leading * in "${lit.value}" cannot be served from the term index.`,
      "KQL is not Splunk: * is not a wildcard in a string comparison. Use 'has'/'contains' for a substring, or 'matches regex' with an anchored pattern.");
  }
}

function searchAllTables(ctx, add) {
  for (const m of ctx.masked.matchAll(/\bsearch\b/g)) {
    const before = ctx.masked.slice(0, m.index).replace(/\s+$/, '');
    const prev = before[before.length - 1];
    // Only a statement-initial `search` is unscoped. After a pipe it is scoped to the
    // pipeline; anywhere else the word is an identifier, not the operator.
    if (prev !== undefined && prev !== ';') continue;
    const after = ctx.masked.slice(m.index + 'search'.length);
    if (/^\s*(?:kind\s*=\s*\w+\s*)?in\s*~?\s*\(/.test(after)) continue;

    add('search-all-tables', 'warning', m.index,
      'A bare `search` runs against every table in the workspace.',
      "Scope it — 'search in (SigninLogs, AuditLogs) \"term\"' — or start from the table and pipe into 'search'.");
  }
}

/** Locate each join and the text between the keyword and the joined expression. */
function joinSites(masked) {
  const sites = [];
  for (const m of masked.matchAll(/\bjoin\b/g)) {
    const rest = masked.slice(m.index + 'join'.length);
    const paren = rest.indexOf('(');
    const pipe = rest.indexOf('|');
    let end = paren === -1 ? rest.length : paren;
    if (pipe !== -1 && pipe < end) end = pipe;
    sites.push({ index: m.index, options: rest.slice(0, end), rest });
  }
  return sites;
}

function joinWithoutKind(ctx, add) {
  for (const site of joinSites(ctx.masked)) {
    if (/\bkind\s*=/.test(site.options)) continue;
    add('join-without-kind', 'warning', site.index,
      "This join has no kind=, so it is an innerunique join: duplicate keys on the LEFT are collapsed to one row before matching.",
      "State the kind you meant — kind=inner keeps every match, kind=leftouter keeps unmatched left rows, kind=leftanti finds absences.");
  }
}

function joinOrder(ctx, add) {
  // Only the first join is judged. After that the left side is a joined result whose size
  // this linter has no way to estimate, and guessing there would be pure noise.
  const [site] = joinSites(ctx.masked);
  if (!site) return;

  const leftTier = VOLUME_TIERS[ctx.tableName];
  const onAt = site.rest.search(/\bon\b/);
  const rightMatch = KNOWN_TABLE.exec(site.rest.slice(0, onAt === -1 ? 400 : onAt));
  if (!leftTier || !rightMatch) return;

  const rightTier = VOLUME_TIERS[rightMatch[0]];
  if (!rightTier || leftTier <= rightTier) return;

  add('join-order', 'info', site.index,
    `${ctx.tableName} is the larger table but sits on the left of the join with ${rightMatch[0]}.`,
    `Kusto broadcasts the left side, so the smaller table belongs there: start from ${rightMatch[0]} and join to ${ctx.tableName}, or add hint.strategy=broadcast.`);
}

function selectStarProject(ctx, add) {
  if (!WIDE_TABLES.has(ctx.tableName)) return;
  if (/\b(?:project|project-away|project-keep|project-rename|project-reorder|summarize|distinct|count|make-series|top-nested|getschema|evaluate)\b/.test(ctx.masked)) return;

  add('select-star-project', 'info', 0,
    `${ctx.tableName} is a wide table and every column is being returned.`,
    "Add a 'project' with the columns the analyst reads, or 'project-away' the noisy ones. This is the cheapest single change to a hunting query's cost.");
}

function regexOverHasAny(ctx, add) {
  for (const m of ctx.masked.matchAll(/\bmatches\s+regex\b\s*(?=["'@])/g)) {
    const lit = literalAt(ctx, m.index + m[0].length);
    if (!lit) continue;

    // Strip the anchors and one layer of grouping, then unescape dots: what is left has to
    // be nothing but literal alternatives for the rewrite to be safe.
    const anchored = lit.value.startsWith('^') && lit.value.endsWith('$');
    let body = lit.value.replace(/^\^/, '').replace(/\$$/, '');
    if (/^\((?:\?:)?.*\)$/.test(body)) body = body.replace(/^\((?:\?:)?/, '').replace(/\)$/, '');
    const plain = body.replace(/\\\./g, '.');
    if (/[\\^$*+?()[\]{}]/.test(plain)) continue;

    const parts = plain.split('|');
    if (parts.length < 2 || !parts.every((p) => /^[A-Za-z0-9_.\- ]+$/.test(p))) continue;

    // Anchored at both ends means the author wanted the WHOLE value, which is in~, not
    // has_any — has_any would also match a longer string containing one of the terms.
    const operator = anchored ? 'in~' : 'has_any';
    add('regex-over-has-any', 'info', m.index,
      `This regex is a plain alternation of ${parts.length} literals.`,
      `'${operator} (${parts.map((p) => `"${p.trim()}"`).join(', ')})' uses the term index; a regex cannot.`);
  }
}

function datetimeStringCompare(ctx, add) {
  for (const m of ctx.masked.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*(==|!=|=~|>=|<=|>|<)\s*(?=["'@])/g)) {
    const [, column, operator] = m;
    if (!DATETIME_COLUMN.test(column)) continue;
    const lit = literalAt(ctx, m.index + m[0].length);
    if (!lit) continue;

    add('datetime-string-compare', 'error', m.index,
      `${column} is a datetime and "${lit.value}" is a string; KQL has no overload for '${operator}' between the two.`,
      `Use a datetime literal — ${column} ${operator} datetime(${lit.value}) — or todatetime("${lit.value}") when the value comes from a variable.`);
  }
}

function deprecatedOperator(ctx, add) {
  for (const { pattern, use } of DEPRECATED) {
    for (const m of ctx.masked.matchAll(pattern)) {
      const name = m[0].replace(/\s*\($/, '');
      add('deprecated-operator', 'warning', m.index,
        `'${name}' is the legacy spelling and is no longer documented.`,
        `Rename it to '${use}'. The behaviour is identical, so this is safe to apply blind.`);
    }
  }
}

function summarizeWithoutAggregate(ctx, add) {
  for (const m of ctx.masked.matchAll(/\bsummarize\s+by\b/g)) {
    // `distinct` takes column NAMES only — it has no syntax for a computed or renamed key.
    // So `summarize by Country = tostring(x)` and `summarize by bin(TimeGenerated, 1h)` are
    // not deduplications written the long way, they are the only way to write that grouping,
    // and telling the analyst to "say what you mean with distinct" is advice they cannot take.
    // Firing only on an all-bare-identifier by-list keeps the rule to the case it can fix.
    const byList = ctx.masked.slice(m.index + m[0].length).split(/[|;]/)[0];
    const terms = byList.split(',').map((t) => t.trim()).filter(Boolean);
    if (!terms.length) continue;
    if (!terms.every((t) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(t))) continue;

    add('deprecated-operator', 'info', m.index,
      "'summarize by' with no aggregate is a deduplication written the long way.",
      "Say what you mean with 'distinct', or add the aggregate you meant to compute (count(), dcount(), make_set()).");
  }
}

function sortOrderConsistency(ctx, add) {
  const sorts = [...ctx.masked.matchAll(/\bsort\s+by\b/g)];
  const orders = [...ctx.masked.matchAll(/\border\s+by\b/g)];
  if (!sorts.length || !orders.length) return;

  const second = sorts[0].index < orders[0].index ? orders[0] : sorts[0];
  add('deprecated-operator', 'info', second.index,
    "This query uses both 'sort by' and 'order by'; they are the same operator.",
    "Pick one and use it throughout — 'order by' reads better to anyone arriving from SQL.");
}

function distinctOverSummarize(ctx, add) {
  for (const m of ctx.masked.matchAll(/\bdistinct\b/g)) {
    const after = ctx.masked.slice(m.index + 'distinct'.length);
    const columns = after.split('|')[0];
    const wide = columns.split(',')
      .map((c) => c.trim())
      .filter((c) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(c) && HIGH_CARDINALITY.test(c));
    if (!wide.length) continue;
    // A downstream take/limit/top makes the cost bounded and the intent obvious.
    if (/\b(?:take|limit|top)\b/.test(after)) continue;

    add('distinct-over-summarize', 'info', m.index,
      `'distinct ${wide[0]}' over a high-cardinality column shuffles every row and returns an unbounded result.`,
      `If the question is "how many", 'summarize dcount(${wide[0]})' answers it far more cheaply; if it is "which", add a bound with 'top N by'.`);
  }
}

function takeWithoutOrder(ctx, add) {
  for (const m of ctx.masked.matchAll(/\b(?:take|limit)\b/g)) {
    if (/\b(?:sort|order|top)\b/.test(ctx.masked.slice(0, m.index))) continue;
    add('take-without-order', 'info', m.index,
      `'${m[0]}' with no preceding sort returns an arbitrary N rows, and a different N on every run.`,
      "Use 'top 100 by TimeGenerated desc' when you want the newest, or sort before taking. 'take' is only safe when you genuinely want a sample.");
  }
}

const RULES = [
  preferHas, unboundedTimerange, leadingWildcard, searchAllTables, joinWithoutKind,
  joinOrder, selectStarProject, regexOverHasAny, datetimeStringCompare, deprecatedOperator,
  summarizeWithoutAggregate, sortOrderConsistency, distinctOverSummarize, takeWithoutOrder,
];

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

/**
 * @param {string} queryText
 * @returns {Array<{rule: string, severity: 'error'|'warning'|'info', line: number, column: number, message: string, hint: string}>}
 *   ordered by position, so the list reads in the same order as the query.
 */
function lint(queryText) {
  if (!queryText || typeof queryText !== 'string' || !queryText.trim()) return [];

  const { masked, literals, lineStarts } = lex(queryText);
  const table = detectTableFromQuery(queryText);
  const ctx = {
    source: queryText,
    masked,
    literals,
    lineStarts,
    table,
    tableName: getTableDisplayName(table),
  };

  const findings = [];
  const seen = new Set();
  const add = (rule, severity, index, message, hint) => {
    const { line, column } = positionAt(lineStarts, index);
    const key = `${rule}:${line}:${column}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ rule, severity, line, column, message, hint });
  };

  for (const rule of RULES) rule(ctx, add);

  return findings.sort((a, b) => a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule));
}

export { lint };
