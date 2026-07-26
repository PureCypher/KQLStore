// ============================================================
// Safe JSON Handling (FIXES Finding 5: validate stored JSON on read)
// ============================================================
function stripDangerousKeys(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripDangerousKeys);
  const clean = {};
  for (const key of Object.keys(obj)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    clean[key] = stripDangerousKeys(obj[key]);
  }
  return clean;
}

function safeJsonParse(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, data: null, error: 'Input is not a string' };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || (typeof parsed !== 'object')) {
      return { ok: false, data: null, error: 'Parsed value is not an object or array' };
    }
    const sanitized = stripDangerousKeys(parsed);
    return { ok: true, data: sanitized, error: null };
  } catch (e) {
    return { ok: false, data: null, error: e.message };
  }
}

export { stripDangerousKeys, safeJsonParse };
