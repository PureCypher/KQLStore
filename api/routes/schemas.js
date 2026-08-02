const { Router } = require('express');
const db = require('../db');
const { validateSchemaPayload } = require('../validate');

const router = Router();

/**
 * Normalise the table name from a path parameter. validateSchemaPayload trims the name
 * on write, so we must trim it consistently on read and delete too. Otherwise a client
 * that PUT /api/schemas/%20%20Padded%20%20 gets a 200 but cannot GET or DELETE at the
 * same URL.
 */
function keyFrom(raw) {
  return String(raw ?? '').trim();
}

/**
 * Parse the columns document defensively. Same reasoning as parseTags in routes/queries.js:
 * one malformed row must not take down the list endpoint for every other table.
 */
function parseColumns(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toFrontend(row) {
  return {
    name: row.name,
    columns: parseColumns(row.columns),
    notes: row.notes || '',
    source: row.source || 'getschema',
    updated: row.updated,
  };
}

function notFound() {
  const error = new Error('Schema not found');
  error.statusCode = 404;
  return error;
}

router.get('/', (_req, res, next) => {
  try {
    res.json(db.prepare('SELECT * FROM table_schemas ORDER BY name ASC').all().map(toFrontend));
  } catch (err) {
    next(err);
  }
});

router.get('/:name', (req, res, next) => {
  try {
    const name = keyFrom(req.params.name);
    const row = db.prepare('SELECT * FROM table_schemas WHERE name = ?').get(name);
    if (!row) throw notFound();
    res.json(toFrontend(row));
  } catch (err) {
    next(err);
  }
});

// PUT is an upsert keyed on the path name. The body's own `name` is ignored: two sources
// of truth for the key is how you end up with a row nobody can address.
router.put('/:name', (req, res, next) => {
  try {
    const name = keyFrom(req.params.name);
    const v = validateSchemaPayload({ ...req.body, name });
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO table_schemas (name, columns, notes, source, updated)
      VALUES (@name, @columns, @notes, @source, @updated)
      ON CONFLICT(name) DO UPDATE SET
        columns = @columns, notes = @notes, source = @source, updated = @updated
    `).run({ ...v, updated: now });
    res.json(toFrontend(db.prepare('SELECT * FROM table_schemas WHERE name = ?').get(v.name)));
  } catch (err) {
    next(err);
  }
});

router.delete('/:name', (req, res, next) => {
  try {
    const name = keyFrom(req.params.name);
    const result = db.prepare('DELETE FROM table_schemas WHERE name = ?').run(name);
    if (result.changes === 0) throw notFound();
    res.json({ deleted: name });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
