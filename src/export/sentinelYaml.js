import { ATTACK_TACTICS } from '../constants.js';

// ============================================================
// Microsoft Sentinel scheduled analytics rule export.
//
// Until now the only export was a raw dump of internal records, so queries went into the
// tool and only ever came back out into the same tool. For a detection library the export
// format IS the product: this emits the YAML shape Sentinel's own content repository uses,
// which can be committed to a content repo or handed to the Sentinel deployment pipeline.
// ============================================================

/**
 * Sentinel writes tactics in PascalCase with no separator; the store keeps the ATT&CK slug
 * form. Derived from the canonical tactic list so the two cannot drift.
 */
const TACTIC_TO_SENTINEL = Object.fromEntries(
  ATTACK_TACTICS.map((slug) => [
    slug,
    slug.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(''),
  ]),
);

/** Characters that force a quoted scalar rather than a plain one. */
const NEEDS_QUOTING = /^[\s>|*&!%@`'"#-]|[:#]\s|[\s]$|^$|^(true|false|null|yes|no|on|off|~)$/i;

function scalar(value) {
  const s = String(value);
  if (NEEDS_QUOTING.test(s) || /[\n\r\t]/.test(s)) {
    return `'${s.replace(/'/g, "''")}'`;
  }
  return s;
}

/**
 * Emit a literal block scalar. Sentinel rule queries are multi-line KQL and must survive
 * verbatim, so this uses `|-` (keep newlines, strip the trailing one) and indents every
 * line — including blank ones, which are emitted empty rather than as indentation.
 */
function block(value, indent) {
  const pad = ' '.repeat(indent);
  const lines = String(value).replace(/\r\n/g, '\n').replace(/\s+$/, '').split('\n');
  return `|-\n${lines.map((l) => (l.trim() === '' ? '' : pad + l)).join('\n')}`;
}

/**
 * Convert one stored query into a Sentinel scheduled analytics rule.
 * Fields the store does not carry are given the conservative defaults Sentinel requires,
 * and every one of those is called out in the returned `warnings` so nobody ships a rule
 * believing the tool decided something it did not.
 */
function toSentinelRule(query) {
  const warnings = [];
  const md = query || {};

  if (!md.severity) warnings.push('severity not set — defaulted to Medium');
  if (!md.attack?.tactics?.length) warnings.push('no ATT&CK tactics — Sentinel will show the rule as unmapped');
  if (!md.attack?.techniques?.length) warnings.push('no ATT&CK techniques');
  if (!md.lookback) warnings.push('lookback not set — queryPeriod defaulted to 1d');
  if (!md.entityMappings?.length) warnings.push('no entity mappings — incidents will not correlate entities');
  if (md.queryType && md.queryType !== 'AnalyticsRule' && md.queryType !== 'NRT') {
    warnings.push(`queryType is ${md.queryType}, not AnalyticsRule — review before deploying as a rule`);
  }

  const lines = [];
  lines.push(`id: ${scalar(query.id)}`);
  lines.push(`name: ${scalar(query.name)}`);
  lines.push(`kind: Scheduled`);
  if (query.description) {
    lines.push(`description: ${block(query.description, 2)}`);
  }
  lines.push(`severity: ${md.severity || 'Medium'}`);

  const connectors = md.dataSources?.connectors ?? [];
  const tables = md.dataSources?.tables?.length ? md.dataSources.tables : [query.table].filter(Boolean);
  if (connectors.length) {
    lines.push('requiredDataConnectors:');
    for (const c of connectors) {
      lines.push(`  - connectorId: ${scalar(c)}`);
      if (tables.length) {
        lines.push('    dataTypes:');
        for (const t of tables) lines.push(`      - ${scalar(t)}`);
      }
    }
  } else {
    lines.push('requiredDataConnectors: []');
  }

  const period = md.lookback || '1d';
  lines.push(`queryFrequency: ${period}`);
  lines.push(`queryPeriod: ${period}`);
  lines.push('triggerOperator: gt');
  lines.push('triggerThreshold: 0');

  const tactics = (md.attack?.tactics ?? []).map((t) => TACTIC_TO_SENTINEL[t]).filter(Boolean);
  if (tactics.length) {
    lines.push('tactics:');
    for (const t of tactics) lines.push(`  - ${t}`);
  }
  const techniques = md.attack?.techniques ?? [];
  if (techniques.length) {
    lines.push('relevantTechniques:');
    // Sentinel's relevantTechniques takes parent techniques; sub-technique IDs are kept
    // whole because newer Sentinel accepts them and truncating would lose information.
    for (const t of techniques) lines.push(`  - ${t}`);
  }

  lines.push(`query: ${block(query.query, 2)}`);

  if (md.entityMappings?.length) {
    lines.push('entityMappings:');
    for (const m of md.entityMappings) {
      lines.push(`  - entityType: ${m.entityType}`);
      lines.push('    fieldMappings:');
      lines.push(`      - identifier: ${scalar(m.identifier || m.entityType)}`);
      lines.push(`        columnName: ${scalar(m.columnName)}`);
    }
  }

  if (md.falsePositives?.length || md.tuningNotes) {
    const notes = [...(md.falsePositives ?? []).map((f) => `False positive: ${f}`)];
    if (md.tuningNotes) notes.push(md.tuningNotes);
    lines.push(`customDetails:`);
    lines.push(`  TuningNotes: ${scalar(notes.join(' | ').slice(0, 500))}`);
  }

  lines.push(`version: ${scalar(md.version || '1.0.0')}`);

  return { yaml: `${lines.join('\n')}\n`, warnings };
}

/** Export many queries as one multi-document YAML file. */
function toSentinelRuleSet(queries) {
  const parts = [];
  const warnings = [];
  for (const q of queries) {
    const { yaml, warnings: w } = toSentinelRule(q);
    parts.push(yaml);
    if (w.length) warnings.push({ id: q.id, name: q.name, warnings: w });
  }
  return { yaml: parts.join('---\n'), warnings };
}

export { toSentinelRule, toSentinelRuleSet, TACTIC_TO_SENTINEL };
