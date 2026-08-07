// ---------------------------------------------------------------------------
// Mechanical schema-fidelity signal.
//
// Heuristic, not a parser: extract identifier-shaped tokens from proposed KQL and
// flag the ones that are neither a known column of any referenced table, a
// let-bound name, an alias the query itself defines, nor a known table name.
// Judges receive this as a signal alongside the schemas; it deliberately
// over-reports rather than under-reports (a flagged token can be a false alarm,
// an unflagged query can still be wrong).
// ---------------------------------------------------------------------------

/** Strip string literals and comments so their contents don't read as identifiers. */
function stripLiterals(kql) {
  return kql
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, ' "" ')
    .replace(/'(?:[^'\\]|\\.)*'/g, " '' ");
}

/** Names the query itself brings into scope: let bindings and assignment aliases. */
function localNames(stripped) {
  const names = new Set();
  // Any `Name = expr` binds a name: let, extend/summarize/project assignments,
  // project-rename. Over-collects keyword-ish matches (kind=inner) harmlessly.
  for (const m of stripped.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=(?![=~])/g)) names.add(m[1]);
  for (const m of stripped.matchAll(/\bas\s+([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]);
  return names;
}

/**
 * @param {string} kql proposed query text
 * @param {Map<string, Set<string>>} columnsByTable table name -> column names
 * @param {Set<string>} allTableNames every table name the store knows
 * @returns {{tables: string[], unknownColumns: string[], checkedTokens: number}}
 */
function checkColumns(kql, columnsByTable, allTableNames) {
  if (typeof kql !== 'string' || !kql.trim()) {
    return { tables: [], unknownColumns: [], checkedTokens: 0 };
  }
  const stripped = stripLiterals(kql);
  const locals = localNames(stripped);

  const tables = [...allTableNames].filter((t) => new RegExp(`\\b${t}\\b`).test(stripped));
  const known = new Set();
  for (const t of tables) for (const c of columnsByTable.get(t) || []) known.add(c);

  // Identifier-shaped tokens that could be column references: start uppercase or
  // underscore (KQL builtins are lowercase), and take only the ROOT of a dotted
  // path (DynCol.key.sub — only DynCol must exist as a column).
  const seen = new Set();
  const unknown = new Set();
  for (const m of stripped.matchAll(/\b([A-Z_][A-Za-z0-9_]*)\b(?!\s*\()/g)) {
    const tok = m[1];
    if (seen.has(tok)) continue;
    seen.add(tok);
    if (locals.has(tok)) continue;
    if (allTableNames.has(tok)) continue;
    if (known.has(tok)) continue;
    unknown.add(tok);
  }
  return { tables, unknownColumns: [...unknown], checkedTokens: seen.size };
}

module.exports = { checkColumns };
