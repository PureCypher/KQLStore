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
    created     TEXT NOT NULL,
    updated     TEXT NOT NULL
  )
`;

db.prepare(createTableSQL).run();

module.exports = db;
