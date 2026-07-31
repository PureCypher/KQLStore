// ============================================================
// `TableName | getschema` output parser.
//
// This is the only place in the app that eats untrusted human paste, and the bar it has
// to clear is the same one detectTableFromQuery has: be right about what a practitioner
// actually pastes, and fail loudly rather than confidently returning three plausible
// columns from something that was never schema output.
//
// Three shapes turn up in practice and all three are handled: tab-separated (copy from
// the results grid), comma-separated (the portal's CSV export), and multi-space aligned
// (a copy out of a rendered table or a terminal). They are distinguished per line rather
// than per document, because a paste that has been through an editor can mix them.
// ============================================================

const MAX_COLUMNS = 500;

// System.DateTime -> datetime, System.String -> string. Falls through unchanged for a
// value that is already a KQL type name.
const SYSTEM_TYPES = {
  'system.datetime': 'datetime',
  'system.string': 'string',
  'system.int32': 'int',
  'system.int64': 'long',
  'system.double': 'real',
  'system.boolean': 'bool',
  'system.guid': 'guid',
  'system.timespan': 'timespan',
  'system.object': 'dynamic',
  'system.sbyte': 'bool',
};

const HEADER = /^columnname\b/i;
// A line that is a KQL statement rather than a row of output.
const KQL_PROMPT = /\|\s*getschema\s*$/i;

/** Split one line on whichever separator it actually uses. */
function splitLine(line) {
  if (line.includes('\t')) return line.split('\t');
  if (line.includes(',')) return line.split(',');
  return line.split(/\s{2,}/);
}

function normaliseType(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return 'unknown';
  const value = raw.trim();
  return SYSTEM_TYPES[value.toLowerCase()] || value;
}

// A column name is an identifier. Anything with a space or punctuation in it came from
// prose, not from getschema.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * @param {string} text
 * @returns {{ok: true, columns: Array<{name: string, type: string}>} | {ok: false, error: string}}
 */
export function parseGetSchema(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: 'Nothing to parse.' };
  }

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !KQL_PROMPT.test(l));

  let headerFields = null;
  const columns = [];
  const seen = new Set();

  for (const line of lines) {
    const fields = splitLine(line).map((f) => f.trim()).filter((f) => f.length > 0);
    if (fields.length === 0) continue;

    if (HEADER.test(fields[0])) {
      headerFields = fields.map((f) => f.toLowerCase());
      continue;
    }

    const name = fields[0];
    if (!IDENTIFIER.test(name)) continue;
    if (seen.has(name)) continue;

    // Prefer the ColumnType column when a header told us where it is; otherwise take the
    // last field, which is where getschema puts it in every shape seen in practice.
    let type = 'unknown';
    if (headerFields) {
      const typeIndex = headerFields.indexOf('columntype');
      const dataIndex = headerFields.indexOf('datatype');
      const index = typeIndex !== -1 ? typeIndex : dataIndex;
      if (index !== -1 && fields[index] !== undefined) type = fields[index];
    } else if (fields.length > 1) {
      type = fields[fields.length - 1];
    }

    seen.add(name);
    columns.push({ name, type: normaliseType(type) });

    if (columns.length > MAX_COLUMNS) {
      return { ok: false, error: `That paste has more than ${MAX_COLUMNS} columns — check it is one table's schema.` };
    }
  }

  if (columns.length === 0) {
    return { ok: false, error: 'That does not look like getschema output — no column names found.' };
  }

  return { ok: true, columns };
}
