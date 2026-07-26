import {
  CATEGORIES, UUID_REGEX, ATTACK_TACTICS, TECHNIQUE_REGEX, SEVERITIES, CONFIDENCES,
  QUERY_TYPES, PLATFORMS, ENTITY_TYPES, TIMESPAN_REGEX, SEMVER_REGEX, ISO_DATE_REGEX,
} from '../constants.js';

// ------------------------------------------------------------
// Detection metadata helpers (schema v4)
//
// Each returns the sanitised value and pushes a message onto errors when the input was
// present but wrong. Absent is always acceptable — the whole block is optional, so an
// existing v3 query stays valid and the editor can fill it in over time.
// ------------------------------------------------------------

/** A value from a fixed vocabulary. */
function enumField(value, field, allowed, errors) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!allowed.includes(value)) {
    errors.push(`${field} must be one of: ${allowed.join(', ')}`);
    return undefined;
  }
  return value;
}

/** An array of values from a fixed vocabulary, de-duplicated and order-preserving. */
function enumArray(value, field, allowed, errors, max = 32) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) { errors.push(`${field} must be an array`); return undefined; }
  const out = [];
  for (const item of value.slice(0, max)) {
    if (!allowed.includes(item)) { errors.push(`${field} contains an unknown value: ${item}`); continue; }
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/** An array of strings matching a pattern (technique IDs, timespans, dates). */
function patternArray(value, field, pattern, errors, max = 32) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) { errors.push(`${field} must be an array`); return undefined; }
  const out = [];
  for (const item of value.slice(0, max)) {
    if (typeof item !== 'string' || !pattern.test(item)) {
      errors.push(`${field} contains an invalid entry: ${String(item)}`);
      continue;
    }
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/** A bounded array of free-text strings (false positives, tuning notes, connectors). */
function textArray(value, field, errors, { max = 20, maxLength = 500 } = {}) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) { errors.push(`${field} must be an array`); return undefined; }
  return value
    .filter((t) => typeof t === 'string' && t.trim().length > 0)
    .map((t) => t.trim().slice(0, maxLength))
    .slice(0, max);
}

/** http(s) URLs only — a reference field is a link, not a script sink. */
function urlArray(value, field, errors, max = 20) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) { errors.push(`${field} must be an array`); return undefined; }
  const out = [];
  for (const item of value.slice(0, max)) {
    if (typeof item !== 'string') { errors.push(`${field} must contain strings`); continue; }
    let parsed;
    try { parsed = new URL(item); } catch { errors.push(`${field} contains an invalid URL: ${item}`); continue; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      errors.push(`${field} must use http or https: ${item}`);
      continue;
    }
    out.push(item);
  }
  return out;
}

/** Sentinel-compatible entity mappings. */
function entityMappings(value, field, errors, max = 10) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) { errors.push(`${field} must be an array`); return undefined; }
  const out = [];
  for (const m of value.slice(0, max)) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) { errors.push(`${field} entries must be objects`); continue; }
    if (!ENTITY_TYPES.includes(m.entityType)) {
      errors.push(`${field} has an unknown entityType: ${String(m.entityType)}`);
      continue;
    }
    if (typeof m.columnName !== 'string' || !m.columnName.trim()) {
      errors.push(`${field} entry for ${m.entityType} needs a columnName`);
      continue;
    }
    out.push({
      entityType: m.entityType,
      identifier: typeof m.identifier === 'string' ? m.identifier.trim().slice(0, 100) : '',
      columnName: m.columnName.trim().slice(0, 100),
    });
  }
  return out;
}

/**
 * Validate the optional detection block. Returns only the keys that were supplied and
 * valid, so an untouched v3 record round-trips byte-for-byte.
 */
