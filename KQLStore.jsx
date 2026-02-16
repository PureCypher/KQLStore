import React, { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext } from 'react';
import {
  Search, Plus, Copy, Check, Pencil, Trash2, Star, Download, Upload,
  Filter, ChevronDown, ChevronUp, X, Keyboard, Terminal, Menu,
  Clock, Tag, Layers, Square, CheckSquare, Eye, EyeOff,
  Activity, Database, AlertTriangle, Shield, Zap
} from 'lucide-react';

// ============================================================
// UUID Generator
// ============================================================
const generateId = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

// ============================================================
// Constants
// ============================================================
const CATEGORIES = ['Detection', 'Hunting', 'Investigation', 'Monitoring', 'Reporting', 'Enrichment', 'Utility'];

const CATEGORY_COLORS = {
  'Detection':     { bg: 'rgba(255, 68, 68, 0.08)',   text: '#ff6b6b',  border: 'rgba(255, 68, 68, 0.2)' },
  'Hunting':       { bg: 'rgba(0, 255, 136, 0.08)',    text: '#00ff88',  border: 'rgba(0, 255, 136, 0.2)' },
  'Investigation': { bg: 'rgba(255, 180, 0, 0.08)',    text: '#ffb400',  border: 'rgba(255, 180, 0, 0.2)' },
  'Monitoring':    { bg: 'rgba(0, 212, 255, 0.08)',    text: '#00d4ff',  border: 'rgba(0, 212, 255, 0.2)' },
  'Reporting':     { bg: 'rgba(168, 130, 255, 0.08)',  text: '#a882ff',  border: 'rgba(168, 130, 255, 0.2)' },
  'Enrichment':    { bg: 'rgba(229, 192, 123, 0.08)',  text: '#e5c07b',  border: 'rgba(229, 192, 123, 0.2)' },
  'Utility':       { bg: 'rgba(107, 114, 128, 0.08)',  text: '#8b8fa3',  border: 'rgba(107, 114, 128, 0.2)' },
};

const CATEGORY_MIGRATION = {
  'Threat Hunting':    'Hunting',
  'Incident Response': 'Investigation',
  'Identity & Access': 'Detection',
  'Network':           'Detection',
  'Compliance':        'Reporting',
  'Custom':            'Utility',
};

const SENTINEL_TABLES = [
  'SigninLogs','AuditLogs','SecurityEvent','SecurityAlert','SecurityIncident',
  'Syslog','CommonSecurityLog','ThreatIntelligenceIndicator','OfficeActivity',
  'AzureActivity','AzureDiagnostics','Heartbeat','Usage','DnsEvents',
  'W3CIISLog','WindowsFirewall','WindowsEvent',
];

const DEFENDER_TABLES = [
  'DeviceProcessEvents','DeviceNetworkEvents','DeviceFileEvents','DeviceLogonEvents',
  'DeviceRegistryEvents','DeviceImageLoadEvents','DeviceEvents','DeviceInfo',
  'DeviceTvmSoftwareVulnerabilities','EmailEvents','EmailAttachmentInfo','EmailUrlInfo',
  'EmailPostDeliveryEvents','IdentityLogonEvents','IdentityQueryEvents',
  'IdentityDirectoryEvents','CloudAppEvents','AADSignInEventsBeta','AlertInfo',
  'AlertEvidence','BehaviorEntities','BehaviorInfo','UrlClickEvents',
];

const ALL_KNOWN_TABLES = [...SENTINEL_TABLES, ...DEFENDER_TABLES];

const TABLE_STYLES = {
  sentinel: { bg: 'rgba(229, 192, 123, 0.1)', text: '#e5c07b', border: 'rgba(229, 192, 123, 0.25)' },
  defender: { bg: 'rgba(97, 175, 239, 0.1)', text: '#61afef', border: 'rgba(97, 175, 239, 0.25)' },
  custom:   { bg: 'rgba(107, 114, 128, 0.1)', text: '#8b8fa3', border: 'rgba(107, 114, 128, 0.25)' },
};

const SORT_OPTIONS = [
  { value: 'name', label: 'Name' },
  { value: 'created', label: 'Date Created' },
  { value: 'updated', label: 'Date Updated' },
  { value: 'usageCount', label: 'Most Used' },
  { value: 'table', label: 'Table' },
  { value: 'category', label: 'Category' },
];

const STORAGE_KEY = 'kql-store:data';
const BACKUP_KEY = 'kql-store:backup';
const HEALTH_TEST_KEY = 'kql-store:health-test';
const CURRENT_SCHEMA_VERSION = 3;
const SAVE_DEBOUNCE_MS = 2000;
const BACKUP_THROTTLE_MS = 60000;
const MAX_OP_LOG = 50;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

// ============================================================
// Table Helpers
// ============================================================
function getTableGroup(table) {
  if (!table) return 'custom';
  const name = table.startsWith('Custom:') ? table.slice(7) : table;
  if (SENTINEL_TABLES.includes(name)) return 'sentinel';
  if (DEFENDER_TABLES.includes(name)) return 'defender';
  return 'custom';
}

function getTableDisplayName(table) {
  if (!table) return 'Unknown';
  return table.startsWith('Custom:') ? table.slice(7) : table;
}

function detectTableFromQuery(queryBody) {
  if (!queryBody || typeof queryBody !== 'string') return 'Custom';
  const lines = queryBody.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('let ') || trimmed.startsWith('|')) continue;
    const firstWord = trimmed.split(/[\s|(\[]/)[0];
    if (!firstWord) continue;
    if (ALL_KNOWN_TABLES.includes(firstWord)) return firstWord;
    if (firstWord.endsWith('_CL') || firstWord.endsWith('_CF')) return 'Custom:' + firstWord;
    if (/^[A-Z][a-zA-Z0-9]+$/.test(firstWord) && firstWord.length > 3) return 'Custom:' + firstWord;
  }
  return 'Custom';
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
    if (typeof query.description !== 'string' || query.description.length > 1000) {
      errors.push('description must be a string of 0-1000 characters');
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

// ============================================================
// Simple hash for deduplication
// ============================================================
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash = hash & hash;
  }
  return hash.toString(36);
}

// ============================================================
// Schema Migration (FIXES Finding 10: schema versioning with migration path)
// ============================================================
function migrateData(data) {
  if (!data || typeof data !== 'object') return null;
  let version = data.schemaVersion || 1;
  let queries = Array.isArray(data.queries) ? data.queries : [];

  // v1 -> v2: add severity and tags
  if (version < 2) {
    queries = queries.map(q => ({
      ...q,
      severity: q.severity || 'medium',
      tags: Array.isArray(q.tags) ? q.tags : [],
    }));
    version = 2;
  }

  // v2 -> v3: remove severity/platform, add table, migrate categories
  if (version < 3) {
    queries = queries.map(q => {
      const migrated = { ...q };
      // Migrate category
      if (CATEGORY_MIGRATION[migrated.category]) {
        migrated.category = CATEGORY_MIGRATION[migrated.category];
      }
      if (!CATEGORIES.includes(migrated.category)) {
        migrated.category = 'Utility';
      }
      // Detect table from query body
      migrated.table = detectTableFromQuery(migrated.query);
      // Remove deprecated fields
      delete migrated.severity;
      delete migrated.platform;
      return migrated;
    });
    version = 3;
  }

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    queries,
    meta: {
      lastUpdated: new Date().toISOString(),
      totalQueries: queries.length,
    },
  };
}

// ============================================================
// Operation Logger (ring buffer)
// ============================================================
function createOperationLogger() {
  const log = [];
  return {
    add(entry) {
      log.push({
        timestamp: Date.now(),
        ...entry,
      });
      if (log.length > MAX_OP_LOG) log.shift();
    },
    getAll() {
      return [...log];
    },
    clear() {
      log.length = 0;
    },
  };
}

const operationLog = createOperationLogger();

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
      const res = await fetch(`${API_BASE}/queries`);
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
      const res = await fetch(`${API_BASE}/queries/${encodeURIComponent(id)}`, { method: 'DELETE' });
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
      const res = await fetch(`${API_BASE}/queries/export`);
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
      const res = await fetch(`${API_BASE}/health`);
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

