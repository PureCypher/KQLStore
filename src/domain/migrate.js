import { CATEGORIES, CATEGORY_MIGRATION, CURRENT_SCHEMA_VERSION } from '../constants.js';
import { detectTableFromQuery } from './tables.js';

// ============================================================
// Schema Migration (FIXES Finding 10: schema versioning with migration path)
// ============================================================
// A tag that encodes an ATT&CK technique, e.g. t1059 or T1059.001. The deployed instance
// was using tags this way because there was nowhere else to put them.
const TECHNIQUE_TAG = /^t(\d{4})(?:\.(\d{3}))?$/i;

function migrateData(data) {
  if (!data || typeof data !== 'object') return null;
  let version = data.schemaVersion || 1;

  // Refuse to touch data written by a newer build. Previously this fell through every
  // migration branch and returned the blob restamped as the CURRENT version, and the caller
  // then wrote that downgrade back to storage — silently destroying the version marker so a
  // later migration would never run. Returning null lets the caller load it read-only.
  if (version > CURRENT_SCHEMA_VERSION) {
    return { tooNew: true, schemaVersion: version, queries: Array.isArray(data.queries) ? data.queries : [] };
  }
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

  // v3 -> v4: introduce the detection metadata block. Nothing is invented — the only data
  // promoted is what was already there, ATT&CK technique IDs that had been smuggled into
  // free-text tags because the schema offered nowhere else to record them.
  if (version < 4) {
    queries = queries.map((q) => {
      const tags = Array.isArray(q.tags) ? q.tags : [];
      const techniques = [];
      const remaining = [];
      for (const tag of tags) {
        const m = typeof tag === 'string' ? tag.match(TECHNIQUE_TAG) : null;
        if (m) {
          const id = `T${m[1]}${m[2] ? `.${m[2]}` : ''}`;
          if (!techniques.includes(id)) techniques.push(id);
        } else {
          remaining.push(tag);
        }
      }
      if (techniques.length === 0) return q;
      const existing = q.attack && typeof q.attack === 'object' ? q.attack : {};
      const merged = Array.isArray(existing.techniques) ? [...existing.techniques] : [];
      for (const id of techniques) if (!merged.includes(id)) merged.push(id);
      return { ...q, tags: remaining, attack: { ...existing, techniques: merged } };
    });
    version = 4;
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
