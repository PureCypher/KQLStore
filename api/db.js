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

module.exports = db;
