import { SENTINEL_TABLES, DEFENDER_TABLES, ALL_KNOWN_TABLES } from '../constants.js';

// ============================================================
// Table Helpers
// ============================================================
function getTableGroup(table) {
  if (!table) return 'custom';
  const name = table.startsWith('Custom:') ? table.slice(7) : table;
  if (SENTINEL_TABLES.includes(name)) return 'sentinel';
  if (DEFENDER_TABLES.includes(name)) return 'defender';
  return 'custom';
}

function getTableDisplayName(table) {
  if (!table) return 'Unknown';
  return table.startsWith('Custom:') ? table.slice(7) : table;
}

function detectTableFromQuery(queryBody) {
  if (!queryBody || typeof queryBody !== 'string') return 'Custom';
  const lines = queryBody.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('let ') || trimmed.startsWith('|')) continue;
    const firstWord = trimmed.split(/[\s|([]/)[0];
    if (!firstWord) continue;
    if (ALL_KNOWN_TABLES.includes(firstWord)) return firstWord;
    if (firstWord.endsWith('_CL') || firstWord.endsWith('_CF')) return 'Custom:' + firstWord;
    if (/^[A-Z][a-zA-Z0-9]+$/.test(firstWord) && firstWord.length > 3) return 'Custom:' + firstWord;
  }
  return 'Custom';
}

export { getTableGroup, getTableDisplayName, detectTableFromQuery };
