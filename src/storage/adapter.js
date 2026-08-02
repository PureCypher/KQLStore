import { STORAGE_KEY, BACKUP_KEY } from '../constants.js';
import { operationLog } from './opLog.js';
import { safeJsonParse } from '../lib/json.js';
import { migrateData } from '../domain/migrate.js';

// ============================================================
// Storage Adapter — API-first with localStorage cache
// Source of truth: REST API (/api/queries)
// Fast path: localStorage cache for instant loads + offline resilience
// ============================================================
const API_BASE = '/api';
const API_RETRY_INTERVAL_MS = 30000;

// A server message is written for a human and is short. Anything longer than this is not
// a message, it is a page — an nginx or Cloudflare Access error document — and pasting it
// into a toast helps nobody.
const ERROR_DETAIL_MAX = 300;

/**
 * Build the Error for a non-2xx response, carrying the server's own explanation.
 *
 * The status line alone is useless to the person who has to fix the problem: every
 * rejection from the API's validation layer arrived as "API 400: Bad Request" when the
 * body already said exactly which field was wrong ("\"tags\" exceeds 20 entries"). The
 * body is read once, here, so every call site gets the same treatment.
 *
 * Reading is deliberately total — a body that is missing, truncated, not JSON, or an HTML
 * error page from a proxy in front of the API must still produce the status-line Error
 * rather than replacing a 500 with a parse failure from this function.
 */
async function apiError(res) {
  const statusLine = `API ${res.status}${res.statusText ? `: ${res.statusText}` : ''}`;
  let detail = '';
  try {
    const raw = await res.text();
    const parsed = safeJsonParse(raw);
    if (parsed.ok && parsed.data && !Array.isArray(parsed.data)) {
      const body = parsed.data;
      const message = typeof body.error === 'string' ? body.error
        : typeof body.message === 'string' ? body.message : '';
      detail = message.slice(0, ERROR_DETAIL_MAX);
    } else if (raw && !raw.includes('<')) {
      // A plain-text body from something other than our own error handler. Markup is
      // excluded rather than stripped: an error page has no message worth extracting.
      detail = raw.trim().slice(0, ERROR_DETAIL_MAX);
    }
  } catch {
    // Body unreadable (aborted or already consumed) — the status line still stands.
  }
  const err = new Error(detail ? `${statusLine} — ${detail}` : statusLine);
  err.status = res.status;
  err.detail = detail;
  return err;
}

