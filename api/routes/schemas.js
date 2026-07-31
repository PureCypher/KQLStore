const { Router } = require('express');
const db = require('../db');
const { validateSchemaPayload } = require('../validate');

const router = Router();

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
    const row = db.prepare('SELECT * FROM table_schemas WHERE name = ?').get(req.params.name);
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
    const v = validateSchemaPayload({ ...req.body, name: req.params.name });
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
    const result = db.prepare('DELETE FROM table_schemas WHERE name = ?').run(req.params.name);
    if (result.changes === 0) throw notFound();
    res.json({ deleted: req.params.name });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