// ============================================================
// useKQLStorage Hook (FIXES Finding 6, 8, 12)
// - Finding 6: Auto-backup with throttling, 4-tier recovery cascade
// - Finding 8: Save debouncing (2s) prevents rapid sequential writes
// - Finding 12: Health check reports estimated storage size
// ============================================================
function useKQLStorage() {
  const [queries, setQueries] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [savingState, setSavingState] = useState('idle'); // 'idle' | 'saving' | 'saved' | 'error'
  const [lastSavedTimestamp, setLastSavedTimestamp] = useState(null);
  const [backupTimestamp, setBackupTimestamp] = useState(null);

  const saveTimerRef = useRef(null);
  const lastBackupRef = useRef(0);
  const pendingSaveRef = useRef(null);
  const queriesRef = useRef(queries);
  const apiAvailableRef = useRef(false);
  const retryIntervalRef = useRef(null);

  // Keep ref in sync
  useEffect(() => {
    queriesRef.current = queries;
  }, [queries]);

  // Build a data blob from queries
  const buildBlob = useCallback((queryList) => {
    return JSON.stringify({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      queries: queryList,
      meta: {
        lastUpdated: new Date().toISOString(),
        totalQueries: queryList.length,
      },
    });
  }, []);

  // Write backup (throttled)
  const writeBackup = useCallback(async (blob) => {
    const now = Date.now();
    if (now - lastBackupRef.current < BACKUP_THROTTLE_MS) return;
    try {
      await StorageAdapter.set(BACKUP_KEY, blob);
      lastBackupRef.current = now;
      setBackupTimestamp(new Date().toISOString());
    } catch {
      // Backup failure is non-critical
    }
  }, []);

  // Update localStorage cache (debounced) — cache only, API calls happen directly in saveQuery/deleteQuery
  const persistQueries = useCallback((queryList) => {
    pendingSaveRef.current = queryList;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const toSave = pendingSaveRef.current;
      if (!toSave) return;
      pendingSaveRef.current = null;
      try {
        const blob = buildBlob(toSave);
        StorageAdapter.setCachedData(blob);
        writeBackup(blob);
      } catch {
        // Cache write failure is non-critical
      }
    }, SAVE_DEBOUNCE_MS);
  }, [buildBlob, writeBackup]);

  // Sync all local data to API (used when API comes back online)
  const syncToApi = useCallback(async () => {
    try {
      const current = queriesRef.current;
      if (current.length > 0) {
        await StorageAdapter.importQueries(current);
      }
      // Re-fetch from API to get the merged state
      const apiQueries = await StorageAdapter.fetchAll();
      setQueries(apiQueries);
      const blob = buildBlob(apiQueries);
      StorageAdapter.setCachedData(blob);
      apiAvailableRef.current = true;
    } catch {
      // Sync failed, will retry later
    }
  }, [buildBlob]);

  // Load data: cache first (instant), then API (source of truth)
  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    // Step 1: Load from localStorage cache for instant display
    const cached = StorageAdapter.getCachedData();
    if (cached && Array.isArray(cached.queries)) {
      setQueries(cached.queries);
      setLastSavedTimestamp(cached.meta?.lastUpdated || null);
    }

    // Step 2: Fetch from API (source of truth)
    try {
      const apiQueries = await StorageAdapter.fetchAll();
      setQueries(apiQueries);
      setLastSavedTimestamp(new Date().toISOString());
      apiAvailableRef.current = true;
      // Update cache with API data
      const blob = buildBlob(apiQueries);
      StorageAdapter.setCachedData(blob);
    } catch {
      apiAvailableRef.current = false;
      // API unreachable — keep using cached data (already set above)
      if (!cached || !cached.queries || cached.queries.length === 0) {
        // Try legacy fallback if no cache
        try {
          const legacyRaw = localStorage.getItem('kql-store-queries');
          if (legacyRaw) {
            const parsed = safeJsonParse(legacyRaw);
            if (parsed.ok && Array.isArray(parsed.data)) {
              setQueries(parsed.data);
              StorageAdapter.setCachedData(buildBlob(parsed.data));
            }
          }
        } catch { /* legacy read failed */ }
      }
    }

    setIsLoading(false);
  }, [buildBlob]);

  // Flush pending save synchronously to localStorage (for tab close / visibility change)
  const flushPendingSave = useCallback(() => {
    const toSave = pendingSaveRef.current;
    if (!toSave) return;
    pendingSaveRef.current = null;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    try {
      const blob = buildBlob(toSave);
      localStorage.setItem(STORAGE_KEY, blob);
    } catch {
      // Best-effort on close — nothing we can do if it fails
    }
  }, [buildBlob]);

  // Initialize on mount + register flush-on-close handlers + API retry
  useEffect(() => {
    loadData();

    const handleBeforeUnload = () => flushPendingSave();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushPendingSave();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Retry interval: when API is unavailable, periodically try to re-sync
    retryIntervalRef.current = setInterval(async () => {
      if (!apiAvailableRef.current) {
        try {
          await StorageAdapter.healthCheck();
          apiAvailableRef.current = true;
          await syncToApi();
        } catch {
          // Still unavailable, will retry next interval
        }
      }
    }, API_RETRY_INTERVAL_MS);

    return () => {
      flushPendingSave();
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (retryIntervalRef.current) clearInterval(retryIntervalRef.current);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loadData, flushPendingSave, syncToApi]);

  // Save a single query (create or update) — optimistic UI + API call
  const saveQuery = useCallback(async (queryData) => {
    const now = new Date().toISOString();
    const prepared = {
      ...queryData,
      id: queryData.id || generateId(),
      created: queryData.created || now,
      updated: now,
    };
    const validation = validateQuery(prepared);
    if (!validation.sanitized) {
      return false;
    }
    const sanitized = validation.sanitized;
    let isUpdate = false;

    // Optimistic UI update + cache write
    setQueries((prev) => {
      const idx = prev.findIndex((q) => q.id === sanitized.id);
      let result;
      if (idx >= 0) {
        isUpdate = true;
        result = [...prev];
        result[idx] = sanitized;
      } else {
        result = [...prev, sanitized];
      }
      persistQueries(result);
      return result;
    });

    setSavingState('saving');
    setLastSavedTimestamp(now);

    // Async API call
    if (apiAvailableRef.current) {
      try {
        if (isUpdate) {
          await StorageAdapter.updateQuery(sanitized.id, sanitized);
        } else {
          await StorageAdapter.createQuery(sanitized);
        }
        setSavingState('saved');
        setError(null);
        setTimeout(() => setSavingState((s) => s === 'saved' ? 'idle' : s), 2000);
      } catch {
        apiAvailableRef.current = false;
        setSavingState('saved');
        // Data is safe in cache; will sync when API returns
        setTimeout(() => setSavingState((s) => s === 'saved' ? 'idle' : s), 2000);
      }
    } else {
      setSavingState('saved');
      setTimeout(() => setSavingState((s) => s === 'saved' ? 'idle' : s), 2000);
    }

    return true;
  }, [persistQueries]);

  // Delete a query by id — optimistic UI + API call
  const deleteQuery = useCallback(async (id) => {
    // Optimistic UI update + cache write
    setQueries((prev) => {
      const result = prev.filter((q) => q.id !== id);
      persistQueries(result);
      return result;
    });

    // Async API call
    if (apiAvailableRef.current) {
      try {
        await StorageAdapter.deleteQuery(id);
      } catch {
        apiAvailableRef.current = false;
        // Data is safe in cache; will sync when API returns
      }
    }

    return true;
  }, [persistQueries]);

  // Get query by id
  const getQuery = useCallback((id) => {
    return queriesRef.current.find((q) => q.id === id) || null;
  }, []);

  // Import with deduplication — FIXES Finding 5, Finding 9: validates + strips unexpected fields
  const importQueries = useCallback(async (jsonString) => {
    const report = { added: 0, skipped: 0, duplicateBody: 0, errors: 0, details: [] };

    const parsed = safeJsonParse(jsonString);
    if (!parsed.ok) {
      report.errors = 1;
      report.details.push({ error: 'Invalid JSON: ' + parsed.error });
      return report;
    }

    let incoming = parsed.data;

    // Handle both blob format and raw array
    if (incoming && typeof incoming === 'object' && !Array.isArray(incoming) && Array.isArray(incoming.queries)) {
      // Run through migration if it's a versioned blob (handles v2->v3 category/table migration)
      const migrated = migrateData(incoming);
      incoming = migrated ? migrated.queries : incoming.queries;
    }

    if (!Array.isArray(incoming)) {
      report.errors = 1;
      report.details.push({ error: 'Expected an array of queries or a data blob with queries array' });
      return report;
    }

    const existingIds = new Set(queriesRef.current.map(q => q.id));
    const existingHashes = new Set(queriesRef.current.map(q => simpleHash(q.query)));
    const now = new Date().toISOString();
    const newQueries = [...queriesRef.current];

    for (let i = 0; i < incoming.length; i++) {
      const raw = incoming[i];

      // Skip if id already exists
      if (raw.id && existingIds.has(raw.id)) {
        report.skipped++;
        report.details.push({ index: i, name: raw.name, status: 'skipped', reason: 'Duplicate ID' });
        continue;
      }

      // Check body hash
      if (raw.query && existingHashes.has(simpleHash(raw.query))) {
        report.duplicateBody++;
        report.details.push({ index: i, name: raw.name, status: 'duplicate_body', reason: 'Duplicate query body' });
        continue;
      }

      // Validate
      const prepared = {
        ...raw,
        id: raw.id || generateId(),
        created: raw.created || now,
        updated: raw.updated || now,
      };
      const validation = validateQuery(prepared);
      if (!validation.sanitized) {
        report.errors++;
        report.details.push({ index: i, name: raw.name, status: 'invalid', reason: validation.errors.join('; ') });
        continue;
      }

      newQueries.push(validation.sanitized);
      existingIds.add(validation.sanitized.id);
      existingHashes.add(simpleHash(validation.sanitized.query));
      report.added++;
      report.details.push({ index: i, name: validation.sanitized.name, status: 'added' });
    }

    setQueries(newQueries);
    persistQueries(newQueries);

    // Bulk import to API
    if (apiAvailableRef.current && report.added > 0) {
      const addedQueries = newQueries.slice(newQueries.length - report.added);
      try {
        await StorageAdapter.importQueries(addedQueries);
      } catch {
        apiAvailableRef.current = false;
        // Data is safe in cache; will sync when API returns
      }
    }

    return report;
  }, [persistQueries]);

  // Export queries as JSON
  const exportQueries = useCallback(() => {
    return JSON.stringify(queriesRef.current, null, 2);
  }, []);

  // Stats
  const stats = useMemo(() => {
    const byCategory = {};
    const byTable = {};
    const byTableGroup = { sentinel: 0, defender: 0, custom: 0 };
    CATEGORIES.forEach(c => { byCategory[c] = 0; });
    queries.forEach(q => {
      byCategory[q.category] = (byCategory[q.category] || 0) + 1;
      const displayName = getTableDisplayName(q.table);
      byTable[displayName] = (byTable[displayName] || 0) + 1;
      byTableGroup[getTableGroup(q.table)]++;
    });
    return {
      total: queries.length,
      byCategory,
      byTable,
      byTableGroup,
      lastUpdated: lastSavedTimestamp,
    };
  }, [queries, lastSavedTimestamp]);

  // Clear all — localStorage cache + API
  const clearAll = useCallback(async () => {
    try {
      StorageAdapter.deleteCachedData();
      setQueries([]);
      setLastSavedTimestamp(null);
      setBackupTimestamp(null);
      setError(null);

      // Delete all from API
      if (apiAvailableRef.current) {
        try {
          const apiQueries = await StorageAdapter.fetchAll();
          await Promise.all(apiQueries.map(q => StorageAdapter.deleteQuery(q.id)));
        } catch {
          apiAvailableRef.current = false;
        }
      }

      return true;
    } catch (e) {
      setError('Failed to clear storage: ' + e.message);
      return false;
    }
  }, []);

  // Health check — reports localStorage + API status
  const healthCheck = useCallback(async () => {
    const result = { ok: true, writable: false, readable: false, dataValid: false, estimatedSizeKB: 0, apiAvailable: false, details: [] };

    // 1. localStorage write test
    try {
      const testValue = JSON.stringify({ test: true, ts: Date.now() });
      await StorageAdapter.set(HEALTH_TEST_KEY, testValue);
      result.writable = true;
      result.details.push('Cache write test: passed');
    } catch (e) {
      result.ok = false;
      result.details.push('Cache write test: FAILED - ' + e.message);
    }

    // 2. localStorage read test
    if (result.writable) {
      try {
        const readBack = await StorageAdapter.get(HEALTH_TEST_KEY);
        if (readBack !== null) {
          result.readable = true;
          result.details.push('Cache read test: passed');
        } else {
          result.ok = false;
          result.details.push('Cache read test: FAILED - got null');
        }
      } catch (e) {
        result.ok = false;
        result.details.push('Cache read test: FAILED - ' + e.message);
      }
    }

    // 3. Delete test key
    try {
      await StorageAdapter.delete(HEALTH_TEST_KEY);
      result.details.push('Cache delete test: passed');
    } catch {
      result.details.push('Cache delete test: FAILED');
    }

    // 4. Cache data validation
    try {
      const mainRaw = await StorageAdapter.get(STORAGE_KEY);
      if (mainRaw !== null) {
        const parsed = safeJsonParse(mainRaw);
        if (parsed.ok && parsed.data && parsed.data.schemaVersion === CURRENT_SCHEMA_VERSION && Array.isArray(parsed.data.queries)) {
          result.dataValid = true;
          result.estimatedSizeKB = Math.round((mainRaw.length * 2) / 1024 * 100) / 100;
          result.details.push('Cache data: valid (v' + parsed.data.schemaVersion + ', ' + parsed.data.queries.length + ' queries, ~' + result.estimatedSizeKB + ' KB)');
        } else {
          result.details.push('Cache data: invalid schema or structure');
        }
      } else {
        result.details.push('Cache data: no data stored yet');
      }
    } catch (e) {
      result.details.push('Cache data: FAILED - ' + e.message);
    }

    // 5. API health check
    try {
      const apiHealth = await StorageAdapter.healthCheck();
      result.apiAvailable = apiHealth.status === 'ok';
      apiAvailableRef.current = result.apiAvailable;
      result.details.push('API: connected (' + apiHealth.queriesCount + ' queries in DB)');
    } catch (e) {
      apiAvailableRef.current = false;
      result.details.push('API: unreachable - ' + e.message);
    }

    return result;
  }, []);

  return {
    queries,
    setQueries,
    isLoading,
    error,
    setError,
    saveQuery,
    deleteQuery,
    getQuery,
    importQueries,
    exportQueries,
    stats,
    clearAll,
    healthCheck,
    persistQueries,
    savingState,
    lastSavedTimestamp,
    backupTimestamp,
    reload: loadData,
  };
}