const StorageAdapter = {
  // ---- API methods (source of truth) ----

  async fetchAll() {
    const start = Date.now();
    try {
      const res = await fetch(`${API_BASE}/queries`, { credentials: 'include' });
      if (!res.ok) throw await apiError(res);
      const data = await res.json();
      operationLog.add({ type: 'API_FETCH_ALL', key: 'queries', success: true, latencyMs: Date.now() - start });
      return data;
    } catch (e) {
      operationLog.add({ type: 'API_FETCH_ALL', key: 'queries', success: false, latencyMs: Date.now() - start, error: e.message });
      throw e;
    }
  },

  async createQuery(query) {
    const start = Date.now();
    try {
      const res = await fetch(`${API_BASE}/queries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(query),
        credentials: 'include',
      });
      if (!res.ok) throw await apiError(res);
      const data = await res.json();
      operationLog.add({ type: 'API_CREATE', key: query.id, success: true, latencyMs: Date.now() - start });
      return data;
    } catch (e) {
      operationLog.add({ type: 'API_CREATE', key: query.id, success: false, latencyMs: Date.now() - start, error: e.message });
      throw e;
    }
  },

  async updateQuery(id, query) {
    const start = Date.now();
    try {
      const res = await fetch(`${API_BASE}/queries/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(query),
        credentials: 'include',
      });
      if (!res.ok) throw await apiError(res);
      const data = await res.json();
      operationLog.add({ type: 'API_UPDATE', key: id, success: true, latencyMs: Date.now() - start });
      return data;
    } catch (e) {
      operationLog.add({ type: 'API_UPDATE', key: id, success: false, latencyMs: Date.now() - start, error: e.message });
      throw e;
    }
  },

  async deleteQuery(id) {
    const start = Date.now();
    try {
      const res = await fetch(`${API_BASE}/queries/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) throw await apiError(res);
      operationLog.add({ type: 'API_DELETE', key: id, success: true, latencyMs: Date.now() - start });
    } catch (e) {
      operationLog.add({ type: 'API_DELETE', key: id, success: false, latencyMs: Date.now() - start, error: e.message });
      throw e;
    }
  },

  /**
   * Bulk import. `options.mode` selects the server's merge semantics:
   *
   *   'insert' (default) — an id that already exists is left alone.
   *   'upsert'           — an id that already exists is overwritten, but only when the
   *                        incoming row is strictly newer than the stored one.
   *
   * Anything that is not exactly 'upsert' collapses to 'insert'. Overwriting is the
   * destructive direction, so it has to be asked for by name; a caller that forwards a
   * click event or a stale object where options were expected gets the safe mode, not a
   * bulk overwrite.
   */
  async importQueries(queries, options) {
    const start = Date.now();
    const mode = options && options.mode === 'upsert' ? 'upsert' : 'insert';
    try {
      const res = await fetch(`${API_BASE}/queries/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries, mode }),
        credentials: 'include',
      });
      if (!res.ok) throw await apiError(res);
      const data = await res.json();
      operationLog.add({ type: 'API_IMPORT', key: mode, success: true, latencyMs: Date.now() - start });
      return data;
    } catch (e) {
      operationLog.add({ type: 'API_IMPORT', key: mode, success: false, latencyMs: Date.now() - start, error: e.message });
      throw e;
    }
  },

  async exportQueries() {
    const start = Date.now();
    try {
      const res = await fetch(`${API_BASE}/queries/export`, { credentials: 'include' });
      if (!res.ok) throw await apiError(res);
      const data = await res.json();
      operationLog.add({ type: 'API_EXPORT', key: 'bulk', success: true, latencyMs: Date.now() - start });
      return data;
    } catch (e) {
      operationLog.add({ type: 'API_EXPORT', key: 'bulk', success: false, latencyMs: Date.now() - start, error: e.message });
      throw e;
    }
  },

  async healthCheck() {
    const start = Date.now();
    try {
      const res = await fetch(`${API_BASE}/health`, { credentials: 'include' });
      if (!res.ok) throw await apiError(res);
      const data = await res.json();
      operationLog.add({ type: 'API_HEALTH', key: 'health', success: true, latencyMs: Date.now() - start });
      return data;
    } catch (e) {
      operationLog.add({ type: 'API_HEALTH', key: 'health', success: false, latencyMs: Date.now() - start, error: e.message });
      throw e;
    }
  },

  // ---- Schema methods (table_schemas — source of truth) ----

  async fetchSchemas() {
    const start = Date.now();
    try {
      const res = await fetch(`${API_BASE}/schemas`, { credentials: 'include' });
      if (!res.ok) throw await apiError(res);
      const data = await res.json();
      operationLog.add({ type: 'API_FETCH_SCHEMAS', key: 'schemas', success: true, latencyMs: Date.now() - start });
      return data;
    } catch (e) {
      operationLog.add({ type: 'API_FETCH_SCHEMAS', key: 'schemas', success: false, latencyMs: Date.now() - start, error: e.message });
      throw e;
    }
  },

  async saveSchema(name, payload) {
    const start = Date.now();
    try {
      const res = await fetch(`${API_BASE}/schemas/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'include',
      });
      if (!res.ok) throw await apiError(res);
      const data = await res.json();
      operationLog.add({ type: 'API_SAVE_SCHEMA', key: name, success: true, latencyMs: Date.now() - start });
      return data;
    } catch (e) {
      operationLog.add({ type: 'API_SAVE_SCHEMA', key: name, success: false, latencyMs: Date.now() - start, error: e.message });
      throw e;
    }
  },

  async deleteSchema(name) {
    const start = Date.now();
    try {
      const res = await fetch(`${API_BASE}/schemas/${encodeURIComponent(name)}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) throw await apiError(res);
      operationLog.add({ type: 'API_DELETE_SCHEMA', key: name, success: true, latencyMs: Date.now() - start });
    } catch (e) {
      operationLog.add({ type: 'API_DELETE_SCHEMA', key: name, success: false, latencyMs: Date.now() - start, error: e.message });
      throw e;
    }
  },

  // ---- AI assistant methods ----

  /**
   * Redaction preview for one request. Answers "what would leave the cluster, and is it
   * blocked?" A 422 (blocked for a secret) throws the usual apiError, so the caller
   * distinguishes blocked from network failure by the error's `status`.
   */
  async aiRedact(fields) {
    const start = Date.now();
    try {
      const res = await fetch(`${API_BASE}/ai/redact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
        credentials: 'include',
      });
      if (!res.ok) throw await apiError(res);
      const data = await res.json();
      operationLog.add({ type: 'API_AI_REDACT', key: 'redact', success: true, latencyMs: Date.now() - start });
      return data;
    } catch (e) {
      operationLog.add({ type: 'API_AI_REDACT', key: 'redact', success: false, latencyMs: Date.now() - start, error: e.message });
      throw e;
    }
  },

  /**
   * Chat. Returns the raw Response so the caller can read the NDJSON stream itself —
   * this endpoint does not answer with a single JSON document, so it cannot be parsed
   * here the way the other methods parse theirs. Callers check res.ok and handle a
   * 422/503 body themselves.
   */
  async aiChat(body) {
    const start = Date.now();
    const res = await fetch(`${API_BASE}/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    });
    operationLog.add({ type: 'API_AI_CHAT', key: 'chat', success: true, latencyMs: Date.now() - start });
    return res;
  },

  // ---- localStorage cache methods (fast path + offline) ----

  getCachedData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = safeJsonParse(raw);
      if (parsed.ok && parsed.data) {
        const migrated = migrateData(parsed.data);
        // Written by a newer build: use it read-only rather than migrating it backwards.
        // The cache is only a fast path, so ignoring it costs a round trip, not data.
        if (migrated && migrated.tooNew) return null;
        return migrated;
      }
      return null;
    } catch {
      return null;
    }
  },

  setCachedData(blob) {
    try {
      localStorage.setItem(STORAGE_KEY, typeof blob === 'string' ? blob : JSON.stringify(blob));
    } catch {
      // Cache write failure is non-critical
    }
  },

  deleteCachedData() {
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(BACKUP_KEY);
    } catch {
      // Cache clear failure is non-critical
    }
  },

  // Legacy methods kept for backup and health test operations
  async get(key) {
    return localStorage.getItem(key);
  },
  async set(key, value) {
    localStorage.setItem(key, value);
  },
  async delete(key) {
    localStorage.removeItem(key);
  },
  async list(prefix) {
    return Object.keys(localStorage).filter(k => !prefix || k.startsWith(prefix));
  },
};

export { StorageAdapter, API_BASE, API_RETRY_INTERVAL_MS };
