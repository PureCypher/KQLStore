const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const {
  validateQueryPayload,
  validateSyncFields,
  validateImportMode,
  validateExpectedUpdated,
  SCHEMA_VERSION,
  validatePagination,
  badRequest,
  LIMITS,
} = require('../validate');

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

/** Parse the metadata document defensively — one malformed row must not 500 the list. */
function parseMetadata(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Parse the provenance column defensively, same reasoning as parseTags: one malformed
 * row must not take down the list. Entries that are not objects are dropped rather than
 * surfaced — a provenance list that cannot be read is not worth blocking the store for.
 */
function parseProvenance(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((e) => e && typeof e === 'object' && !Array.isArray(e))
      : [];
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
    // Spread the v4 detection block back to the top level, which is the shape the SPA's
    // validateQuery works in. Stored nested so it is one additive column, not seventeen.
    ...parseMetadata(row.metadata),
    // Lineage and provenance are assigned AFTER the spread on purpose. collectMetadata
    // merges body.metadata wholesale, so a caller can put a parentId or an aiProvenance
    // inside it; if these were above the spread, that smuggled value would overwrite the
    // real column. The column is the truth, so it is written last.
    parentId: row.parent_id ?? null,
    parentName: row.parent_name ?? '',
    aiProvenance: parseProvenance(row.ai_provenance),
    created: row.created,
    updated: row.updated,
  };
}

function notFound() {
  const error = new Error('Query not found');
  error.statusCode = 404;
  return error;
}

/**
 * Is the incoming row strictly newer than the stored one? Compared as instants rather
 * than lexically, because an exported file may carry an offset ("+01:00") that sorts
 * before a Z timestamp of the same moment. A timestamp we cannot parse never wins —
 * refusing to overwrite is the recoverable outcome; overwriting is not.
 */
function isNewer(incoming, stored) {
  const a = Date.parse(incoming);
  if (Number.isNaN(a)) return false;
  const b = Date.parse(stored);
  if (Number.isNaN(b)) return true;
  return a > b;
}

