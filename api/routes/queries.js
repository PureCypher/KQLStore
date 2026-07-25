const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { validateQueryPayload, badRequest, LIMITS } = require('../validate');

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the tags column defensively. An unguarded JSON.parse here takes down every
 * endpoint that touches the row — list, get and export — if a single row holds
 * malformed JSON or a non-array value.
 */
function parseTags(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/** Convert a DB row to the frontend-friendly shape. */
function toFrontend(row) {
  return {
    id: row.id,
    name: row.name,
    query: row.query,
    description: row.description,
    category: row.category,
    table: row.table_name,
    tags: parseTags(row.tags),
    favorite: row.favorite === 1,
    usageCount: row.usage_count,
    created: row.created,
    updated: row.updated,
  };
}

// ---------------------------------------------------------------------------
// GET /api/queries — list all queries
// ---------------------------------------------------------------------------
router.get('/', (_req, res, next) => {
  try {
    const rows = db.prepare('SELECT * FROM queries ORDER BY updated DESC').all();
    res.json(rows.map(toFrontend));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/queries/export — bulk export in schema v3 format
// ---------------------------------------------------------------------------
router.get('/export', (_req, res, next) => {
  try {
    const rows = db.prepare('SELECT * FROM queries ORDER BY updated DESC').all();
    const queries = rows.map(toFrontend);
    res.json({
      schemaVersion: 3,
      queries,
      meta: {
        lastUpdated: new Date().toISOString(),
        totalQueries: queries.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/queries/import — bulk import (INSERT OR IGNORE)
// ---------------------------------------------------------------------------
router.post('/import', (req, res, next) => {
  try {
    const { queries } = req.body;

    if (!Array.isArray(queries)) {
      throw badRequest('Request body must contain a "queries" array');
    }
    if (queries.length > LIMITS.importItems) {
      throw badRequest(`"queries" exceeds ${LIMITS.importItems} entries`);
    }

    // Validate every item up front so a malformed batch is rejected as a unit rather
    // than half-written. Invalid items are reported, not silently stored.
    const valid = [];
    const rejected = [];
    queries.forEach((q, i) => {
      try {
        valid.push({ ...validateQueryPayload(q, { partial: false }), id: q.id, created: q.created, updated: q.updated });
      } catch (e) {
        rejected.push({ index: i, reason: e.message });
      }
    });

    const insert = db.prepare(`
      INSERT OR IGNORE INTO queries (id, name, query, description, category, table_name, tags, favorite, usage_count, created, updated)
      VALUES (@id, @name, @query, @description, @category, @table_name, @tags, @favorite, @usage_count, @created, @updated)
    `);

    const now = new Date().toISOString();

    const importMany = db.transaction((items) => {
      let imported = 0;
      for (const q of items) {
        const result = insert.run({
          id: q.id || uuidv4(),
          name: q.name,
          query: q.query,
          description: q.description || '',
          category: q.category || 'Utility',
          table_name: q.table || '',
          tags: JSON.stringify(q.tags || []),
          favorite: q.favorite ? 1 : 0,
          usage_count: Number.isInteger(q.usageCount) && q.usageCount >= 0 ? q.usageCount : 0,
          created: q.created || now,
          updated: q.updated || now,
        });
        if (result.changes > 0) imported++;
      }
      return imported;
    });

    const imported = importMany(valid);
    res.json({ imported, total: queries.length, rejected });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/queries/:id — get a single query
// ---------------------------------------------------------------------------
router.get('/:id', (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM queries WHERE id = ?').get(req.params.id);
    if (!row) {
      const error = new Error('Query not found');
      error.statusCode = 404;
      throw error;
    }
    res.json(toFrontend(row));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/queries — create a new query
// ---------------------------------------------------------------------------
router.post('/', (req, res, next) => {
  try {
    const v = validateQueryPayload(req.body, { partial: false });
    const { name, query, description, category, table, tags, favorite, usageCount } = v;

    const now = new Date().toISOString();
    const id = req.body.id || uuidv4();

    db.prepare(`
      INSERT INTO queries (id, name, query, description, category, table_name, tags, favorite, usage_count, created, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      name,
      query,
      description || '',
      category || 'Utility',
      table || '',
      JSON.stringify(tags || []),
      favorite ? 1 : 0,
      Number.isInteger(usageCount) && usageCount >= 0 ? usageCount : 0,
      now,
      now,
    );

    const row = db.prepare('SELECT * FROM queries WHERE id = ?').get(id);
    res.status(201).json(toFrontend(row));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /api/queries/:id — update an existing query
// ---------------------------------------------------------------------------
router.put('/:id', (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM queries WHERE id = ?').get(req.params.id);
    if (!existing) {
      const error = new Error('Query not found');
      error.statusCode = 404;
      throw error;
    }

    const v = validateQueryPayload(req.body, { partial: true });
    const { name, query, description, category, table, tags, favorite, usageCount } = v;
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE queries
      SET name        = ?,
          query       = ?,
          description = ?,
          category    = ?,
          table_name  = ?,
          tags        = ?,
          favorite    = ?,
          usage_count = ?,
          updated     = ?
      WHERE id = ?
    `).run(
      name ?? existing.name,
      query ?? existing.query,
      description ?? existing.description,
      category ?? existing.category,
      table ?? existing.table_name,
      tags !== undefined ? JSON.stringify(tags) : existing.tags,
      favorite !== undefined ? (favorite ? 1 : 0) : existing.favorite,
      Number.isInteger(usageCount) && usageCount >= 0 ? usageCount : existing.usage_count,
      now,
      req.params.id,
    );

    const row = db.prepare('SELECT * FROM queries WHERE id = ?').get(req.params.id);
    res.json(toFrontend(row));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/queries/:id — delete a query
// ---------------------------------------------------------------------------
router.delete('/:id', (req, res, next) => {
  try {
    const result = db.prepare('DELETE FROM queries WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      const error = new Error('Query not found');
      error.statusCode = 404;
      throw error;
    }
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
