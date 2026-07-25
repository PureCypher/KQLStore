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
};

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

  return out;
}

module.exports = { validateQueryPayload, badRequest, CATEGORIES, LIMITS };
