import { SENTINEL_TABLES, DEFENDER_TABLES, ALL_KNOWN_TABLES } from '../constants.js';

// ============================================================
// Table Helpers
//
// detectTableFromQuery answers one question — "what does this query read from?" — for the
// badge on a query card and for the sidebar's table filter. It is a lexical approximation
// rather than a parser, so the bar it has to clear is: be right about the shapes a
// practitioner actually writes, and fall back to 'Custom' rather than guess, because a
// confidently wrong badge is worse than an honest "unknown".
//
// The previous version failed that bar in four ways, all of which produced a wrong badge:
// it skipped a `let` line but not the continuation lines of a multi-line let, so the second
// line of a let body was read as the source table; it had no concept of `union` or `find`,
// so a union across five tables was attributed to whichever token came first; it could not
// see block comments; and its /^[A-Z][a-zA-Z0-9]+$/ fallback happily promoted a let-bound
// variable to a table. Statement-aware scanning fixes all four at once.
// ============================================================

// ------------------------------------------------------------
// ASIM
//
// ASIM parsers are functions, not tables, so they will never appear in ALL_KNOWN_TABLES —
// but they sit in the source position of a query exactly like a table does, and Microsoft
// steers new detection content towards them. Grouping them as 'custom' told the analyst
// the opposite of the truth: an imFileEvent query is the most portable kind there is.
//
// Recognition is prefix + schema rather than an exhaustive list, because the family is
// open-ended: alongside the unifying parsers below there are the built-in `_Im_*` and
// `_ASim_*` parsers and a per-source `vim*` parser for every connector Microsoft ships.
// Matching on the schema name keeps a custom table called ImportantThing out of the group.
// ------------------------------------------------------------
const ASIM_SCHEMAS = [
  'AuditEvent', 'Authentication', 'Dhcp', 'Dns', 'FileEvent', 'NetworkSession',
  'ProcessCreate', 'ProcessTerminate', 'ProcessEvent', 'RegistryEvent', 'Registry',
  'UserManagement', 'WebSession',
];

// The unifying (source-agnostic) parsers, exported so a table picker can offer them.
const ASIM_PARSERS = [
  'imAuditEvent', 'imAuthentication', 'imDhcp', 'imDns', 'imFileEvent', 'imNetworkSession',
  'imProcessCreate', 'imProcessTerminate', 'imRegistry', 'imUserManagement', 'imWebSession',
];

// _Im_Dns, _ASim_Dns, imDns, ASimDns, vimDnsInfobloxNIOS, _Im_WebSession_Native, ...
const ASIM_NAME_REGEX = new RegExp(
  `^(?:_Im_|_ASim_|_Im|_ASim|im|ASim|vim)(?:${ASIM_SCHEMAS.join('|')})[A-Za-z0-9_]*$`
);

function isAsimTable(name) {
  return typeof name === 'string' && ASIM_NAME_REGEX.test(name);
}

// ------------------------------------------------------------
// Lexical preprocessing
// ------------------------------------------------------------

// Comments and strings are matched in ONE alternation so that whichever opens first wins.
// Two passes are mutually destructive in both directions: comments-first lets the // in
// "https://portal.azure.com" open a comment, strings-first lets the apostrophe in
// `// don't` open a string. (Same defect class as KQS-039 in the highlighter.)
// KQL itself only has // comments, but /* */ turns up constantly in pasted content that
// has been through a SIEM's rule editor, so it is handled too.
const COMMENT_OR_STRING = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|@?"(?:[^"\\\n]|\\.)*"|@?'(?:[^'\\\n]|\\.)*'/g;

/**
 * Blank out comments and string bodies, preserving length and line structure so that any
 * offset computed against the result still points at the same place in the original.
 * @param {string} text
 * @returns {string}
 */
function blankNoise(text) {
  return text.replace(COMMENT_OR_STRING, (m) => m.replace(/[^\n]/g, ' '));
}

const OPENERS = '([{';
const CLOSERS = ')]}';

/**
 * Split on a separator that appears at bracket depth zero. Used for `;` between statements
 * and `,` between union operands; in both cases a nested occurrence belongs to a subquery
 * or an argument list, not to the outer construct.
 * @param {string} text
 * @param {string} sep single character
 * @returns {string[]}
 */
function splitTopLevel(text, sep) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (OPENERS.includes(c)) depth++;
    else if (CLOSERS.includes(c)) depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out;
}

/** Everything up to the first top-level pipe: the source expression, without the pipeline. */
function beforeFirstPipe(text) {
  return splitTopLevel(text, '|')[0];
}