// ---------------------------------------------------------------------------
// GET /api/queries — list queries, newest first
//
// limit/offset are optional and both default to absent, which returns the whole table
// exactly as before. id is a tiebreaker so that paging over rows sharing an "updated"
// value cannot show one row twice and skip another.
// ---------------------------------------------------------------------------
router.get('/', (req, res, next) => {
  try {
    const { limit, offset } = validatePagination(req.query);

    const rows = limit === undefined && offset === undefined
      ? db.prepare('SELECT * FROM queries ORDER BY updated DESC, id ASC').all()
      // SQLite has no bare OFFSET; -1 is its idiom for "no limit", which is what an
      // offset-only request needs.
      : db.prepare('SELECT * FROM queries ORDER BY updated DESC, id ASC LIMIT ? OFFSET ?')
        .all(limit ?? -1, offset ?? 0);

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
      schemaVersion: SCHEMA_VERSION,
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
// POST /api/queries/import — bulk import
//
// mode=insert (default) keeps the original INSERT OR IGNORE semantics: an id that
// already exists is left alone.
//
// mode=upsert exists because the SPA syncs offline work through this endpoint. Under
// insert semantics an offline EDIT to a query that already exists on the server was
// silently dropped on reconnect — the user's change vanished with a success response.
// Upsert overwrites, but only when the incoming row is strictly newer than the stored
// one, so a stale tab reconnecting cannot roll back someone else's later edit. Arrival
// order decides nothing; the timestamps do.
// ---------------------------------------------------------------------------
router.post('/import', (req, res, next) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw badRequest('request body must be a JSON object');
    }

    const { queries } = body;
    const mode = validateImportMode(body.mode);

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
        valid.push({
          index: i,
          ...validateQueryPayload(q, { partial: false }),
          ...validateSyncFields(q),
        });
      } catch (e) {
        rejected.push({ index: i, reason: e.message });
      }
    });

    const selectStored = db.prepare('SELECT updated, created, usage_count FROM queries WHERE id = ?');
    const insert = db.prepare(`
      INSERT INTO queries (id, name, query, description, category, table_name, tags, favorite, usage_count, metadata, parent_id, parent_name, ai_provenance, created, updated)
      VALUES (@id, @name, @query, @description, @category, @table_name, @tags, @favorite, @usage_count, @metadata, @parent_id, @parent_name, @ai_provenance, @created, @updated)
    `);
    const update = db.prepare(`
      UPDATE queries
      SET name        = @name,
          query       = @query,
          description = @description,
          category    = @category,
          table_name  = @table_name,
          tags        = @tags,
          favorite    = @favorite,
          usage_count = @usage_count,
          metadata    = @metadata,
          parent_id   = @parent_id,
          parent_name = @parent_name,
          ai_provenance = @ai_provenance,
          updated     = @updated
      WHERE id = @id
    `);

    const now = new Date().toISOString();

    const importMany = db.transaction((items) => {
      const results = [];
      for (const item of items) {
        const row = {
          id: item.id || uuidv4(),
          name: item.name,
          query: item.query,
          description: item.description || '',
          category: item.category || 'Utility',
          table_name: item.table || '',
          tags: JSON.stringify(item.tags || []),
          favorite: item.favorite ? 1 : 0,
          usage_count: Number.isInteger(item.usageCount) && item.usageCount >= 0 ? item.usageCount : 0,
          metadata: JSON.stringify(item.metadata || {}),
          parent_id: item.parentId ?? null,
          parent_name: item.parentName ?? '',
          ai_provenance: item.aiProvenance !== undefined
            ? JSON.stringify(item.aiProvenance)
            : '[]',
          created: item.created || now,
          updated: item.updated || now,
        };

        const stored = selectStored.get(row.id);

        if (!stored) {
          insert.run(row);
          results.push({ index: item.index, id: row.id, outcome: 'inserted' });
          continue;
        }
        if (mode !== 'upsert') {
          results.push({ index: item.index, id: row.id, outcome: 'skipped-existing' });
          continue;
        }
        if (!isNewer(row.updated, stored.updated)) {
          results.push({ index: item.index, id: row.id, outcome: 'skipped-older' });
          continue;
        }

        // created is a fact about the row, not about this edit, so the stored value wins.
        // usage_count is a monotonic counter: taking the larger of the two keeps the
        // increments made on whichever side was offline instead of resetting them.
        update.run({
          ...row,
          created: stored.created,
          usage_count: Math.max(row.usage_count, stored.usage_count),
        });
        results.push({ index: item.index, id: row.id, outcome: 'updated' });
      }
      return results;
    });

    const results = importMany(valid);
    const count = (outcome) => results.filter((r) => r.outcome === outcome).length;
    const inserted = count('inserted');
    const updated = count('updated');

    res.json({
      mode,
      total: queries.length,
      // Retained under its original name and meaning — rows written — so existing
      // callers reading `imported` keep working.
      imported: inserted + updated,
      inserted,
      updated,
      skippedOlder: count('skipped-older'),
      skippedExisting: count('skipped-existing'),
      results,
      rejected,
    });
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
    if (!row) throw notFound();
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
    const { id: suppliedId } = validateSyncFields(req.body);
    const { name, query, description, category, table, tags, favorite, usageCount, parentId, parentName, aiProvenance } = v;

    const now = new Date().toISOString();
    const id = suppliedId || uuidv4();

    db.prepare(`
      INSERT INTO queries (id, name, query, description, category, table_name, tags, favorite, usage_count, metadata, parent_id, parent_name, ai_provenance, created, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      JSON.stringify(v.metadata || {}),
      parentId ?? null,
      parentName ?? '',
      aiProvenance !== undefined ? aiProvenance : '[]',
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
//
// Optimistic concurrency is opt-in: send the "updated" value the edit was based on, as
// body.expectedUpdated or the X-Expected-Updated header, and the write is refused with
// 409 if the stored row has moved on since. Two people editing the same query in two
// browsers otherwise clobber each other silently, last save winning by accident of
// arrival. Callers that omit it — including the SPA today — are unaffected.
//
// The comparison is exact string equality, not a timestamp comparison: any movement at
// all invalidates the edit, which is the ETag semantic and avoids clock and precision
// arguments.
// ---------------------------------------------------------------------------
router.put('/:id', (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM queries WHERE id = ?').get(req.params.id);
    if (!existing) throw notFound();

    const expectedUpdated = validateExpectedUpdated(
      req.body?.expectedUpdated ?? req.get('x-expected-updated'),
    );
    if (expectedUpdated !== undefined && expectedUpdated !== existing.updated) {
      // Hand back the current row so the caller can diff or re-base without a second
      // round trip. This is a deliberate 409, not an error path, hence no throw.
      return res.status(409).json({
        error: 'Query was modified by another client',
        expectedUpdated,
        currentUpdated: existing.updated,
        current: toFrontend(existing),
      });
    }

    const v = validateQueryPayload(req.body, { partial: true });
    const { name, query, description, category, table, tags, favorite, usageCount, parentId, parentName, aiProvenance } = v;
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
          metadata    = ?,
          parent_id   = ?,
          parent_name = ?,
          ai_provenance = ?,
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
      v.metadata !== undefined ? JSON.stringify(v.metadata) : existing.metadata,
      // A PUT that never mentions lineage must not orphan the fork, so absent coalesces
      // to the stored value rather than to null.
      parentId ?? existing.parent_id ?? null,
      parentName ?? existing.parent_name ?? '',
      // Provenance is append-only from the SPA's side, so an absent value here must not
      // wipe the stored trail either — same coalesce-as-absent rule as lineage.
      aiProvenance !== undefined ? aiProvenance : existing.ai_provenance,
      now,
      req.params.id,
    );

    const row = db.prepare('SELECT * FROM queries WHERE id = ?').get(req.params.id);
    return res.json(toFrontend(row));
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/queries/:id — delete a query
// ---------------------------------------------------------------------------
router.delete('/:id', (req, res, next) => {
  try {
    const result = db.prepare('DELETE FROM queries WHERE id = ?').run(req.params.id);
    if (result.changes === 0) throw notFound();
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
