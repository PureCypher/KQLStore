const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || '/data/kqlstore.db';

// Ensure the directory exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

// Create the queries table if it does not exist
const createTableSQL = `
  CREATE TABLE IF NOT EXISTS queries (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    query       TEXT NOT NULL,
    description TEXT DEFAULT '',
    category    TEXT DEFAULT 'Utility',
    table_name  TEXT DEFAULT '',
    tags        TEXT DEFAULT '[]',
    favorite    INTEGER DEFAULT 0,
    usage_count INTEGER NOT NULL DEFAULT 0,
    metadata    TEXT NOT NULL DEFAULT '{}',
    created     TEXT NOT NULL,
    updated     TEXT NOT NULL
  )
`;

db.prepare(createTableSQL).run();

// Additive migration for databases created before usage_count existed. Without this,
// the frontend's usageCount is dropped on every round-trip and "Most Used" stays empty.
const hasUsageCount = db
  .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('queries') WHERE name = 'usage_count'")
  .get().n > 0;
if (!hasUsageCount) {
  db.prepare('ALTER TABLE queries ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0').run();
}

// Schema v4 detection metadata (ATT&CK mapping, severity, false positives, entity mappings
// and so on). Stored as a JSON document rather than seventeen columns: it is optional, it is
// only ever read as a whole, and all filtering happens client-side once the SPA has loaded
// the store. tags has used the same approach since the beginning.
const hasMetadata = db
  .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('queries') WHERE name = 'metadata'")
  .get().n > 0;
if (!hasMetadata) {
  db.prepare("ALTER TABLE queries ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'").run();
}

// Fork lineage.
//
// Deliberately NOT a foreign key, even though foreign_keys is ON above. A FK forces a
// choice between blocking a parent's deletion and cascading it, and both are wrong here:
// deleting the Entra query you forked from must neither remove the Okta fork nor stop you
// deleting the original. An unresolvable parent_id is a display state — "forked from a
// query that no longer exists" — not an integrity violation. SQLite also forbids
// REFERENCES in ALTER TABLE ADD COLUMN, so this is the only available path in any case.
//
// parent_name is a snapshot of the parent's name at fork time, not a cache of it. It is
// what lets an orphaned fork still say what it came from, so going stale when the parent
// is renamed is correct behaviour rather than a bug to fix later.
const LINEAGE_COLUMNS = [
  ['parent_id', 'TEXT DEFAULT NULL'],
  ['parent_name', "TEXT DEFAULT ''"],
];
for (const [column, definition] of LINEAGE_COLUMNS) {
  const present = db
    .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('queries') WHERE name = ?")
    .get(column).n > 0;
  if (!present) {
    // Interpolated rather than bound: SQLite does not accept parameters in DDL. Both
    // values are local constants, never request data.
    db.prepare(`ALTER TABLE queries ADD COLUMN ${column} ${definition}`).run();
  }
}

// AI provenance. A bounded record of what a model authored AND the operator accepted
// during an AI-assisted session — see the design's data-model section. Stored as JSON,
// parsed defensively on read, and deliberately NOT spread into the detection block:
// it must never reach the Sentinel/Navigator exports, which are the v4 metadata
// document. Cap of ten is enforced at validation time (api/validate.js), keeping the
// column itself an unopinionated JSON text.
const hasProvenance = db
  .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('queries') WHERE name = 'ai_provenance'")
  .get().n > 0;
if (!hasProvenance) {
  db.prepare("ALTER TABLE queries ADD COLUMN ai_provenance TEXT NOT NULL DEFAULT '[]'").run();
}

// Table schemas. Independent of `queries` by design: this is reference data about the
// tables a query reads from, not part of a query record, and nothing joins the two.
db.prepare(`
  CREATE TABLE IF NOT EXISTS table_schemas (
    name    TEXT PRIMARY KEY,
    columns TEXT NOT NULL DEFAULT '[]',
    notes   TEXT DEFAULT '',
    source  TEXT DEFAULT 'getschema',
    updated TEXT NOT NULL
  )
`).run();

module.exports = db;
