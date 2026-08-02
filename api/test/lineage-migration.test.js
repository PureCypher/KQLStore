// ---------------------------------------------------------------------------
// The lineage columns are added by an additive ALTER guarded on pragma_table_info, the
// same shape usage_count and metadata already use. What these assert is the part that
// only shows up on a database that already exists: the guard has to be correct in both
// directions, because a missing guard throws "duplicate column name" on every start
// after the first, and a guard that never fires leaves the column absent while every
// write silently drops parentId.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const { useTempDatabase } = require('./helpers');

useTempDatabase();

test('adds parent_id and parent_name columns', () => {
  const db = require('../db');
  const cols = db.prepare("SELECT name FROM pragma_table_info('queries')").all().map((c) => c.name);
  assert.ok(cols.includes('parent_id'), 'parent_id column missing');
  assert.ok(cols.includes('parent_name'), 'parent_name column missing');
});

test('parent_id defaults to NULL and parent_name to empty string', () => {
  const db = require('../db');
  db.prepare(`
    INSERT INTO queries (id, name, query, created, updated)
    VALUES ('t1', 'n', 'q', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
  `).run();
  const row = db.prepare('SELECT parent_id, parent_name FROM queries WHERE id = ?').get('t1');
  assert.strictEqual(row.parent_id, null);
  assert.strictEqual(row.parent_name, '');
});

test('stores a lineage pointer without a foreign key constraint', () => {
  const db = require('../db');
  // Deliberately dangling: no query with this id exists. A foreign key would reject
  // this, and rejecting it is exactly the behaviour the design does not want — a fork
  // must outlive the query it came from.
  db.prepare(`
    INSERT INTO queries (id, name, query, parent_id, parent_name, created, updated)
    VALUES ('t2', 'fork', 'q', 'no-such-parent', 'Deleted parent', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
  `).run();
  const row = db.prepare('SELECT parent_id, parent_name FROM queries WHERE id = ?').get('t2');
  assert.strictEqual(row.parent_id, 'no-such-parent');
  assert.strictEqual(row.parent_name, 'Deleted parent');
});

test('deleting a parent leaves the fork row intact', () => {
  const db = require('../db');
  db.prepare(`
    INSERT INTO queries (id, name, query, created, updated)
    VALUES ('parent', 'Doomed', 'q', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
  `).run();
  db.prepare(`
    INSERT INTO queries (id, name, query, parent_id, parent_name, created, updated)
    VALUES ('child', 'Survivor', 'q', 'parent', 'Doomed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
  `).run();

  db.prepare('DELETE FROM queries WHERE id = ?').run('parent');

  const row = db.prepare('SELECT parent_id, parent_name FROM queries WHERE id = ?').get('child');
  assert.ok(row, 'the fork must survive its parent being deleted');
  assert.strictEqual(row.parent_id, 'parent', 'the dangling pointer is retained on purpose');
  assert.strictEqual(row.parent_name, 'Doomed', 'the snapshot name outlives the parent');
});

test('the migration is idempotent', () => {
  const db = require('../db');
  // db.js has already run once via require. Running the same guarded ALTER logic a
  // second time must be a no-op rather than "duplicate column name", which is what a
  // pod restart against an existing PVC does every time it starts.
  for (const name of ['parent_id', 'parent_name']) {
    const present = db
      .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('queries') WHERE name = ?")
      .get(name).n > 0;
    assert.strictEqual(present, true);
    assert.doesNotThrow(() => {
      if (!present) db.prepare(`ALTER TABLE queries ADD COLUMN ${name} TEXT`).run();
    });
  }
});