// ============================================================
// KQL Syntax Highlighter
// (HTML-escaped input, placeholder-based to prevent double-matching)
// The highlightKQL function escapes all HTML entities (& < >)
// BEFORE inserting styled <span> tags with hardcoded inline
// color values only. This prevents any script injection.
// ============================================================
function highlightKQL(code) {
  if (!code || typeof code !== 'string') return '';

  const placeholders = [];
  const ph = (html) => { const i = placeholders.length; placeholders.push(html); return `__PH${i}__`; };
  const span = (color, text, bold) =>
    `<span style="color:${color}${bold ? ';font-weight:bold' : ''}">${text}</span>`;

  // Escape HTML entities first to prevent injection
  let r = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Comments
  r = r.replace(/\/\/.*$/gm, (m) => ph(span('#5c6370', m)));
  // Strings (double then single quoted, escaped quotes handled)
  r = r.replace(/"(?:[^"\\]|\\.)*"/g, (m) => ph(span('#98c379', m)));
  r = r.replace(/'(?:[^'\\]|\\.)*'/g, (m) => ph(span('#98c379', m)));
  // Pipe operator at line starts
  r = r.replace(/^([ \t]*)(\|)/gm, (_, ws, pipe) => ws + ph(span('#00ff88', pipe, true)));

  // Table names (longest first)
  const tables = [
    'DeviceTvmSoftwareVulnerabilities','DeviceTvmSoftwareInventory','ThreatIntelligenceIndicator',
    'AADSpnSignInEventsBeta','DeviceImageLoadEvents','DeviceRegistryEvents','IdentityLogonEvents',
    'IdentityQueryEvents','IdentityDirectoryEvents','DeviceProcessEvents','DeviceNetworkEvents',
    'AADSignInEventsBeta','EmailAttachmentInfo','EmailPostDeliveryEvents','DeviceLogonEvents',
    'CommonSecurityLog','BehaviorEntities','BehaviorInfo','AzureDiagnostics',
    'DeviceFileEvents','CloudAppEvents','UrlClickEvents','SecurityAlert','SecurityEvent',
    'SecurityIncident','OfficeActivity','AzureActivity','AlertEvidence','EmailUrlInfo',
    'WindowsFirewall','WindowsEvent','DeviceEvents','EmailEvents','DeviceInfo',
    'SigninLogs','AuditLogs','AlertInfo','Heartbeat','DnsEvents','W3CIISLog','Usage','Syslog',
  ];
  r = r.replace(new RegExp('\\b(' + tables.join('|') + ')\\b', 'g'), (m) => ph(span('#e5c07b', m)));

  // Multi-word keywords
  const multiKw = [
    'matches\\s+regex','order\\s+by','sort\\s+by','has_any','has_all','mv-expand','mv-apply',
    'make-series','make_set','make_list','arg_max','arg_min','pack_all','replace_string',
  ];
  r = r.replace(new RegExp('\\b(' + multiKw.join('|') + ')\\b', 'gi'), (m) => ph(span('#c678dd', m)));

  // Functions (word + opening paren)
  const fns = [
    'base64_decode_tostring','geo_distance_2points','geo_point_to_geohash','bag_remove_keys',
    'format_datetime','format_timespan','array_sort_asc','datetime_diff','ingestion_time',
    'array_length','array_concat','parse_urlquery','hash_sha256','replace_string','dcount_hll',
    'isnotempty','row_number','pack_array','trim_start','todatetime','totimespan','todynamic',
    'url_decode','parse_json','parse_path','parse_url','parse_csv','parse_xml','bag_merge',
    'hll_merge','trim_end','bag_keys','make_set','make_list','make_bag','percentile','substring',
    'todouble','isempty','tostring','toupper','tolower','replace','extract','treepath','coalesce',
    'ceiling','indexof','countof','variance','toreal','tolong','toint','round','floor','strlen',
    'strcat','split','dcount','count','stdev','sqrt','trim','prev','next','case','pack','range',
    'repeat','zip','sum','avg','min','max','iff','pow','log','now','ago','hll',
  ];
  r = r.replace(new RegExp('\\b(' + fns.join('|') + ')(\\s*\\()', 'g'), (_, fn, p) => ph(span('#61afef', fn)) + p);

  // Single keywords
  const kws = [
    'summarize','materialize','startswith','getschema','serialize','endswith','contains','datetime',
    'evaluate','toscalar','datatable','distinct','timespan','between','dynamic','project','typeof',
    'invoke','lookup','extend','render','search','where','union','count','print','parse','join',
    'take','kind','find','desc','asc','top','let','bin','set','has','not','and','now','ago',
    'on','as','by','in','or',
  ];
  r = r.replace(/!in\b/g, (m) => ph(span('#c678dd', m)));
  r = r.replace(/!has\b/g, (m) => ph(span('#c678dd', m)));
  r = r.replace(new RegExp('\\b(' + kws.join('|') + ')\\b', 'g'), (m) => ph(span('#c678dd', m)));

  // Comparison operators (using escaped HTML entities for < >)
  r = r.replace(/[!=]=~?|[!=]~|&lt;=?|&gt;=?|&amp;&amp;|\|\|/g, (m) => ph(span('#56b6c2', m)));
  // Time literals
  r = r.replace(/\b(\d+(?:\.\d+)?)(d|h|m|s|ms|tick)\b/g, (m) => ph(span('#d19a66', m)));
  // Numbers
  r = r.replace(/\b\d+(?:\.\d+)?\b/g, (m) => ph(span('#d19a66', m)));

  // Restore placeholders in reverse order
  for (let i = placeholders.length - 1; i >= 0; i--) {
    r = r.replace(`__PH${i}__`, placeholders[i]);
  }
  return r;
}


// ============================================================
// Hooks
// ============================================================
function useDebounce(value, delay) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// ============================================================
// Toast Context
// ============================================================
const ToastContext = createContext();
const useToast = () => useContext(ToastContext);

// ============================================================
// Sanitized HTML renderer
// Safe because highlightKQL escapes all HTML entities before
// inserting styled spans with hardcoded color values only.
// ============================================================
function HighlightedCode({ code, className = '', style }) {
  const html = useMemo(() => highlightKQL(code), [code]);
  return React.createElement('pre', {
    className, style,
    dangerouslySetInnerHTML: { __html: html },
  });
}

