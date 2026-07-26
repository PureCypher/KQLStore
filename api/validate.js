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
  description: 1000,
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
};

const IMPORT_MODES = ['insert', 'upsert'];

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

  const metadata = checkMetadata(collectMetadata(body));
  if (metadata !== undefined) out.metadata = metadata;

  return out;
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

module.exports = {
  validateQueryPayload,
  validateSyncFields,
  validateImportMode,
  validateExpectedUpdated,
  validatePagination,
  badRequest,
  CATEGORIES,
  IMPORT_MODES,
  LIMITS,
  SCHEMA_VERSION,
};
