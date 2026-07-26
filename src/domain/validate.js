import { CATEGORIES, UUID_REGEX } from '../constants.js';

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

  // Preserve timestamps
  sanitized.created = typeof query.created === 'string' ? query.created : new Date().toISOString();
  sanitized.updated = typeof query.updated === 'string' ? query.updated : new Date().toISOString();

  return {
    valid: errors.length === 0,
    errors,
    sanitized: errors.some(e => e.startsWith('id must') || e.startsWith('name must') || e.startsWith('query must')) ? null : sanitized,
  };
}

export { validateQuery };