// ============================================================
// Storage Inspector Component
// ============================================================
function StorageInspector({ visible, onClose, storage, onForceBackup, onHealthCheck, onPurge }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [ops, setOps] = useState([]);
  const [healthResult, setHealthResult] = useState(null);
  const [healthRunning, setHealthRunning] = useState(false);
  const [rawDataKey, setRawDataKey] = useState(null);
  const [rawData, setRawData] = useState(null);
  const [rawDataLoading, setRawDataLoading] = useState(false);
  const [purgeConfirm, setPurgeConfirm] = useState('');
  const [keyList, setKeyList] = useState([]);
  const [keySizes, setKeySizes] = useState({});

  // Refresh operation log periodically when visible
  useEffect(() => {
    if (!visible) return;
    const refresh = () => setOps(operationLog.getAll());
    refresh();
    const iv = setInterval(refresh, 1000);
    return () => clearInterval(iv);
  }, [visible]);

  // Load key list when visible
  useEffect(() => {
    if (!visible) return;
    (async () => {
      try {
        const keys = await StorageAdapter.list('kql-store:');
        setKeyList(keys);
        const sizes = {};
        for (const k of keys) {
          try {
            const val = await StorageAdapter.get(k);
            sizes[k] = val ? Math.round((val.length * 2) / 1024 * 100) / 100 : 0;
          } catch {
            sizes[k] = -1;
          }
        }
        setKeySizes(sizes);
      } catch {
        setKeyList([]);
      }
    })();
  }, [visible, storage.lastSavedTimestamp]);

  const handleViewKey = async (key) => {
    setRawDataKey(key);
    setRawDataLoading(true);
    try {
      const val = await StorageAdapter.get(key);
      if (val) {
        const parsed = safeJsonParse(val);
        setRawData(parsed.ok ? JSON.stringify(parsed.data, null, 2) : val);
      } else {
        setRawData('(empty)');
      }
    } catch (e) {
      setRawData('Error reading key: ' + e.message);
    }
    setRawDataLoading(false);
  };

  const handleHealthCheck = async () => {
    setHealthRunning(true);
    const result = await onHealthCheck();
    setHealthResult(result);
    setHealthRunning(false);
  };

  const handlePurge = async () => {
    if (purgeConfirm !== 'DELETE') return;
    await onPurge();
    setPurgeConfirm('');
    setRawDataKey(null);
    setRawData(null);
  };

  if (!visible) return null;

  const totalSizeKB = Object.values(keySizes).reduce((sum, s) => sum + (s > 0 ? s : 0), 0);
  const maxSizeKB = 5120;

  const tabStyle = (active) => ({
    background: active ? '#1a1a2e' : 'transparent',
    color: active ? '#00ff88' : '#666',
    border: active ? '1px solid #2a2a3e' : '1px solid transparent',
    borderBottom: active ? '1px solid #0d0d14' : '1px solid #2a2a3e',
  });

  return (
    <div className="fixed bottom-0 left-0 right-0 z-[70] font-mono text-xs" style={{ maxHeight: '50vh' }}>
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2" style={{ background: '#0d0d14', borderTop: '2px solid #00ff88', borderBottom: '1px solid #2a2a3e' }}>
        <div className="flex items-center gap-3">
          <Database size={14} style={{ color: '#00ff88' }} />
          <span style={{ color: '#00ff88' }} className="font-bold">Storage Inspector</span>
          <span className="text-gray-600">|</span>
          {/* Tabs */}
          {['overview', 'keys', 'operations', 'data', 'danger'].map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className="px-3 py-1 rounded-t text-xs capitalize" style={tabStyle(activeTab === tab)}>{tab}</button>
          ))}
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-white/10"><X size={14} className="text-gray-400" /></button>
      </div>

      {/* Content */}
      <div className="overflow-y-auto p-4" style={{ background: '#0d0d14', maxHeight: 'calc(50vh - 44px)' }}>

        {/* Overview Tab */}
        {activeTab === 'overview' && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="rounded-lg p-3" style={{ background: '#12121a', border: '1px solid #1e1e2e' }}>
              <div className="text-gray-500 mb-1">Status</div>
              <div style={{ color: storage.error ? '#ff4444' : '#00ff88' }} className="font-bold">
                {storage.error ? 'Error' : storage.isLoading ? 'Loading...' : 'Healthy'}
              </div>
              {storage.error && <div className="text-gray-600 mt-1 truncate" title={storage.error}>{storage.error}</div>}
            </div>
            <div className="rounded-lg p-3" style={{ background: '#12121a', border: '1px solid #1e1e2e' }}>
              <div className="text-gray-500 mb-1">Queries</div>
              <div className="text-gray-200 font-bold">{storage.stats.total}</div>
              <div className="text-gray-600">Schema v{CURRENT_SCHEMA_VERSION}</div>
            </div>
            <div className="rounded-lg p-3" style={{ background: '#12121a', border: '1px solid #1e1e2e' }}>
              <div className="text-gray-500 mb-1">Storage Used</div>
              <div className="text-gray-200 font-bold">{totalSizeKB.toFixed(1)} KB</div>
              <div className="text-gray-600">/ {maxSizeKB} KB ({(totalSizeKB / maxSizeKB * 100).toFixed(1)}%)</div>
              <div className="mt-1 h-1 rounded-full overflow-hidden" style={{ background: '#1a1a2e' }}>
                <div className="h-full rounded-full" style={{ width: Math.min(100, totalSizeKB / maxSizeKB * 100) + '%', background: totalSizeKB / maxSizeKB > 0.8 ? '#ff4444' : '#00ff88' }} />
              </div>
            </div>
            <div className="rounded-lg p-3" style={{ background: '#12121a', border: '1px solid #1e1e2e' }}>
              <div className="text-gray-500 mb-1">Last Saved</div>
              <div className="text-gray-200">{storage.lastSavedTimestamp ? new Date(storage.lastSavedTimestamp).toLocaleTimeString() : 'Never'}</div>
              <div className="text-gray-500 mt-1">Backup</div>
              <div className="text-gray-200">{storage.backupTimestamp ? new Date(storage.backupTimestamp).toLocaleTimeString() : 'Never'}</div>
            </div>
          </div>
        )}

        {/* Keys Tab */}
        {activeTab === 'keys' && (
          <div className="space-y-2">
            {keyList.length === 0 ? (
              <div className="text-gray-500 text-center py-4">No storage keys found</div>
            ) : keyList.map(k => (
              <div key={k} className="flex items-center justify-between px-3 py-2 rounded-lg"
                style={{ background: '#12121a', border: '1px solid #1e1e2e' }}>
                <div className="flex items-center gap-3">
                  <span style={{ color: '#00d4ff' }}>{k}</span>
                  <span className="text-gray-600">{keySizes[k] >= 0 ? keySizes[k].toFixed(1) + ' KB' : 'Error'}</span>
                </div>
                <button onClick={() => { setActiveTab('data'); handleViewKey(k); }}
                  className="px-2 py-1 rounded text-xs" style={{ color: '#00d4ff', border: '1px solid #2a2a3e' }}>
                  <Eye size={12} className="inline mr-1" />View
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Operations Tab */}
        {activeTab === 'operations' && (
          <div className="space-y-1">
            {ops.length === 0 ? (
              <div className="text-gray-500 text-center py-4">No operations logged yet</div>
            ) : [...ops].reverse().map((op, i) => {
              const color = !op.success ? '#ff4444' : op.latencyMs > 200 ? '#ffcc00' : '#00ff88';
              return (
                <div key={i} className="flex items-center gap-3 px-3 py-1.5 rounded" style={{ background: '#12121a' }}>
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                  <span className="text-gray-600 w-20 shrink-0">{new Date(op.timestamp).toLocaleTimeString()}</span>
                  <span className="w-12 shrink-0 font-bold" style={{ color }}>{op.type}</span>
                  <span className="text-gray-400 flex-1 truncate">{op.key}</span>
                  <span className="text-gray-500 w-16 text-right shrink-0">{op.latencyMs}ms</span>
                  {op.sizeBytes > 0 && <span className="text-gray-600 w-16 text-right shrink-0">{Math.round(op.sizeBytes / 1024)}KB</span>}
                  {op.error && <span className="text-red-500 truncate max-w-40">{op.error}</span>}
                </div>
              );
            })}
          </div>
        )}

        {/* Data Tab */}
        {activeTab === 'data' && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-gray-500">Key:</span>
              <select className="px-2 py-1 rounded text-xs" style={{ background: '#1a1a2e', border: '1px solid #2a2a3e', color: '#00d4ff' }}
                value={rawDataKey || ''} onChange={(e) => e.target.value && handleViewKey(e.target.value)}>
                <option value="">Select a key...</option>
                {keyList.map(k => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>
            {rawDataLoading && <div className="text-gray-500">Loading...</div>}
            {rawData && !rawDataLoading && (
              <pre className="rounded-lg p-3 overflow-auto max-h-72 text-xs leading-relaxed"
                style={{ background: '#0a0a0f', border: '1px solid #1a1a2e', color: '#98c379' }}>{rawData}</pre>
            )}
          </div>
        )}

        {/* Danger Tab */}
        {activeTab === 'danger' && (
          <div className="space-y-4">
            <div className="rounded-lg p-4" style={{ background: '#1a1010', border: '1px solid #ff444440' }}>
              <h4 className="font-bold mb-3" style={{ color: '#ff4444' }}>
                <AlertTriangle size={14} className="inline mr-2" />Danger Zone
              </h4>
              <div className="space-y-3">
                {/* Purge */}
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <div className="text-gray-300 mb-1">Purge All Storage</div>
                    <div className="text-gray-600">Type DELETE to confirm</div>
                    <input className="mt-1 px-2 py-1 rounded text-xs w-32"
                      style={{ background: '#12121a', border: '1px solid #2a2a3e', color: '#ff4444' }}
                      value={purgeConfirm} onChange={(e) => setPurgeConfirm(e.target.value)} placeholder="Type DELETE" />
                  </div>
                  <button onClick={handlePurge} disabled={purgeConfirm !== 'DELETE'}
                    className="px-4 py-2 rounded-lg text-xs font-bold disabled:opacity-30"
                    style={{ background: purgeConfirm === 'DELETE' ? '#ff4444' : '#2a1010', color: '#fff', border: '1px solid #ff4444' }}>
                    Purge
                  </button>
                </div>

                {/* Force Backup */}
                <div className="flex items-center gap-3" style={{ borderTop: '1px solid #2a2a3e', paddingTop: 12 }}>
                  <div className="flex-1">
                    <div className="text-gray-300">Force Backup Now</div>
                    <div className="text-gray-600">Write current data to backup key immediately</div>
                  </div>
                  <button onClick={onForceBackup}
                    className="px-4 py-2 rounded-lg text-xs font-bold"
                    style={{ background: '#102a10', color: '#00ff88', border: '1px solid #00ff88' }}>
                    Backup
                  </button>
                </div>

                {/* Health Check */}
                <div className="flex items-center gap-3" style={{ borderTop: '1px solid #2a2a3e', paddingTop: 12 }}>
                  <div className="flex-1">
                    <div className="text-gray-300">Run Health Check</div>
                    <div className="text-gray-600">Write/read/delete test, validate data schema</div>
                  </div>
                  <button onClick={handleHealthCheck} disabled={healthRunning}
                    className="px-4 py-2 rounded-lg text-xs font-bold"
                    style={{ background: '#101a2a', color: '#00d4ff', border: '1px solid #00d4ff' }}>
                    {healthRunning ? 'Running...' : 'Check'}
                  </button>
                </div>

                {healthResult && (
                  <div className="mt-3 rounded-lg p-3" style={{ background: '#0a0a0f', border: '1px solid #1a1a2e' }}>
                    <div className="flex items-center gap-2 mb-2">
                      <Shield size={14} style={{ color: healthResult.ok ? '#00ff88' : '#ff4444' }} />
                      <span style={{ color: healthResult.ok ? '#00ff88' : '#ff4444' }} className="font-bold">
                        {healthResult.ok ? 'All checks passed' : 'Issues detected'}
                      </span>
                    </div>
                    <div className="space-y-1">
                      {healthResult.details.map((d, i) => (
                        <div key={i} className="text-gray-400">{d}</div>
                      ))}
                    </div>
                    <div className="mt-2 grid grid-cols-4 gap-2 text-center">
                      <div>
                        <div className="text-gray-600">Writable</div>
                        <div style={{ color: healthResult.writable ? '#00ff88' : '#ff4444' }}>{healthResult.writable ? 'Yes' : 'No'}</div>
                      </div>
                      <div>
                        <div className="text-gray-600">Readable</div>
                        <div style={{ color: healthResult.readable ? '#00ff88' : '#ff4444' }}>{healthResult.readable ? 'Yes' : 'No'}</div>
                      </div>
                      <div>
                        <div className="text-gray-600">Data Valid</div>
                        <div style={{ color: healthResult.dataValid ? '#00ff88' : '#ff4444' }}>{healthResult.dataValid ? 'Yes' : 'No'}</div>
                      </div>
                      <div>
                        <div className="text-gray-600">Size</div>
                        <div className="text-gray-300">{healthResult.estimatedSizeKB} KB</div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Table Selector Component
// ============================================================
function TableSelector({ value, onChange }) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = search
    ? ALL_KNOWN_TABLES.filter(t => t.toLowerCase().includes(search.toLowerCase()))
    : ALL_KNOWN_TABLES;

  const sentinelFiltered = filtered.filter(t => SENTINEL_TABLES.includes(t));
  const defenderFiltered = filtered.filter(t => DEFENDER_TABLES.includes(t));

  const displayValue = value ? getTableDisplayName(value) : 'Select table...';

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(p => !p)}
        className="w-full px-3 py-2 rounded-lg font-mono text-sm text-left flex items-center justify-between"
        style={{ background: '#1a1a2e', border: '1px solid #2a2a3e', color: value ? '#e0e0e0' : '#666' }}>
        <span className="truncate">{displayValue}</span>
        <ChevronDown size={14} className="text-gray-500 shrink-0" />
      </button>
      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 rounded-lg overflow-hidden z-10 shadow-xl"
          style={{ background: '#1a1a2e', border: '1px solid #2a2a3e', maxHeight: 280, overflowY: 'auto' }}>
          <div className="p-2 sticky top-0" style={{ background: '#1a1a2e' }}>
            <input type="text" placeholder="Search tables..." value={search} onChange={e => setSearch(e.target.value)}
              className="w-full px-2 py-1.5 rounded text-xs font-mono outline-none"
              style={{ background: '#12121a', border: '1px solid #2a2a3e', color: '#e0e0e0' }}
              autoFocus />
          </div>
          {sentinelFiltered.length > 0 && (
            <div>
              <div className="px-3 py-1 text-xs font-bold" style={{ color: '#e5c07b' }}>Sentinel</div>
              {sentinelFiltered.map(t => (
                <button key={t} type="button" onClick={() => { onChange(t); setOpen(false); setSearch(''); }}
                  className="w-full px-3 py-1.5 text-xs text-left hover:bg-white/5"
                  style={{ color: value === t ? '#e5c07b' : '#aaa' }}>{t}</button>
              ))}
            </div>
          )}
          {defenderFiltered.length > 0 && (
            <div>
              <div className="px-3 py-1 text-xs font-bold" style={{ color: '#61afef' }}>Defender</div>
              {defenderFiltered.map(t => (
                <button key={t} type="button" onClick={() => { onChange(t); setOpen(false); setSearch(''); }}
                  className="w-full px-3 py-1.5 text-xs text-left hover:bg-white/5"
                  style={{ color: value === t ? '#61afef' : '#aaa' }}>{t}</button>
              ))}
            </div>
          )}
          <div>
            <div className="px-3 py-1 text-xs font-bold" style={{ color: '#8b8fa3' }}>Custom</div>
            <button type="button" onClick={() => { onChange('Custom'); setOpen(false); setSearch(''); }}
              className="w-full px-3 py-1.5 text-xs text-left hover:bg-white/5"
              style={{ color: value === 'Custom' ? '#8b8fa3' : '#aaa' }}>Custom</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Main Application
// ============================================================
export default function KQLStore() {
  const storage = useKQLStorage();
  const {
    queries, setQueries, isLoading, error: storageError, setError: setStorageError,
    persistQueries, savingState, lastSavedTimestamp, backupTimestamp, stats,
  } = storage;

  const [searchTerm, setSearchTerm] = useState('');
  const debouncedSearch = useDebounce(searchTerm, 250);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [selectedTable, setSelectedTable] = useState(null);
  const [tableFilterExpanded, setTableFilterExpanded] = useState({ sentinel: true, defender: true, custom: true });
  const [selectedTags, setSelectedTags] = useState([]);
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [sortBy, setSortBy] = useState('updated');
  const [sortDir, setSortDir] = useState('desc');
  const [editingQuery, setEditingQuery] = useState(null);
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [showKeyboardHelp, setShowKeyboardHelp] = useState(false);
  const [showMobileSidebar, setShowMobileSidebar] = useState(false);
  const [showInspector, setShowInspector] = useState(false);
  const [importPreview, setImportPreview] = useState(null); // {text, preview} for import preview modal
  const [toasts, setToasts] = useState([]);
  const searchRef = useRef(null);
  const fileInputRef = useRef(null);
  const toastIdRef = useRef(0);

  // --- Toast ---
  const addToast = useCallback((message, type = 'success') => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev.slice(-2), { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3000);
  }, []);

  // Show toasts on storage errors
  useEffect(() => {
    if (storageError) {
      addToast(storageError, 'error');
    }
  }, [storageError, addToast]);

  // --- Storage Operations ---
  const saveQuery = useCallback(async (queryData) => {
    const success = await storage.saveQuery(queryData);
    if (success) {
      addToast(queryData.id ? 'Query updated' : 'Query saved', 'success');
    } else {
      addToast('Failed to save query', 'error');
    }
  }, [storage, addToast]);

  const deleteQuery = useCallback(async (id) => {
    const success = await storage.deleteQuery(id);
    if (success) {
      setSelectedIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
      addToast('Query deleted', 'info');
    } else {
      addToast('Failed to delete query', 'error');
    }
  }, [storage, addToast]);

  const toggleFavorite = useCallback((id) => {
    setQueries((prev) => {
      const updated = prev.map((q) => q.id === id ? { ...q, favorite: !q.favorite } : q);
      persistQueries(updated);
      return updated;
    });
  }, [setQueries, persistQueries]);

  const incrementUsage = useCallback((id) => {
    setQueries((prev) => {
      const updated = prev.map((q) => q.id === id ? { ...q, usageCount: (q.usageCount || 0) + 1 } : q);
      persistQueries(updated);
      return updated;
    });
  }, [setQueries, persistQueries]);

  const duplicateQuery = useCallback((query) => {
    const now = new Date().toISOString();
    const dup = { ...query, id: generateId(), name: `${query.name} (copy)`, created: now, updated: now, usageCount: 0 };
    setQueries((prev) => {
      const updated = [...prev, dup];
      persistQueries(updated);
      return updated;
    });
    addToast('Query duplicated', 'success');
  }, [setQueries, persistQueries, addToast]);

  // --- Import / Export ---
  const handleExport = useCallback((exportQueries = null) => {
    const data = exportQueries || queries;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kql-store-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    addToast(`Exported ${data.length} queries`, 'success');
  }, [queries, addToast]);

  const handleImport = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      // Parse and preview before committing
      const parsed = safeJsonParse(text);
      if (!parsed.ok) {
        addToast('Failed to import -- invalid JSON: ' + parsed.error, 'error');
        e.target.value = '';
        return;
      }
      let incoming = parsed.data;
      if (incoming && typeof incoming === 'object' && !Array.isArray(incoming) && Array.isArray(incoming.queries)) {
        const migrated = migrateData(incoming);
        incoming = migrated ? migrated.queries : incoming.queries;
      }
      if (!Array.isArray(incoming)) {
        addToast('Failed to import -- expected array of queries', 'error');
        e.target.value = '';
        return;
      }
      // Compute preview
      const existingIds = new Set(queries.map(q => q.id));
      const existingHashes = new Set(queries.map(q => simpleHash(q.query)));
      let willAdd = 0, willSkip = 0, willDuplicate = 0, willError = 0;
      const previewItems = incoming.map((raw, i) => {
        if (raw.id && existingIds.has(raw.id)) {
          willSkip++;
          return { index: i, name: raw.name || '(unnamed)', status: 'skip', reason: 'Duplicate ID' };
        }
        if (raw.query && existingHashes.has(simpleHash(raw.query))) {
          willDuplicate++;
          return { index: i, name: raw.name || '(unnamed)', status: 'duplicate', reason: 'Duplicate query body' };
        }
        const validation = validateQuery({ ...raw, id: raw.id || generateId(), created: raw.created || new Date().toISOString(), updated: raw.updated || new Date().toISOString() });
        if (!validation.sanitized) {
          willError++;
          return { index: i, name: raw.name || '(unnamed)', status: 'error', reason: validation.errors.join('; ') };
        }
        willAdd++;
        return { index: i, name: raw.name || '(unnamed)', status: 'add', reason: null };
      });
      setImportPreview({ text, preview: { items: previewItems, willAdd, willSkip, willDuplicate, willError, total: incoming.length } });
    } catch {
      addToast('Failed to read import file', 'error');
    }
    e.target.value = '';
  }, [queries, addToast]);

  const confirmImport = useCallback(async () => {
    if (!importPreview) return;
    try {
      const report = await storage.importQueries(importPreview.text);
      if (report.errors > 0 && report.added === 0) {
        addToast(`Import failed: ${report.details.map(d => d.error || d.reason).filter(Boolean).join('; ')}`, 'error');
      } else {
        addToast(`Imported ${report.added} new, ${report.skipped} skipped, ${report.duplicateBody} duplicate bodies, ${report.errors} errors`, report.added > 0 ? 'success' : 'info');
      }
    } catch {
      addToast('Failed to import -- unexpected error', 'error');
    }
    setImportPreview(null);
  }, [importPreview, storage, addToast]);

  // --- Bulk Operations ---
  const handleBulkDelete = useCallback(() => {
    setQueries((prev) => {
      const updated = prev.filter((q) => !selectedIds.has(q.id));
      persistQueries(updated);
      return updated;
    });
    addToast(`Deleted ${selectedIds.size} queries`, 'info');
    setSelectedIds(new Set());
  }, [selectedIds, setQueries, persistQueries, addToast]);

  const handleBulkExport = useCallback(() => {
    const selected = queries.filter((q) => selectedIds.has(q.id));
    handleExport(selected);
    setSelectedIds(new Set());
  }, [queries, selectedIds, handleExport]);

  const handleBulkCategory = useCallback((category) => {
    setQueries((prev) => {
      const updated = prev.map((q) => selectedIds.has(q.id) ? { ...q, category, updated: new Date().toISOString() } : q);
      persistQueries(updated);
      return updated;
    });
    addToast(`Moved ${selectedIds.size} queries to ${category}`, 'success');
    setSelectedIds(new Set());
  }, [selectedIds, setQueries, persistQueries, addToast]);

  const handleBulkTable = useCallback((table) => {
    setQueries((prev) => {
      const updated = prev.map((q) => selectedIds.has(q.id) ? { ...q, table, updated: new Date().toISOString() } : q);
      persistQueries(updated);
      return updated;
    });
    addToast(`Set ${selectedIds.size} queries to table ${getTableDisplayName(table)}`, 'success');
    setSelectedIds(new Set());
  }, [selectedIds, setQueries, persistQueries, addToast]);

  // --- Force backup ---
  const handleForceBackup = useCallback(async () => {
    try {
      const blob = JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        queries,
        meta: { lastUpdated: new Date().toISOString(), totalQueries: queries.length },
      });
      await StorageAdapter.set(BACKUP_KEY, blob);
      addToast('Backup created successfully', 'success');
    } catch {
      addToast('Backup failed', 'error');
    }
  }, [queries, addToast]);

  // --- Purge ---
  const handlePurge = useCallback(async () => {
    const success = await storage.clearAll();
    if (success) {
      addToast('All storage purged', 'info');
    } else {
      addToast('Failed to purge storage', 'error');
    }
  }, [storage, addToast]);

  // --- Keyboard Shortcuts ---
  useEffect(() => {
    const handler = (e) => {
      const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT';

      // Storage Inspector toggle: Ctrl/Cmd+Shift+D
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault();
        setShowInspector((p) => !p);
        return;
      }

      if (e.key === '?' && !editingQuery && !inInput) {
        e.preventDefault();
        setShowKeyboardHelp((p) => !p);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'n' && !inInput) {
        e.preventDefault();
        setEditingQuery({});
      }
      if (e.key === 'Escape') {
        if (importPreview) setImportPreview(null);
        else if (showInspector) setShowInspector(false);
        else if (editingQuery) setEditingQuery(null);
        else if (showKeyboardHelp) setShowKeyboardHelp(false);
        else if (searchTerm) { setSearchTerm(''); searchRef.current?.blur(); }
        else if (showMobileSidebar) setShowMobileSidebar(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editingQuery, showKeyboardHelp, searchTerm, showMobileSidebar, showInspector, importPreview]);

  // --- Filtering & Sorting ---
  const allTags = useMemo(() => {
    const counts = {};
    queries.forEach((q) => (q.tags || []).forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15);
  }, [queries]);

  const categoryCounts = useMemo(() => {
    const c = {};
    CATEGORIES.forEach((cat) => { c[cat] = 0; });
    queries.forEach((q) => { c[q.category] = (c[q.category] || 0) + 1; });
    return c;
  }, [queries]);

  const filteredQueries = useMemo(() => {
    let result = queries;
    if (debouncedSearch) {
      const s = debouncedSearch.toLowerCase();
      result = result.filter((q) =>
        q.name.toLowerCase().includes(s) ||
        (q.description || '').toLowerCase().includes(s) ||
        q.query.toLowerCase().includes(s) ||
        (q.tags || []).some((t) => t.toLowerCase().includes(s)) ||
        (q.table || '').toLowerCase().includes(s) ||
        q.category.toLowerCase().includes(s)
      );
    }
    if (selectedCategory) result = result.filter((q) => q.category === selectedCategory);
    if (selectedTable) result = result.filter((q) => q.table === selectedTable);
    if (selectedTags.length > 0) result = result.filter((q) => selectedTags.every((t) => (q.tags || []).includes(t)));
    if (showFavoritesOnly) result = result.filter((q) => q.favorite);
    return [...result].sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'name') cmp = a.name.localeCompare(b.name);
      else if (sortBy === 'created') cmp = (a.created || '').localeCompare(b.created || '');
      else if (sortBy === 'updated') cmp = (a.updated || '').localeCompare(b.updated || '');
      else if (sortBy === 'usageCount') cmp = (a.usageCount || 0) - (b.usageCount || 0);
      else if (sortBy === 'table') cmp = (a.table || '').localeCompare(b.table || '');
      else if (sortBy === 'category') cmp = (a.category || '').localeCompare(b.category || '');
      return sortDir === 'desc' ? -cmp : cmp;
    });
  }, [queries, debouncedSearch, selectedCategory, selectedTable, selectedTags, showFavoritesOnly, sortBy, sortDir]);

  // --- Clipboard ---
  const copyToClipboard = useCallback(async (text, queryId) => {
    try {
      await navigator.clipboard.writeText(text);
      if (queryId) incrementUsage(queryId);
      addToast('Copied to clipboard!', 'success');
    } catch {
      addToast('Failed to copy', 'error');
    }
  }, [incrementUsage, addToast]);

  const toggleExpand = useCallback((id) => {
    setExpandedIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }, []);

  const toggleSelect = useCallback((id) => {
    setSelectedIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }, []);

  const clearFilters = useCallback(() => {
    setSearchTerm(''); setSelectedCategory(null); setSelectedTable(null);
    setSelectedTags([]); setShowFavoritesOnly(false);
  }, []);

  const hasActiveFilters = selectedCategory || selectedTable || selectedTags.length > 0 || showFavoritesOnly || debouncedSearch;

  // ============================================================
  // Sub-Components (defined inside for access to callbacks)
  // ============================================================

  const ToastContainer = () => (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto flex items-center gap-2 px-4 py-2 rounded-lg font-mono text-sm shadow-lg"
          style={{
            background: t.type === 'error' ? '#2a1010' : t.type === 'info' ? '#101a2a' : '#102a10',
            border: `1px solid ${t.type === 'error' ? '#ff4444' : t.type === 'info' ? '#00d4ff' : '#00ff88'}`,
            color: t.type === 'error' ? '#ff4444' : t.type === 'info' ? '#00d4ff' : '#00ff88',
          }}>
          {t.message}
        </div>
      ))}
    </div>
  );

  const KeyboardHelp = () => {
    if (!showKeyboardHelp) return null;
    const shortcuts = [
      ['Ctrl/Cmd + K', 'Focus search'],
      ['Ctrl/Cmd + N', 'New query'],
      ['Ctrl/Cmd + Shift + D', 'Storage inspector'],
      ['Escape', 'Close modal / clear search'],
      ['?', 'Toggle this help'],
    ];
    return (
      <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70" onClick={() => setShowKeyboardHelp(false)}>
        <div className="rounded-xl p-6 font-mono w-96" style={{ background: '#12121a', border: '1px solid #2a2a3e' }}
          onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-bold" style={{ color: '#00ff88' }}>
              <Keyboard size={16} className="inline mr-2" />Keyboard Shortcuts
            </h3>
            <button onClick={() => setShowKeyboardHelp(false)} className="p-1 rounded hover:bg-white/10"><X size={16} className="text-gray-400" /></button>
          </div>
          <div className="space-y-3">
            {shortcuts.map(([key, desc]) => (
              <div key={key} className="flex justify-between items-center">
                <kbd className="px-2 py-1 rounded text-xs" style={{ background: '#1a1a2e', border: '1px solid #2a2a3e', color: '#00d4ff' }}>{key}</kbd>
                <span className="text-gray-400 text-sm">{desc}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  // --- Query Editor Modal ---
  const QueryEditorModal = () => {
    if (!editingQuery) return null;
    const isNew = !editingQuery.id;
    const [form, setForm] = useState({
      name: editingQuery.name || '',
      description: editingQuery.description || '',
      query: editingQuery.query || '',
      category: editingQuery.category || 'Utility',
      table: editingQuery.table || 'Custom',
      tags: (editingQuery.tags || []).join(', '),
    });
    const [errors, setErrors] = useState({});
    const taRef = useRef(null);

    const handleTabKey = (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = e.target.selectionStart, end = e.target.selectionEnd;
        const val = form.query;
        setForm((p) => ({ ...p, query: val.substring(0, s) + '    ' + val.substring(end) }));
        requestAnimationFrame(() => { if (taRef.current) { taRef.current.selectionStart = taRef.current.selectionEnd = s + 4; } });
      }
    };

    const handleSave = () => {
      const errs = {};
      if (!form.name.trim()) errs.name = 'Required';
      if (!form.query.trim()) errs.query = 'Required';
      if (Object.keys(errs).length > 0) { setErrors(errs); return; }
      const tags = form.tags.split(',').map((t) => t.trim()).filter(Boolean);
      saveQuery({
        ...(isNew ? {} : editingQuery),
        name: form.name.trim(), description: form.description.trim(), query: form.query,
        category: form.category, table: form.table, tags,
        favorite: editingQuery.favorite || false, usageCount: editingQuery.usageCount || 0,
      });
      setEditingQuery(null);
    };

    const isModified = editingQuery.query && form.query !== editingQuery.query;
    const inputCls = "w-full px-3 py-2 rounded-lg font-mono text-sm text-gray-200 outline-none focus:ring-1 focus:ring-[#00ff88]";
    const inputSty = { background: '#1a1a2e', border: '1px solid #2a2a3e' };

    return (
      <div className="fixed inset-0 z-[80] flex items-start justify-center pt-8 pb-8 overflow-y-auto bg-black/70" onClick={() => setEditingQuery(null)}>
        <div className="rounded-xl p-6 font-mono w-full max-w-2xl mx-4" style={{ background: '#12121a', border: '1px solid #2a2a3e' }}
          onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center mb-5">
            <h3 className="text-lg font-bold" style={{ color: '#00ff88' }}>
              {isNew ? '+ New Query' : 'Edit Query'}
              {isModified && <span className="ml-2 text-xs px-2 py-0.5 rounded" style={{ background: '#2a2010', color: '#ffcc00', border: '1px solid #ffcc00' }}>modified</span>}
            </h3>
            <button onClick={() => setEditingQuery(null)} className="p-1 rounded hover:bg-white/10"><X size={16} className="text-gray-400" /></button>
          </div>
          <div className="space-y-4">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Name *</label>
              <input className={inputCls} style={{ ...inputSty, borderColor: errors.name ? '#ff4444' : '#2a2a3e' }}
                value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="e.g. Suspicious PowerShell Execution" />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Description</label>
              <textarea className={inputCls} style={inputSty} rows={2}
                value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))} placeholder="Brief description..." />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">KQL Query *</label>
              <textarea ref={taRef} className={`${inputCls} leading-relaxed`}
                style={{ ...inputSty, minHeight: 160, borderColor: errors.query ? '#ff4444' : '#2a2a3e' }}
                value={form.query} onChange={(e) => setForm((p) => ({ ...p, query: e.target.value }))}
                onKeyDown={handleTabKey} placeholder={"DeviceProcessEvents\n| where Timestamp > ago(7d)\n| ..."} spellCheck={false} />
            </div>
            {form.query && (
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Preview</label>
                <HighlightedCode code={form.query} className="rounded-lg p-3 text-xs overflow-x-auto leading-relaxed max-h-40 overflow-y-auto"
                  style={{ background: '#0a0a0f', border: '1px solid #1a1a2e' }} />
              </div>
            )}
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Category</label>
              <div className="flex flex-wrap gap-2">
                {CATEGORIES.map(c => {
                  const colors = CATEGORY_COLORS[c];
                  const isActive = form.category === c;
                  return (
                    <button key={c} type="button"
                      onClick={() => setForm(p => ({ ...p, category: c }))}
                      className="px-3 py-1.5 rounded-lg text-xs font-mono transition-all"
                      style={{
                        background: isActive ? colors.bg : 'transparent',
                        color: isActive ? colors.text : '#666',
                        border: `1px solid ${isActive ? colors.border : '#2a2a3e'}`,
                      }}>{c}</button>
                  );
                })}
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Table</label>
              <TableSelector value={form.table} onChange={(t) => setForm(p => ({ ...p, table: t }))} />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Tags (comma-separated)</label>
              <input className={inputCls} style={inputSty} value={form.tags}
                onChange={(e) => setForm((p) => ({ ...p, tags: e.target.value }))} placeholder="powershell, lolbins, t1059" />
            </div>
          </div>
          <div className="flex justify-end gap-3 mt-6">
            <button onClick={() => setEditingQuery(null)}
              className="px-4 py-2 rounded-lg text-sm font-mono text-gray-400 hover:text-gray-200 hover:bg-white/5"
              style={{ border: '1px solid #2a2a3e' }}>Cancel</button>
            <button onClick={handleSave} className="px-4 py-2 rounded-lg text-sm font-mono font-bold"
              style={{ background: '#00ff88', color: '#0a0a0f' }}>
              {isNew ? 'Save Query' : 'Update Query'}
            </button>
          </div>
        </div>
      </div>
    );
  };

  // --- Code Block with line numbers, expand/collapse, copy ---
  const CodeBlock = React.memo(({ query, queryId }) => {
    const lines = query.split('\n');
    const isLong = lines.length > 6;
    const [expanded, setExpanded] = useState(false);
    const displayCode = isLong && !expanded ? lines.slice(0, 6).join('\n') : query;
    const displayLineCount = isLong && !expanded ? 6 : lines.length;
    const [copied, setCopied] = useState(false);

    const handleCopy = async (e) => {
      e.stopPropagation();
      await copyToClipboard(query, queryId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };

    return (
      <div className="relative group rounded-lg overflow-hidden" style={{ background: '#0a0a0f', border: '1px solid #1a1a2e' }}>
        <button onClick={handleCopy}
          className="absolute top-2 right-2 p-1.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity z-10"
          style={{ background: '#1a1a2e', border: '1px solid #2a2a3e' }} title="Copy query">
          {copied ? <Check size={14} style={{ color: '#00ff88' }} /> : <Copy size={14} className="text-gray-400" />}
        </button>
        <div className="flex text-xs overflow-x-auto">
          <div className="select-none text-right pr-3 pl-3 py-3 leading-relaxed shrink-0" style={{ color: '#3a3a4e', minWidth: 36 }}>
            {Array.from({ length: displayLineCount }, (_, i) => <div key={i}>{i + 1}</div>)}
          </div>
          <HighlightedCode code={displayCode} className="py-3 pr-4 leading-relaxed flex-1 min-w-0 overflow-x-auto" />
        </div>
        {isLong && (
          <button onClick={(e) => { e.stopPropagation(); setExpanded((p) => !p); }}
            className="w-full py-1.5 text-xs font-mono flex items-center justify-center gap-1 hover:bg-white/5 transition-colors"
            style={{ color: '#00d4ff', borderTop: '1px solid #1a1a2e' }}>
            {expanded ? <><ChevronUp size={12} />Show less</> : <><ChevronDown size={12} />Show more ({lines.length - 6} lines)</>}
          </button>
        )}
      </div>
    );
  });

  // --- Query Card ---
  const QueryCard = React.memo(({ query }) => {
    const isSelected = selectedIds.has(query.id);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const clickTimer = useRef(null);

    const handleNameClick = () => {
      if (clickTimer.current) {
        clearTimeout(clickTimer.current);
        clickTimer.current = null;
        copyToClipboard(query.query, query.id);
      } else {
        clickTimer.current = setTimeout(() => { clickTimer.current = null; toggleExpand(query.id); }, 250);
      }
    };

    return (
      <div className="rounded-xl overflow-hidden transition-all" style={{ background: '#12121a', border: `1px solid ${isSelected ? '#00d4ff' : '#1e1e2e'}` }}>
        <div className="flex items-start gap-3 p-4 pb-2">
          <button onClick={(e) => { e.stopPropagation(); toggleSelect(query.id); }} className="mt-0.5 shrink-0">
            {isSelected ? <CheckSquare size={16} style={{ color: '#00d4ff' }} /> : <Square size={16} className="text-gray-600 hover:text-gray-400" />}
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-bold text-gray-200 cursor-pointer hover:underline decoration-gray-600 truncate" onClick={handleNameClick} title="Click to expand, double-click to copy">
                {query.name}
              </h3>
              <button onClick={() => toggleFavorite(query.id)} className="shrink-0">
                <Star size={14} fill={query.favorite ? '#ffcc00' : 'none'} style={{ color: query.favorite ? '#ffcc00' : '#3a3a4e' }} />
              </button>
            </div>
            {query.description && <p className="text-xs text-gray-500 mt-1">{query.description}</p>}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={() => copyToClipboard(query.query, query.id)} className="p-1.5 rounded-md hover:bg-white/5" title="Copy"><Copy size={14} className="text-gray-500 hover:text-gray-300" /></button>
            <button onClick={() => setEditingQuery(query)} className="p-1.5 rounded-md hover:bg-white/5" title="Edit"><Pencil size={14} className="text-gray-500 hover:text-gray-300" /></button>
            <button onClick={() => duplicateQuery(query)} className="p-1.5 rounded-md hover:bg-white/5" title="Duplicate"><Layers size={14} className="text-gray-500 hover:text-gray-300" /></button>
            {confirmDelete ? (
              <div className="flex items-center gap-1">
                <button onClick={() => { deleteQuery(query.id); setConfirmDelete(false); }}
                  className="px-2 py-1 rounded text-xs font-mono" style={{ background: '#2a1010', color: '#ff4444', border: '1px solid #ff4444' }}>Delete</button>
                <button onClick={() => setConfirmDelete(false)} className="px-2 py-1 rounded text-xs font-mono text-gray-400 hover:text-gray-200">Cancel</button>
              </div>
            ) : (
              <button onClick={() => setConfirmDelete(true)} className="p-1.5 rounded-md hover:bg-white/5" title="Delete"><Trash2 size={14} className="text-gray-500 hover:text-red-400" /></button>
            )}
          </div>
        </div>
        <div className="px-4 pb-3"><CodeBlock query={query.query} queryId={query.id} /></div>
        <div className="px-4 pb-3 flex flex-wrap items-center gap-2 text-xs">
          {(query.tags || []).map((t) => (
            <button key={t} onClick={() => setSelectedTags((prev) => prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t])}
              className="px-2 py-0.5 rounded-full font-mono" style={{
                background: selectedTags.includes(t) ? '#00d4ff20' : '#1a1a2e',
                color: selectedTags.includes(t) ? '#00d4ff' : '#888',
                border: `1px solid ${selectedTags.includes(t) ? '#00d4ff' : '#2a2a3e'}`,
              }}>{t}</button>
          ))}
          <span className="ml-auto flex items-center gap-3 text-gray-600 flex-wrap">
            {query.table && (() => {
              const group = getTableGroup(query.table);
              const style = TABLE_STYLES[group];
              return (
                <span className="px-2 py-0.5 rounded font-mono text-xs" style={{ background: style.bg, color: style.text, border: `1px solid ${style.border}` }}>
                  {getTableDisplayName(query.table)}
                </span>
              );
            })()}
            {(() => {
              const catColors = CATEGORY_COLORS[query.category];
              return catColors ? (
                <span className="px-2 py-0.5 rounded font-mono text-xs" style={{ background: catColors.bg, color: catColors.text, border: `1px solid ${catColors.border}` }}>
                  {query.category}
                </span>
              ) : null;
            })()}
            {query.usageCount > 0 && <span className="flex items-center gap-1"><Copy size={10} />{query.usageCount}</span>}
            <span className="flex items-center gap-1"><Clock size={10} />{new Date(query.updated || query.created).toLocaleDateString()}</span>
          </span>
        </div>
      </div>
    );
  });

  // --- Sidebar ---
  const SidebarContent = () => (
    <div className="flex flex-col h-full overflow-y-auto p-4 space-y-5 font-mono text-sm" style={{ background: '#0d0d14' }}>
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
        <input ref={searchRef} type="text" placeholder="Search queries..."
          className="w-full pl-9 pr-8 py-2 rounded-lg text-sm text-gray-200 outline-none focus:ring-1 focus:ring-[#00ff88]"
          style={{ background: '#1a1a2e', border: '1px solid #2a2a3e' }}
          value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
        {searchTerm && <button onClick={() => setSearchTerm('')} className="absolute right-2 top-1/2 -translate-y-1/2"><X size={14} className="text-gray-500 hover:text-gray-300" /></button>}
      </div>

      <div>
        <h4 className="text-xs text-gray-600 uppercase tracking-wider mb-2">Categories</h4>
        <div className="space-y-0.5">
          {CATEGORIES.map((c) => {
            const colors = CATEGORY_COLORS[c];
            return (
              <button key={c} onClick={() => setSelectedCategory(selectedCategory === c ? null : c)}
                className={`w-full flex justify-between items-center px-3 py-1.5 rounded-md text-left text-xs transition-colors ${selectedCategory === c ? '' : 'hover:bg-white/5'}`}
                style={selectedCategory === c ? { background: colors.bg, color: colors.text } : { color: '#aaa' }}>
                <span className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full" style={{ background: colors.text }} />
                  {c}
                </span>
                <span className="text-gray-600">{categoryCounts[c] || 0}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <h4 className="text-xs text-gray-600 uppercase tracking-wider mb-2">Tables</h4>
        {['sentinel', 'defender', 'custom'].map(group => {
          const groupStyle = TABLE_STYLES[group];
          const groupLabel = group.charAt(0).toUpperCase() + group.slice(1);
          const tables = group === 'sentinel' ? SENTINEL_TABLES : group === 'defender' ? DEFENDER_TABLES : [];
          const customTables = group === 'custom'
            ? [...new Set(queries.filter(q => getTableGroup(q.table) === 'custom').map(q => q.table))]
            : [];
          const tablesToShow = group === 'custom' ? customTables : tables;
          const groupCount = stats.byTableGroup[group] || 0;
          if (groupCount === 0 && group === 'custom') return null;

          return (
            <div key={group} className="mb-2">
              <button onClick={() => setTableFilterExpanded(p => ({ ...p, [group]: !p[group] }))}
                className="w-full flex items-center justify-between px-2 py-1 text-xs rounded hover:bg-white/5"
                style={{ color: groupStyle.text }}>
                <span className="flex items-center gap-1.5">
                  {tableFilterExpanded[group] ? <ChevronDown size={10} /> : <ChevronUp size={10} />}
                  {groupLabel}
                </span>
                <span className="text-gray-600">{groupCount}</span>
              </button>
              {tableFilterExpanded[group] && tablesToShow.length > 0 && (
                <div className="ml-2 space-y-0.5 mt-0.5">
                  {tablesToShow.map(t => {
                    const displayName = getTableDisplayName(t);
                    const count = stats.byTable[displayName] || 0;
                    if (count === 0) return null;
                    return (
                      <button key={t} onClick={() => setSelectedTable(selectedTable === t ? null : t)}
                        className="w-full flex justify-between items-center px-2 py-1 rounded text-xs hover:bg-white/5"
                        style={selectedTable === t ? { background: groupStyle.bg, color: groupStyle.text } : { color: '#888' }}>
                        <span className="truncate">{displayName}</span>
                        <span className="text-gray-600 shrink-0 ml-2">{count}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {allTags.length > 0 && (
        <div>
          <h4 className="text-xs text-gray-600 uppercase tracking-wider mb-2">Tags</h4>
          <div className="flex flex-wrap gap-1.5">
            {allTags.map(([tag]) => (
              <button key={tag} onClick={() => setSelectedTags((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag])}
                className="px-2 py-0.5 rounded-full text-xs transition-colors"
                style={selectedTags.includes(tag)
                  ? { background: '#00d4ff20', color: '#00d4ff', border: '1px solid #00d4ff' }
                  : { background: '#1a1a2e', color: '#777', border: '1px solid #2a2a3e' }}>{tag}</button>
            ))}
          </div>
        </div>
      )}

      <button onClick={() => setShowFavoritesOnly((p) => !p)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs w-full transition-colors"
        style={showFavoritesOnly
          ? { background: '#ffcc0015', color: '#ffcc00', border: '1px solid #ffcc00' }
          : { background: '#1a1a2e', color: '#888', border: '1px solid #2a2a3e' }}>
        <Star size={12} fill={showFavoritesOnly ? '#ffcc00' : 'none'} style={{ color: showFavoritesOnly ? '#ffcc00' : '#888' }} />Favorites only
      </button>

      <div>
        <h4 className="text-xs text-gray-600 uppercase tracking-wider mb-2">Sort by</h4>
        <div className="space-y-0.5">
          {SORT_OPTIONS.map((opt) => (
            <button key={opt.value} onClick={() => {
              if (sortBy === opt.value) setSortDir((p) => p === 'asc' ? 'desc' : 'asc');
              else { setSortBy(opt.value); setSortDir('desc'); }
            }}
              className="w-full flex justify-between items-center px-3 py-1.5 rounded-md text-xs text-left transition-colors"
              style={sortBy === opt.value ? { background: '#1a1a2e', color: '#00ff88' } : { color: '#888' }}>
              <span>{opt.label}</span>
              {sortBy === opt.value && <span className="text-gray-500">{sortDir === 'asc' ? '\u2191' : '\u2193'}</span>}
            </button>
          ))}
        </div>
      </div>

      {hasActiveFilters && (
        <button onClick={clearFilters} className="px-3 py-2 rounded-lg text-xs w-full" style={{ background: '#1a1a2e', color: '#ff4444', border: '1px solid #2a2a3e' }}>
          Clear all filters
        </button>
      )}
    </div>
  );

  // --- Import Preview Modal ---
  const ImportPreviewModal = () => {
    if (!importPreview) return null;
    const { preview } = importPreview;
    const statusColors = { add: '#00ff88', skip: '#888', duplicate: '#ffcc00', error: '#ff4444' };
    const statusLabels = { add: 'New', skip: 'Skip', duplicate: 'Duplicate', error: 'Invalid' };
    return (
      <div className="fixed inset-0 z-[80] flex items-start justify-center pt-8 pb-8 overflow-y-auto bg-black/70" onClick={() => setImportPreview(null)}>
        <div className="rounded-xl p-6 font-mono w-full max-w-xl mx-4" style={{ background: '#12121a', border: '1px solid #2a2a3e' }}
          onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-bold" style={{ color: '#00ff88' }}>Import Preview</h3>
            <button onClick={() => setImportPreview(null)} className="p-1 rounded hover:bg-white/10"><X size={16} className="text-gray-400" /></button>
          </div>
          <div className="flex gap-4 mb-4 text-xs">
            <span style={{ color: '#00ff88' }}>{preview.willAdd} new</span>
            <span style={{ color: '#888' }}>{preview.willSkip} skipped</span>
            <span style={{ color: '#ffcc00' }}>{preview.willDuplicate} duplicates</span>
            <span style={{ color: '#ff4444' }}>{preview.willError} invalid</span>
            <span className="ml-auto text-gray-500">{preview.total} total</span>
          </div>
          <div className="max-h-64 overflow-y-auto space-y-1 mb-4" style={{ background: '#0a0a0f', borderRadius: 8, padding: 8, border: '1px solid #1a1a2e' }}>
            {preview.items.map((item, i) => (
              <div key={i} className="flex items-center gap-2 text-xs py-1 px-2 rounded" style={{ background: i % 2 === 0 ? 'transparent' : '#12121a' }}>
                <span className="w-14 shrink-0 text-right" style={{ color: statusColors[item.status] }}>{statusLabels[item.status]}</span>
                <span className="truncate text-gray-300 flex-1">{item.name}</span>
                {item.reason && <span className="text-gray-600 shrink-0 text-right truncate max-w-40">{item.reason}</span>}
              </div>
            ))}
          </div>
          {preview.willAdd === 0 ? (
            <div className="text-center text-gray-500 text-sm mb-4">No new queries to import.</div>
          ) : null}
          <div className="flex justify-end gap-3">
            <button onClick={() => setImportPreview(null)}
              className="px-4 py-2 rounded-lg text-sm font-mono text-gray-400 hover:text-gray-200 hover:bg-white/5"
              style={{ border: '1px solid #2a2a3e' }}>Cancel</button>
            <button onClick={confirmImport}
              disabled={preview.willAdd === 0}
              className="px-4 py-2 rounded-lg text-sm font-mono font-bold disabled:opacity-40"
              style={{ background: preview.willAdd > 0 ? '#00ff88' : '#333', color: '#0a0a0f' }}>
              Import {preview.willAdd} {preview.willAdd === 1 ? 'Query' : 'Queries'}
            </button>
          </div>
        </div>
      </div>
    );
  };

  // --- Bulk Action Bar ---
  const BulkActionBar = () => {
    if (selectedIds.size === 0) return null;
    const [showCatMenu, setShowCatMenu] = useState(false);
    const [showTableMenu, setShowTableMenu] = useState(false);
    return (
      <div className="fixed bottom-16 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-5 py-3 rounded-xl shadow-2xl font-mono text-sm"
        style={{ background: '#1a1a2e', border: '1px solid #2a2a3e' }}>
        <span style={{ color: '#00d4ff' }}>{selectedIds.size} selected</span>
        <button onClick={handleBulkDelete} className="px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5"
          style={{ background: '#2a1010', color: '#ff4444', border: '1px solid #ff4444' }}><Trash2 size={12} />Delete</button>
        <button onClick={handleBulkExport} className="px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5"
          style={{ background: '#102a10', color: '#00ff88', border: '1px solid #00ff88' }}><Download size={12} />Export</button>
        <div className="relative">
          <button onClick={() => { setShowCatMenu((p) => !p); setShowTableMenu(false); }} className="px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5"
            style={{ background: '#101a2a', color: '#00d4ff', border: '1px solid #00d4ff' }}><Tag size={12} />Category <ChevronDown size={10} /></button>
          {showCatMenu && (
            <div className="absolute bottom-full left-0 mb-2 rounded-lg py-1 shadow-xl min-w-40" style={{ background: '#1a1a2e', border: '1px solid #2a2a3e' }}>
              {CATEGORIES.map((c) => (
                <button key={c} onClick={() => { handleBulkCategory(c); setShowCatMenu(false); }}
                  className="block w-full px-4 py-1.5 text-xs text-left text-gray-400 hover:text-white hover:bg-white/5">{c}</button>
              ))}
            </div>
          )}
        </div>
        <div className="relative">
          <button onClick={() => { setShowTableMenu((p) => !p); setShowCatMenu(false); }} className="px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5"
            style={{ background: '#1a1a20', color: '#e5c07b', border: '1px solid #e5c07b' }}><Database size={12} />Table <ChevronDown size={10} /></button>
          {showTableMenu && (
            <div className="absolute bottom-full left-0 mb-2 rounded-lg py-1 shadow-xl min-w-48 max-h-64 overflow-y-auto" style={{ background: '#1a1a2e', border: '1px solid #2a2a3e' }}>
              <div className="px-3 py-1 text-xs font-bold" style={{ color: '#e5c07b' }}>Sentinel</div>
              {SENTINEL_TABLES.map((t) => (
                <button key={t} onClick={() => { handleBulkTable(t); setShowTableMenu(false); }}
                  className="block w-full px-4 py-1.5 text-xs text-left text-gray-400 hover:text-white hover:bg-white/5">{t}</button>
              ))}
              <div className="px-3 py-1 text-xs font-bold mt-1" style={{ color: '#61afef' }}>Defender</div>
              {DEFENDER_TABLES.map((t) => (
                <button key={t} onClick={() => { handleBulkTable(t); setShowTableMenu(false); }}
                  className="block w-full px-4 py-1.5 text-xs text-left text-gray-400 hover:text-white hover:bg-white/5">{t}</button>
              ))}
              <div className="px-3 py-1 text-xs font-bold mt-1" style={{ color: '#8b8fa3' }}>Custom</div>
              <button onClick={() => { handleBulkTable('Custom'); setShowTableMenu(false); }}
                className="block w-full px-4 py-1.5 text-xs text-left text-gray-400 hover:text-white hover:bg-white/5">Custom</button>
            </div>
          )}
        </div>
        <button onClick={() => setSelectedIds(new Set())} className="p-1.5 rounded-md hover:bg-white/10"><X size={14} className="text-gray-400" /></button>
      </div>
    );
  };

  // --- Saving Indicator ---
  const SavingIndicator = () => {
    if (savingState === 'idle') return null;
    const config = {
      saving: { color: '#ffcc00', text: 'saving...' },
      saved: { color: '#00ff88', text: 'saved' },
      error: { color: '#ff4444', text: 'save failed' },
    };
    const c = config[savingState] || config.saved;
    return (
      <span className="flex items-center gap-1.5 text-xs" style={{ color: c.color }}>
        {savingState === 'saving' && <Zap size={10} className="animate-pulse" />}
        {savingState === 'saved' && <Check size={10} />}
        {savingState === 'error' && <AlertTriangle size={10} />}
        {c.text}
      </span>
    );
  };

  // --- Loading ---
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen font-mono" style={{ background: '#0a0a0f' }}>
        <div className="text-center space-y-4">
          <Terminal size={40} style={{ color: '#00ff88' }} className="mx-auto animate-pulse" />
          <div className="text-gray-400 text-sm">Loading KQL Store...</div>
          <div className="space-y-2 max-w-md mx-auto">
            {[1, 2, 3].map(i => (
              <div key={i} className="rounded-lg h-20 animate-pulse" style={{ background: '#12121a', opacity: 1 - i * 0.2 }} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ============================================================
  // Main Render
  // ============================================================
  return (
    <ToastContext.Provider value={{ addToast }}>
      <div className="flex h-screen font-mono overflow-hidden" style={{ background: '#0a0a0f', color: '#e0e0e0' }}>
        <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleImport} />

        {/* Mobile sidebar overlay */}
        {showMobileSidebar && (
          <div className="fixed inset-0 z-50 lg:hidden flex">
            <div className="absolute inset-0 bg-black/60" onClick={() => setShowMobileSidebar(false)} />
            <div className="relative w-72 h-full shadow-2xl" style={{ background: '#0d0d14' }}>
              <button onClick={() => setShowMobileSidebar(false)} className="absolute top-3 right-3 p-1 rounded hover:bg-white/10 z-10">
                <X size={16} className="text-gray-400" />
              </button>
              <SidebarContent />
            </div>
          </div>
        )}

        {/* Desktop sidebar */}
        <aside className="hidden lg:block w-72 shrink-0 h-full overflow-hidden" style={{ borderRight: '1px solid #1e1e2e' }}>
          <SidebarContent />
        </aside>

        {/* Main content */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Header */}
          <header className="flex items-center justify-between px-4 py-3 shrink-0" style={{ borderBottom: '1px solid #1e1e2e', background: '#0d0d14' }}>
            <div className="flex items-center gap-3">
              <button onClick={() => setShowMobileSidebar(true)} className="lg:hidden p-1.5 rounded-md hover:bg-white/5">
                <Filter size={16} className="text-gray-400" />
              </button>
              <h1 className="text-lg font-bold tracking-tight">
                <span style={{ color: '#00ff88' }}>&gt;</span> <span className="text-gray-200">kql_store</span>
              </h1>
              <span className="hidden sm:inline px-2 py-0.5 rounded-full text-xs"
                style={{ background: '#1a1a2e', color: '#00d4ff', border: '1px solid #2a2a3e' }}>{queries.length} queries</span>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setEditingQuery({})} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold"
                style={{ background: '#00ff88', color: '#0a0a0f' }}><Plus size={14} /><span className="hidden sm:inline">New Query</span></button>
              <button onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs hover:bg-white/5"
                style={{ border: '1px solid #2a2a3e', color: '#aaa' }}><Upload size={14} /><span className="hidden sm:inline">Import</span></button>
              <button onClick={() => handleExport()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs hover:bg-white/5"
                style={{ border: '1px solid #2a2a3e', color: '#aaa' }}><Download size={14} /><span className="hidden sm:inline">Export</span></button>
              <button onClick={() => setShowKeyboardHelp(true)} className="p-1.5 rounded-md hover:bg-white/5 hidden sm:block" title="Keyboard shortcuts (?)">
                <Keyboard size={14} className="text-gray-500" />
              </button>
            </div>
          </header>

          {/* Storage error banner */}
          {storageError && (
            <div className="px-4 py-2 flex items-center justify-between text-xs" style={{ background: '#2a1010', borderBottom: '1px solid #ff444440' }}>
              <span style={{ color: '#ff4444' }}>
                <AlertTriangle size={12} className="inline mr-2" />
                {storageError}
              </span>
              <div className="flex gap-2">
                <button onClick={() => storage.reload()} className="px-2 py-1 rounded text-xs" style={{ color: '#00d4ff', border: '1px solid #2a2a3e' }}>Retry</button>
                <button onClick={() => setStorageError(null)} className="px-2 py-1 rounded text-xs text-gray-500 hover:text-gray-300">Dismiss</button>
              </div>
            </div>
          )}

          {/* Query list */}
          <div className="flex-1 overflow-y-auto p-4" style={{ paddingBottom: showInspector ? 'calc(50vh + 16px)' : undefined }}>
            {filteredQueries.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64 text-center">
                {queries.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-64 text-center">
                    <Terminal size={40} className="text-gray-700 mb-4" />
                    <p className="text-gray-500 text-sm mb-2">No queries yet.</p>
                    <p className="text-gray-600 text-xs mb-4">Create your first query or import an existing collection.</p>
                    <div className="flex gap-3">
                      <button onClick={() => setEditingQuery({})} className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-bold"
                        style={{ background: '#00ff88', color: '#0a0a0f' }}><Plus size={14} />New Query</button>
                      <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm"
                        style={{ border: '1px solid #2a2a3e', color: '#aaa' }}><Upload size={14} />Import</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <Search size={40} className="text-gray-700 mb-4" />
                    <p className="text-gray-500 text-sm mb-2">No queries match your filters.</p>
                    <button onClick={clearFilters} className="text-xs mt-2" style={{ color: '#00d4ff' }}>Clear filters</button>
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-3 max-w-4xl mx-auto">
                {filteredQueries.map((q) => <QueryCard key={q.id} query={q} />)}
              </div>
            )}
          </div>

          {/* Status bar */}
          <footer className="hidden sm:flex items-center justify-between px-4 py-1.5 text-xs font-mono shrink-0"
            style={{ borderTop: '1px solid #1e1e2e', background: '#0d0d14', color: '#555' }}>
            <div className="flex items-center gap-4">
              <span>{filteredQueries.length} / {queries.length} queries</span>
              {hasActiveFilters && <span style={{ color: '#00d4ff' }}>filtered</span>}
            </div>
            <div className="flex items-center gap-4">
              <SavingIndicator />
              {lastSavedTimestamp && <span>synced {new Date(lastSavedTimestamp).toLocaleTimeString()}</span>}
              <button onClick={() => setShowInspector((p) => !p)} className="hover:text-gray-300 flex items-center gap-1" title="Storage Inspector (Ctrl+Shift+D)">
                <Database size={10} />
                <span>v{CURRENT_SCHEMA_VERSION}</span>
              </button>
            </div>
          </footer>
        </main>

        {/* Overlays */}
        <ToastContainer />
        <KeyboardHelp />
        <QueryEditorModal />
        <ImportPreviewModal />
        <BulkActionBar />

        {/* Storage Inspector */}
        <StorageInspector
          visible={showInspector}
          onClose={() => setShowInspector(false)}
          storage={storage}
          onForceBackup={handleForceBackup}
          onHealthCheck={storage.healthCheck}
          onPurge={handlePurge}
        />
      </div>
    </ToastContext.Provider>
  );
}
