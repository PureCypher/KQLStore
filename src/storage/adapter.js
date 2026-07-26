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

const StorageAdapter = {
  // ---- API methods (source of truth) ----

  async fetchAll() {
    const start = Date.now();
    try {
      const res = await fetch(`${API_BASE}/queries`, { credentials: 'include' });
      if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
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
      if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
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
      if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
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
      if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
      operationLog.add({ type: 'API_DELETE', key: id, success: true, latencyMs: Date.now() - start });
    } catch (e) {
      operationLog.add({ type: 'API_DELETE', key: id, success: false, latencyMs: Date.now() - start, error: e.message });
      throw e;
    }
  },

  async importQueries(queries) {
    const start = Date.now();
    try {
      const res = await fetch(`${API_BASE}/queries/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries }),
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
      const data = await res.json();
      operationLog.add({ type: 'API_IMPORT', key: 'bulk', success: true, latencyMs: Date.now() - start });
      return data;
    } catch (e) {
      operationLog.add({ type: 'API_IMPORT', key: 'bulk', success: false, latencyMs: Date.now() - start, error: e.message });
      throw e;
    }
  },

  async exportQueries() {
    const start = Date.now();
    try {
      const res = await fetch(`${API_BASE}/queries/export`, { credentials: 'include' });
      if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
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
      if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
      const data = await res.json();
      operationLog.add({ type: 'API_HEALTH', key: 'health', success: true, latencyMs: Date.now() - start });
      return data;
    } catch (e) {
      operationLog.add({ type: 'API_HEALTH', key: 'health', success: false, latencyMs: Date.now() - start, error: e.message });
      throw e;
    }
  },

  // ---- localStorage cache methods (fast path + offline) ----

  getCachedData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = safeJsonParse(raw);
      if (parsed.ok && parsed.data) {
        const migrated = migrateData(parsed.data);
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