function validateDetectionMetadata(query, errors) {
  const out = {};
  const set = (key, value) => { if (value !== undefined) out[key] = value; };

  set('queryType', enumField(query.queryType, 'queryType', QUERY_TYPES, errors));
  set('severity', enumField(query.severity, 'severity', SEVERITIES, errors));
  set('confidence', enumField(query.confidence, 'confidence', CONFIDENCES, errors));
  set('platform', enumArray(query.platform, 'platform', PLATFORMS, errors));

  if (query.attack !== undefined && query.attack !== null) {
    if (typeof query.attack !== 'object' || Array.isArray(query.attack)) {
      errors.push('attack must be an object with tactics and techniques');
    } else {
      const attack = {};
      const tactics = enumArray(query.attack.tactics, 'attack.tactics', ATTACK_TACTICS, errors);
      const techniques = patternArray(query.attack.techniques, 'attack.techniques', TECHNIQUE_REGEX, errors);
      if (tactics !== undefined) attack.tactics = tactics;
      if (techniques !== undefined) attack.techniques = techniques;
      if (Object.keys(attack).length > 0) out.attack = attack;
    }
  }

  if (query.dataSources !== undefined && query.dataSources !== null) {
    if (typeof query.dataSources !== 'object' || Array.isArray(query.dataSources)) {
      errors.push('dataSources must be an object');
    } else {
      const ds = {};
      const connectors = textArray(query.dataSources.connectors, 'dataSources.connectors', errors, { max: 20, maxLength: 100 });
      const tables = textArray(query.dataSources.tables, 'dataSources.tables', errors, { max: 30, maxLength: 200 });
      if (connectors !== undefined) ds.connectors = connectors;
      if (tables !== undefined) ds.tables = tables;
      if (Object.keys(ds).length > 0) out.dataSources = ds;
    }
  }

  set('entityMappings', entityMappings(query.entityMappings, 'entityMappings', errors));
  set('falsePositives', textArray(query.falsePositives, 'falsePositives', errors));
  set('references', urlArray(query.references, 'references', errors));

  if (typeof query.tuningNotes === 'string' && query.tuningNotes.trim()) {
    out.tuningNotes = query.tuningNotes.trim().slice(0, 2000);
  }
  if (query.lookback !== undefined && query.lookback !== null && query.lookback !== '') {
    if (typeof query.lookback === 'string' && TIMESPAN_REGEX.test(query.lookback)) out.lookback = query.lookback;
    else errors.push('lookback must be a KQL timespan literal such as 7d or 90m');
  }
  if (query.version !== undefined && query.version !== null && query.version !== '') {
    if (typeof query.version === 'string' && SEMVER_REGEX.test(query.version)) out.version = query.version;
    else errors.push('version must be semver, e.g. 1.2.0');
  }
  if (query.lastValidated !== undefined && query.lastValidated !== null && query.lastValidated !== '') {
    if (typeof query.lastValidated === 'string' && ISO_DATE_REGEX.test(query.lastValidated)) {
      out.lastValidated = query.lastValidated;
    } else {
      errors.push('lastValidated must be an ISO date, e.g. 2026-07-26');
    }
  }
  for (const field of ['author', 'license']) {
    if (typeof query[field] === 'string' && query[field].trim()) {
      out[field] = query[field].trim().slice(0, 100);
    }
  }
  return out;
}


// ============================================================
// Query Validation (FIXES Finding 5, Finding 9: validate all data, strip unexpected fields)
// ============================================================
function validateQuery(query) {
  const errors = [];

  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    return { valid: false, errors: ['Query must be a plain object'], sanitized: null };
  }

  // Strip to known fields only
  const sanitized = {};

  // id
  if (!query.id || typeof query.id !== 'string' || !UUID_REGEX.test(query.id)) {
    errors.push('id must be a valid UUID v4');
  } else {
    sanitized.id = query.id;
  }

  // name
  if (!query.name || typeof query.name !== 'string' || query.name.trim().length < 1 || query.name.trim().length > 200) {
    errors.push('name must be a string of 1-200 characters');
  } else {
    sanitized.name = query.name.trim();
  }

  // query body
  if (!query.query || typeof query.query !== 'string' || query.query.length < 1 || query.query.length > 50000) {
    errors.push('query must be a string of 1-50000 characters');
  } else {
    sanitized.query = query.query;
  }

  // description (optional)
  if (query.description !== undefined && query.description !== null) {
    if (typeof query.description !== 'string' || query.description.length > 10000) {
      errors.push('description must be a string of 0-10000 characters');
    } else {
      sanitized.description = query.description;
    }
  } else {
    sanitized.description = '';
  }

  // category (optional)
  if (query.category !== undefined && query.category !== null) {
    if (!CATEGORIES.includes(query.category)) {
      errors.push('category must be one of: ' + CATEGORIES.join(', '));
      sanitized.category = 'Utility';
    } else {
      sanitized.category = query.category;
    }
  } else {
    sanitized.category = 'Utility';
  }

  // table (required)
  if (!query.table || typeof query.table !== 'string' || query.table.trim().length < 1 || query.table.trim().length > 200) {
    errors.push('table must be a non-empty string');
    sanitized.table = 'Custom';
  } else {
    sanitized.table = query.table.trim();
  }

  // tags (optional)
  if (query.tags !== undefined && query.tags !== null) {
    if (!Array.isArray(query.tags)) {
      errors.push('tags must be an array');
      sanitized.tags = [];
    } else {
      const validTags = query.tags
        .filter(t => typeof t === 'string' && t.trim().length > 0 && t.trim().length <= 50)
        .map(t => t.trim())
        .slice(0, 20);
      sanitized.tags = validTags;
    }
  } else {
    sanitized.tags = [];
  }

  // favorite (optional)
  sanitized.favorite = typeof query.favorite === 'boolean' ? query.favorite : false;

  // usageCount (optional)
  if (query.usageCount !== undefined && query.usageCount !== null) {
    const uc = Number(query.usageCount);
    sanitized.usageCount = Number.isInteger(uc) && uc >= 0 ? uc : 0;
  } else {
    sanitized.usageCount = 0;
  }

  // Detection metadata (schema v4) — optional; absent keys are simply not written back.
  Object.assign(sanitized, validateDetectionMetadata(query, errors));

  // Preserve timestamps
  sanitized.created = typeof query.created === 'string' ? query.created : new Date().toISOString();
  sanitized.updated = typeof query.updated === 'string' ? query.updated : new Date().toISOString();

  return {
    valid: errors.length === 0,
    errors,
    sanitized: errors.some(e => e.startsWith('id must') || e.startsWith('name must') || e.startsWith('query must')) ? null : sanitized,
  };
}

export { validateQuery, validateDetectionMetadata };
