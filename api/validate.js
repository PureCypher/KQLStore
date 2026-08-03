// ---------------------------------------------------------------------------
// Server-side payload validation.
//
// The SPA validates queries before saving, but that is browser-side only and says
// nothing about a direct caller. Without bounds here, one request can write a
// multi-megabyte query body or a 100k-element tags array into the PVC, and a large
// enough store makes GET /api/queries OOM the pod on every read while /api/health
// still reports ok — so the pod never looks unhealthy and restarts into the same
// failure. These limits mirror the SPA's own (KQLStore.jsx validateQuery).
// ---------------------------------------------------------------------------

// Must track CURRENT_SCHEMA_VERSION in src/constants.js. The export route previously
// hardcoded 3 while emitting v4 records, so the API advertised a contract it did not
// honour: a consumer reading schemaVersion 3 would assume the v3 field set and miss the
// whole detection block. Harmless today only because the v3->v4 migration happens to be
// idempotent — the next migration that is not would corrupt every re-imported export.
const SCHEMA_VERSION = 4;

const CATEGORIES = [
  'Detection', 'Hunting', 'Investigation', 'Monitoring', 'Reporting', 'Enrichment', 'Utility',
];

const LIMITS = {
  name: 200,
  query: 50000,
  // Matches src/domain/validate.js, which has always allowed 10 000. These API bounds were
  // retrofitted at 1 000 and the store already held descriptions three times that, so every
  // long-described query became unsaveable — including through paths the operator never
  // thinks of as a save, like the usageCount bump that copying a query performs. The SPA
  // then reported "stored locally only", which is data loss waiting for a cleared cache.
  description: 10000,
  table: 200,
  tagLength: 50,
  tagCount: 20,
  importItems: 1000,
  // The detection block is a JSON document. This bounds it as a whole rather than
  // duplicating the SPA's per-field vocabulary checks, which are the authority.
  metadata: 20000,
  id: 200,
  // Long enough for any ISO 8601 variant with an offset; short enough that a caller
  // cannot smuggle a payload through a timestamp column.
  timestamp: 64,
  // Upper bound for ?limit=. A full store is a few thousand rows, so this is generous
  // while still stopping a single request from materialising an unbounded result set.
  pageSize: 1000,
  schemaName: 200,
  schemaColumns: 500,
  schemaColumnName: 200,
  schemaNotes: 5000,
};

const IMPORT_MODES = ['insert', 'upsert'];

