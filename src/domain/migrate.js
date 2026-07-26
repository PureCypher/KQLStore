import { CATEGORIES, CATEGORY_MIGRATION, CURRENT_SCHEMA_VERSION } from '../constants.js';
import { detectTableFromQuery } from './tables.js';

// ============================================================
// Schema Migration (FIXES Finding 10: schema versioning with migration path)
// ============================================================
function migrateData(data) {
  if (!data || typeof data !== 'object') return null;
  let version = data.schemaVersion || 1;
  let queries = Array.isArray(data.queries) ? data.queries : [];

  // v1 -> v2: add severity and tags
  if (version < 2) {
    queries = queries.map(q => ({
      ...q,
      severity: q.severity || 'medium',
      tags: Array.isArray(q.tags) ? q.tags : [],
    }));
    version = 2;
  }

  // v2 -> v3: remove severity/platform, add table, migrate categories
  if (version < 3) {
    queries = queries.map(q => {
      const migrated = { ...q };
      // Migrate category
      if (CATEGORY_MIGRATION[migrated.category]) {
        migrated.category = CATEGORY_MIGRATION[migrated.category];
      }
      if (!CATEGORIES.includes(migrated.category)) {
        migrated.category = 'Utility';
      }
      // Detect table from query body
      migrated.table = detectTableFromQuery(migrated.query);
      // Remove deprecated fields
      delete migrated.severity;
      delete migrated.platform;
      return migrated;
    });
    version = 3;
  }

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    queries,
    meta: {
      lastUpdated: new Date().toISOString(),
      totalQueries: queries.length,
    },
  };
}

export { migrateData };
