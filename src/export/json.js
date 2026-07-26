import { CURRENT_SCHEMA_VERSION } from '../constants.js';

// ============================================================
// Native JSON export.
//
// The old export emitted a bare array. Since importQueries only runs the migration chain
// when it sees a versioned blob, an exported file could never be migrated on re-import —
// a v3 file loaded into a future build would be assumed current and silently mis-read.
// Exports now carry the envelope that storage has always used.
// ============================================================

function toJsonExport(queries, { pretty = true } = {}) {
  const payload = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    queries,
    meta: {
      exportedAt: new Date().toISOString(),
      totalQueries: queries.length,
      generator: 'KQL Store',
    },
  };
  return JSON.stringify(payload, null, pretty ? 2 : 0);
}

export { toJsonExport };