// UUID v4, format only — deliberately mirrors UUID_REGEX in src/constants.js. api/ cannot
// import from src/ (they ship and run separately), so this is redefined rather than shared,
// but the two must agree on what a valid parentId looks like: every id in this store is a
// UUID v4 (see validateSyncFields / uuidv4() in routes/queries.js), so a parentId the SPA
// would reject can never resolve to a row here either. Diverging would let a value pass one
// validator and fail the other on the same payload.
const PARENT_ID_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function checkString(value, field, max, { required }) {
  if (value === undefined || value === null) {
    if (required) throw badRequest(`"${field}" is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw badRequest(`"${field}" must be a string`);
  if (required && value.trim().length === 0) throw badRequest(`"${field}" must not be empty`);
  if (value.length > max) throw badRequest(`"${field}" exceeds ${max} characters`);
  return value;
}

function checkTags(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw badRequest('"tags" must be an array');
  if (value.length > LIMITS.tagCount) throw badRequest(`"tags" exceeds ${LIMITS.tagCount} entries`);
  for (const tag of value) {
    if (typeof tag !== 'string') throw badRequest('"tags" must contain only strings');
    if (tag.length > LIMITS.tagLength) throw badRequest(`a tag exceeds ${LIMITS.tagLength} characters`);
  }
  return value;
}

function checkUsageCount(value) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 0) throw badRequest('"usageCount" must be a non-negative integer');
  return value;
}

// The schema v4 detection fields. toFrontend spreads these back to the top level, so the
// write path must accept them there too — otherwise the API emits a shape it cannot itself
// consume, and a client that round-trips a query would silently drop its metadata.
const DETECTION_FIELDS = [
  'queryType', 'severity', 'confidence', 'platform', 'attack', 'dataSources',
  'entityMappings', 'falsePositives', 'references', 'tuningNotes', 'lookback',
  'version', 'lastValidated', 'author', 'license',
];

/**
 * Collect the detection block from either shape: nested under `metadata`, or spread across
 * the top level as the API itself returns it. Top-level keys win, since that is what a
 * client that read a query and wrote it back will be sending.
 */
function collectMetadata(body) {
  const nested = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? body.metadata
    : {};
  const merged = { ...nested };
  for (const field of DETECTION_FIELDS) {
    if (body[field] !== undefined) merged[field] = body[field];
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * The schema v4 detection block, carried as an opaque JSON object. The SPA validates its
 * shape against the ATT&CK/severity vocabularies; the API's job is to stop it being used as
 * unbounded storage, so it bounds the serialised size and rejects non-objects.
 */
function checkMetadata(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('"metadata" must be a JSON object');
  }
  const encoded = JSON.stringify(value);
  if (encoded.length > LIMITS.metadata) {
    throw badRequest(`"metadata" exceeds ${LIMITS.metadata} characters when serialised`);
  }
  return value;
}

/**
 * Validate a create/update payload. With partial=true (PUT) every field is optional;
 * with partial=false (POST) name and query are required. Returns only the fields that
 * were supplied, so a PUT still coalesces against the existing row.
 * Throws an Error carrying statusCode 400 on the first violation.
 */
function validateQueryPayload(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('request body must be a JSON object');
  }

  const out = {};
  const required = !partial;

  const name = checkString(body.name, 'name', LIMITS.name, { required });
  if (name !== undefined) out.name = name;

  const query = checkString(body.query, 'query', LIMITS.query, { required });
  if (query !== undefined) out.query = query;

  const description = checkString(body.description, 'description', LIMITS.description, { required: false });
  if (description !== undefined) out.description = description;

  const table = checkString(body.table ?? body.table_name, 'table', LIMITS.table, { required: false });
  if (table !== undefined) out.table = table;

  if (body.category !== undefined && body.category !== null) {
    if (!CATEGORIES.includes(body.category)) {
      throw badRequest(`"category" must be one of: ${CATEGORIES.join(', ')}`);
    }
    out.category = body.category;
  }

  const tags = checkTags(body.tags);
  if (tags !== undefined) out.tags = tags;

  if (body.favorite !== undefined && body.favorite !== null) {
    if (typeof body.favorite !== 'boolean') throw badRequest('"favorite" must be a boolean');
    out.favorite = body.favorite;
  }

  const usageCount = checkUsageCount(body.usageCount);
  if (usageCount !== undefined) out.usageCount = usageCount;

  // Fork lineage. parentId is bounded by LIMITS.id because it holds the same kind of
  // value the id column does; parentName by LIMITS.name because it is a copy of one.
  //
  // Resolvability is still not checked here: whether the parent still exists is a question
  // about the store rather than about the payload, and "no" is a legitimate answer — an
  // import can carry a fork whose parent was never exported, and a fork outlives the query
  // it came from by design (see the comment on the columns in db.js).
  //
  // Format IS checked, and it is the same UUID v4 rule src/domain/validate.js applies on
  // the SPA side. Before this, the two disagreed: the API stored any string up to 200
  // characters, so a hand-edited or legacy non-UUID parentId could reach the row here even
  // though the SPA would refuse to keep it past the next save — a fork badge the UI showed
  // the user would then vanish the moment they did something as innocuous as copying the
  // query, with no warning. A non-UUID parentId is DROPPED rather than failing the request:
  // rejecting the payload would turn one hand-edited pointer in a 200-row import into a
  // 400 for the whole batch, and a pointer that can never resolve to a row in this store
  // (every id here is a UUID) is exactly as recoverable as no pointer at all — the same
  // reasoning validateQuery already documents. parentName is dropped with it: the fork
  // badge only renders when parentId is set, so a surviving name with no id would be dead
  // weight on every read.
  const rawParentId = checkString(body.parentId, 'parentId', LIMITS.id, { required: false });
  const rawParentName = checkString(body.parentName, 'parentName', LIMITS.name, { required: false });
  if (rawParentId !== undefined && PARENT_ID_UUID_REGEX.test(rawParentId)) {
    out.parentId = rawParentId;
    if (rawParentName !== undefined) out.parentName = rawParentName;
  } else if (rawParentId === undefined && rawParentName !== undefined) {
    // No parentId in this payload at all (not even an invalid one) — parentName can still
    // travel on its own, e.g. a partial PUT that only touches the name snapshot.
    out.parentName = rawParentName;
  }

  const metadata = checkMetadata(collectMetadata(body));
  if (metadata !== undefined) out.metadata = metadata;

  // AI provenance, kept OUT of collectMetadata: it is not detection metadata and must
  // never ride along in the exported v4 document.
  const aiProvenance = validateProvenance(body.aiProvenance);
  if (aiProvenance !== undefined) out.aiProvenance = aiProvenance;

  return out;
}

const PROVENANCE_REDACTIONS = ['applied', 'overridden'];
const PROVENANCE_MAX = 10;

/**
 * Validate the AI provenance list. Bounded rather than free-form: a provenance record
 * is an audit trail, and an audit trail with a 2000-character model name or a 30-field
 * list is one nobody reads. The list keeps the 10 most recent entries (oldest dropped),
 * and each entry's instruction is truncated rather than rejected — the instruction is
 * the operator's own words and losing them to a strict cap would reject a save.
 * Returns a JSON string, ready to bind.
 */
function validateProvenance(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw badRequest('"aiProvenance" must be an array');

  const out = [];
  for (const entry of value.slice(-PROVENANCE_MAX)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw badRequest('every aiProvenance entry must be an object');
    }
    if (typeof entry.model !== 'string' || entry.model.length === 0 || entry.model.length > 100) {
      throw badRequest('aiProvenance "model" must be a string of 1-100 characters');
    }
    if (typeof entry.generatedAt !== 'string' || entry.generatedAt.length > 64) {
      throw badRequest('aiProvenance "generatedAt" must be a string of at most 64 characters');
    }
    if (!PROVENANCE_REDACTIONS.includes(entry.redaction)) {
      throw badRequest(`aiProvenance "redaction" must be one of: ${PROVENANCE_REDACTIONS.join(', ')}`);
    }
    const fields = Array.isArray(entry.fields) ? entry.fields : [];
    if (fields.length > 20 || fields.some((f) => typeof f !== 'string')) {
      throw badRequest('aiProvenance "fields" must be an array of at most 20 strings');
    }
    out.push({
      model: entry.model,
      generatedAt: entry.generatedAt,
      redaction: entry.redaction,
      instruction: typeof entry.instruction === 'string' ? entry.instruction.slice(0, 1000) : '',
      fields,
    });
  }
  return JSON.stringify(out);
}

/**
 * Validate the identity and timestamp fields that ride along with a sync payload.
 * validateQueryPayload deliberately ignores them (they are not user-editable content),
 * so before this existed /import passed q.id, q.created and q.updated straight to the
 * statement binder: an object or number there threw inside the transaction and turned
 * one malformed item into a 500 for the whole batch instead of a per-item rejection.
 * They also decide who wins an upsert, so they must be strings we can reason about.
 */
function validateSyncFields(body) {
  const out = {};

  const id = checkString(body.id, 'id', LIMITS.id, { required: false });
  if (id !== undefined) {
    if (id.trim().length === 0) throw badRequest('"id" must not be empty');
    out.id = id;
  }

  const created = checkString(body.created, 'created', LIMITS.timestamp, { required: false });
  if (created !== undefined) out.created = created;

  const updated = checkString(body.updated, 'updated', LIMITS.timestamp, { required: false });
  if (updated !== undefined) out.updated = updated;

  return out;
}

/**
 * Import mode selector. Unknown values are rejected rather than defaulting to "insert":
 * a typo in a sync client would otherwise silently fall back to the mode that discards
 * updates, which is exactly the failure this option exists to prevent.
 */
function validateImportMode(value) {
  if (value === undefined || value === null) return 'insert';
  if (typeof value !== 'string' || !IMPORT_MODES.includes(value)) {
    throw badRequest(`"mode" must be one of: ${IMPORT_MODES.join(', ')}`);
  }
  return value;
}

/**
 * The optimistic-concurrency precondition on PUT. Opt-in: absent means "last write wins",
 * which is what the SPA still does.
 */
function validateExpectedUpdated(value) {
  if (value === undefined || value === null) return undefined;
  const expected = checkString(value, 'expectedUpdated', LIMITS.timestamp, { required: false });
  if (expected.trim().length === 0) throw badRequest('"expectedUpdated" must not be empty');
  return expected;
}

/** Query-string integers arrive as strings, or as arrays/objects if repeated or nested. */
function parseBoundedInt(raw, field, min, max) {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw badRequest(`"${field}" must be a non-negative integer`);
  }
  const n = Number(raw);
  if (n < min || n > max) throw badRequest(`"${field}" must be between ${min} and ${max}`);
  return n;
}

/**
 * Optional paging for GET /api/queries. Both absent means "return everything", which is
 * the behaviour the SPA depends on — it holds the whole store in memory and filters
 * client-side.
 */
function validatePagination(query) {
  return {
    limit: parseBoundedInt(query.limit, 'limit', 1, LIMITS.pageSize),
    offset: parseBoundedInt(query.offset, 'offset', 0, Number.MAX_SAFE_INTEGER),
  };
}

const SCHEMA_SOURCES = ['getschema', 'manual', 'import'];

/**
 * Validate a table schema. Columns are returned already serialised, because every caller
 * binds them straight into SQLite and re-stringifying at each call site is how the two
 * sides drift apart.
 *
 * A missing column type is defaulted rather than rejected: `getschema` output pasted from
 * the portal sometimes loses the type column to a copy that clipped it, and a column list
 * without types is still far more useful to a reader than no schema at all.
 */
function validateSchemaPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('request body must be a JSON object');
  }

  const name = checkString(body.name, 'name', LIMITS.schemaName, { required: true });

  if (body.columns !== undefined && !Array.isArray(body.columns)) {
    throw badRequest('"columns" must be an array');
  }
  const raw = body.columns || [];
  if (raw.length > LIMITS.schemaColumns) {
    throw badRequest(`"columns" exceeds ${LIMITS.schemaColumns} entries`);
  }

  const columns = raw.map((col) => {
    if (!col || typeof col !== 'object' || Array.isArray(col)) {
      throw badRequest('every column must be an object');
    }
    if (typeof col.name !== 'string' || !col.name.trim()) {
      throw badRequest('every column needs a "name"');
    }
    if (col.name.length > LIMITS.schemaColumnName) {
      throw badRequest(`a column name exceeds ${LIMITS.schemaColumnName} characters`);
    }
    return {
      name: col.name.trim(),
      type: typeof col.type === 'string' && col.type.trim() ? col.type.trim() : 'unknown',
    };
  });

  const notes = checkString(body.notes, 'notes', LIMITS.schemaNotes, { required: false }) ?? '';

  const source = body.source ?? 'getschema';
  if (!SCHEMA_SOURCES.includes(source)) {
    throw badRequest(`"source" must be one of: ${SCHEMA_SOURCES.join(', ')}`);
  }

  return { name: name.trim(), columns: JSON.stringify(columns), notes, source };
}

module.exports = {
  validateQueryPayload,
  validateSyncFields,
  validateImportMode,
  validateExpectedUpdated,
  validatePagination,
  validateSchemaPayload,
  validateProvenance,
  badRequest,
  CATEGORIES,
  IMPORT_MODES,
  LIMITS,
  SCHEMA_SOURCES,
  SCHEMA_VERSION,
};