// A user-defined function body may itself contain `let x = 1; x`, so statement splitting has
// to respect braces — hence splitTopLevel rather than a plain split(';').
const LET_BINDING = /^let\s+(?:\[\s*["'])?([A-Za-z_][A-Za-z0-9_]*)/;

// Longest-first so that DeviceTvmSoftwareInventory is not matched as DeviceTvm... prefix
// of a shorter sibling. Used only as a last resort (see detectTableFromQuery).
const KNOWN_TABLE_ANYWHERE = new RegExp(
  `\\b(?:${[...ALL_KNOWN_TABLES].sort((a, b) => b.length - a.length).join('|')})\\b`
);

// ------------------------------------------------------------
// Operand classification
// ------------------------------------------------------------

/**
 * Decide what a single source-position identifier is. Returns null when it is not
 * recognisably a table, so the caller can keep looking rather than commit to a guess.
 */
function classifyOperand(name, letNames) {
  if (!name || letNames.has(name)) return null;
  if (ALL_KNOWN_TABLES.includes(name)) return name;
  if (isAsimTable(name)) return name;
  if (name.endsWith('_CL') || name.endsWith('_CF')) return `Custom:${name}`;
  if (/^[A-Z][a-zA-Z0-9]+$/.test(name) && name.length > 3) return `Custom:${name}`;
  return null;
}

/** First identifier in a fragment, e.g. `(SigninLogs | take 1)` -> SigninLogs. */
function firstIdentifier(fragment) {
  // `union Device*` fans out over every matching table, so no single name is the answer.
  if (fragment.includes('*')) return null;
  const m = /[A-Za-z_][A-Za-z0-9_]*/.exec(fragment);
  return m ? m[0] : null;
}

/**
 * Pick the best operand of a multi-table construct. A known table wins over an ASIM parser
 * which wins over a custom guess, regardless of the order they were written in: `union
 * MyStaging_CL, SecurityEvent` is a SecurityEvent query with a staging table bolted on.
 */
function resolveOperands(names, letNames) {
  const usable = names.filter((n) => n && !letNames.has(n));
  const known = usable.find((n) => ALL_KNOWN_TABLES.includes(n));
  if (known) return known;
  const asim = usable.find(isAsimTable);
  if (asim) return asim;
  for (const n of usable) {
    const classified = classifyOperand(n, letNames);
    if (classified) return classified;
  }
  return null;
}

// union [kind=outer] [withsource=Src] [isfuzzy=true] [hint.remote=local] T1, T2
const UNION_OPTION = /^\s*(?:kind|withsource|with_source|isfuzzy|hint\.[a-z_]+)\s*=\s*[^\s,)]+/i;

function tableFromUnion(head, letNames) {
  let rest = beforeFirstPipe(head.slice('union'.length));
  for (;;) {
    const opt = UNION_OPTION.exec(rest);
    if (!opt) break;
    rest = rest.slice(opt[0].length);
  }
  return resolveOperands(splitTopLevel(rest, ',').map(firstIdentifier), letNames);
}

function tableFromFind(head, letNames) {
  // The first `in (` after `find` is the table list; a later one belongs to a predicate.
  const scope = /\bin\s*\(([^)]*)\)/.exec(head);
  if (!scope) return null; // bare `find where ...` searches everything — no single table
  return resolveOperands(splitTopLevel(scope[1], ',').map(firstIdentifier), letNames);
}

function tableFromStatement(statement, letNames) {
  const head = statement.replace(/^[\s(]+/, '');
  if (!head || head.startsWith('|')) return null;
  const firstWord = head.split(/[\s|([,;]/)[0];
  if (!firstWord) return null;
  if (firstWord === 'union') return tableFromUnion(head, letNames);
  if (firstWord === 'find') return tableFromFind(head, letNames);
  return classifyOperand(firstWord, letNames);
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

function getTableGroup(table) {
  if (!table) return 'custom';
  // An explicit Custom: prefix is the user's own assertion, so it is never re-interpreted.
  if (table.startsWith('Custom:')) {
    const name = table.slice(7);
    if (SENTINEL_TABLES.includes(name)) return 'sentinel';
    if (DEFENDER_TABLES.includes(name)) return 'defender';
    return 'custom';
  }
  if (SENTINEL_TABLES.includes(table)) return 'sentinel';
  if (DEFENDER_TABLES.includes(table)) return 'defender';
  if (isAsimTable(table)) return 'asim';
  return 'custom';
}

function getTableDisplayName(table) {
  if (!table) return 'Unknown';
  return table.startsWith('Custom:') ? table.slice(7) : table;
}

/**
 * @param {string} queryBody
 * @returns {string} a known table name, an ASIM parser name, 'Custom:<name>', or 'Custom'
 */
function detectTableFromQuery(queryBody) {
  if (!queryBody || typeof queryBody !== 'string') return 'Custom';

  const clean = blankNoise(queryBody);
  const letNames = new Set();

  for (const raw of splitTopLevel(clean, ';')) {
    const statement = raw.trim();
    if (!statement) continue;
    const binding = LET_BINDING.exec(statement);
    if (binding) {
      // Recorded, not just skipped: without the name, `let Suspicious = ...; Suspicious`
      // is badged as a custom table called Suspicious.
      letNames.add(binding[1]);
      continue;
    }
    const found = tableFromStatement(statement, letNames);
    if (found) return found;
  }

  // Last resort: the query proper is a let-bound variable, so the real table is only named
  // inside a let body. Restricted to known tables — the heuristics are too loose to run
  // over arbitrary interior text without inventing tables out of column names.
  const known = KNOWN_TABLE_ANYWHERE.exec(clean);
  return known ? known[0] : 'Custom';
}

export {
  getTableGroup, getTableDisplayName, detectTableFromQuery,
  isAsimTable, ASIM_PARSERS, ASIM_SCHEMAS,
};
