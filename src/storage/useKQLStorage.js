import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  CATEGORIES,
  STORAGE_KEY,
  BACKUP_KEY,
  HEALTH_TEST_KEY,
  CURRENT_SCHEMA_VERSION,
  SAVE_DEBOUNCE_MS,
  BACKUP_THROTTLE_MS,
} from '../constants.js';
import { generateId } from '../lib/id.js';
import { safeJsonParse } from '../lib/json.js';
import { validateQuery } from '../domain/validate.js';
import { migrateData } from '../domain/migrate.js';
import { simpleHash } from '../domain/hash.js';
import { getTableGroup, getTableDisplayName } from '../domain/tables.js';
import { StorageAdapter, API_RETRY_INTERVAL_MS } from './adapter.js';

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

    // Step 2: Fetch from API (source of truth), merging any cache-only queries
    try {
      let apiQueries = await StorageAdapter.fetchAll();
      apiAvailableRef.current = true;

      // Merge: find queries in cache that are missing from API and sync them up
      if (cached && Array.isArray(cached.queries) && cached.queries.length > 0) {
        const apiIds = new Set(apiQueries.map(q => q.id));
        const cacheOnly = cached.queries.filter(q => !apiIds.has(q.id));
        if (cacheOnly.length > 0) {
          try {
            await StorageAdapter.importQueries(cacheOnly);
            // Re-fetch to get the merged state
            apiQueries = await StorageAdapter.fetchAll();
          } catch {
            // Import failed — merge locally instead
            apiQueries = [...apiQueries, ...cacheOnly];
          }
        }
      }

      setQueries(apiQueries);
      setLastSavedTimestamp(new Date().toISOString());
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

    // Decide create-vs-update from the ref, NOT from inside the setQueries updater. React
    // defers updaters to the render phase, so a flag assigned in there is still false when
    // the request below is dispatched — every edit took the create path and POSTed a
    // duplicate primary key, which the API rejects with a 500.
    const isUpdate = queriesRef.current.some((q) => q.id === sanitized.id);

    // Optimistic UI update + cache write
    setQueries((prev) => {
      const idx = prev.findIndex((q) => q.id === sanitized.id);
      let result;
      if (idx >= 0) {
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

    // Async API call — always attempt, regardless of apiAvailableRef
    try {
      if (isUpdate) {
        await StorageAdapter.updateQuery(sanitized.id, sanitized);
      } else {
        await StorageAdapter.createQuery(sanitized);
      }
      apiAvailableRef.current = true;
      setSavingState('saved');
      setError(null);
    } catch {
      apiAvailableRef.current = false;
      setSavingState('error');
      setError('Save failed — stored locally only. Changes may be lost if you clear browser data.');
      return false;
    }
    setTimeout(() => setSavingState((s) => s === 'saved' ? 'idle' : s), 2000);

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

    // Async API call — always attempt
    try {
      await StorageAdapter.deleteQuery(id);
      apiAvailableRef.current = true;
    } catch {
      apiAvailableRef.current = false;
      // Data is safe in cache; will sync when API returns
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
      // Run through migration if it's a versioned blob (v1->v4 category, table and
      // ATT&CK-tag promotion). A file from a newer build is refused rather than silently
      // downgraded, because importing it would strip fields this build does not know about.
      const migrated = migrateData(incoming);
      if (migrated && migrated.tooNew) {
        report.errors = 1;
        report.details.push({
          error: `This file was exported by a newer version of KQL Store (schema v${migrated.schemaVersion}). `
               + 'Upgrade before importing it, or fields would be silently dropped.',
        });
        return report;
      }
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

    // Bulk import to API — always attempt
    if (report.added > 0) {
      const addedQueries = newQueries.slice(newQueries.length - report.added);
      try {
        await StorageAdapter.importQueries(addedQueries);
        apiAvailableRef.current = true;
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

      // Delete all from API — always attempt
      try {
        const apiQueries = await StorageAdapter.fetchAll();
        await Promise.all(apiQueries.map(q => StorageAdapter.deleteQuery(q.id)));
        apiAvailableRef.current = true;
      } catch {
        apiAvailableRef.current = false;
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

export { useKQLStorage };
