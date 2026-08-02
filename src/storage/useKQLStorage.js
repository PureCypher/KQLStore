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
// Import planning — what an incoming file would do to the store
//
// Import used to skip every incoming query whose id already existed, which made a shared
// detection pack a one-shot: you could receive version 1 of a rule and never version 2.
// The API has supported newer-wins upsert all along; what was missing was any way for the
// user to see what an overwrite would change before agreeing to it.
//
// These helpers are pure and exported so the preview modal and the commit path classify
// the same file identically — a preview that disagreed with what the import then did
// would be worse than no preview at all.
// ============================================================

// Fields compared to decide whether an incoming query differs from the stored one, in the
// order they are reported. Deliberately omitted:
//   created/updated — bookkeeping, not content; `updated` is the input to the decision.
//   usageCount      — a local counter the server merges by taking the larger value, so it
//                     can never regress and reporting it would flag every single row.
//
// parentId/parentName ARE included. Re-parenting changes what a query claims to be
// derived from, which is content, and an import that quietly rewrote a fork's ancestry —
// or flattened it to nothing — is precisely the silent overwrite this preview exists to
// stop. parentName earns its place separately: an import from an older export can carry
// a stale snapshot of a parent that has since been renamed, and replacing the label
// without saying so would leave the store disagreeing with itself.
const DIFF_FIELDS = [
  'name', 'query', 'description', 'category', 'table', 'tags', 'favorite',
  'parentId', 'parentName',
  // aiProvenance is content, not bookkeeping: it records what a model authored and the
  // operator accepted, and an import that silently rewrites that trail is exactly the
  // kind of overwrite this preview exists to surface.
  'aiProvenance',
  'queryType', 'severity', 'confidence', 'platform', 'attack', 'dataSources',
  'entityMappings', 'falsePositives', 'references', 'tuningNotes', 'lookback',
  'version', 'lastValidated', 'author', 'license',
];

/**
 * Collapse the several ways of saying "this field is not set" onto one. A v3 record has
 * no `attack` key at all, a v4 record that was opened in the editor and saved may carry
 * `attack: { tactics: [] }`, and neither is a change the user needs to be warned about.
 */
function normaliseForDiff(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (Array.isArray(value)) {
    const out = value.map(normaliseForDiff).filter((v) => v !== undefined);
    return out.length === 0 ? undefined : out;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const v = normaliseForDiff(value[key]);
      if (v !== undefined) out[key] = v;
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }
  return value;
}

/** Structural equality over already-normalised values (key order is fixed by the sort). */
function sameValue(a, b) {
  const na = normaliseForDiff(a);
  const nb = normaliseForDiff(b);
  if (na === undefined && nb === undefined) return true;
  if (na === undefined || nb === undefined) return false;
  if (typeof na !== 'object' && typeof nb !== 'object') return na === nb;
  return JSON.stringify(na) === JSON.stringify(nb);
}

/** Which fields an incoming query would change if it overwrote the stored one. */
function diffQueryFields(incoming, stored) {
  if (!incoming || !stored) return [];
  return DIFF_FIELDS.filter((field) => !sameValue(incoming[field], stored[field]));
}

/**
 * Is the incoming row strictly newer? This mirrors isNewer() in api/routes/queries.js on
 * purpose, including the treatment of unparseable timestamps: the preview must not offer
 * an update the server would then refuse, or the user is told a change landed when it did
 * not. Compared as instants, so an exported "+01:00" offset does not lose to a Z stamp of
 * the same moment.
 */
function isNewer(incoming, stored) {
  const a = Date.parse(incoming);
  if (Number.isNaN(a)) return false;
  const b = Date.parse(stored);
  if (Number.isNaN(b)) return true;
  return a > b;
}

/**
 * Classify one incoming query against the store and, for id collisions, say what moves.
 *
 * Statuses:
 *   add        — no such id, and the body is not a copy of an existing query
 *   duplicate  — new id but the query body already exists verbatim
 *   error      — failed validation
 *   update     — id exists, content differs, incoming is strictly newer
 *   older      — id exists, content differs, but the stored copy is the newer one
 *   identical  — id exists and nothing would change
 */
function planImport(incoming, existing) {
  const items = [];
  const counts = { add: 0, update: 0, older: 0, identical: 0, duplicate: 0, error: 0, total: 0 };
  if (!Array.isArray(incoming)) return { items, byIndex: new Map(), counts };

  // Both of these grow as the file is walked, so a file that repeats an id or a query
  // body inside itself is caught the same way one that collides with the store is. Letting
  // the second copy through would put two rows with one id into local state, which React
  // renders as one row that flickers between two records.
  const storedById = new Map((existing || []).map((q) => [q.id, q]));
  const bodyHashes = new Set((existing || []).map((q) => simpleHash(q.query || '')));
  const seenInFile = new Set();
  const now = new Date().toISOString();
  counts.total = incoming.length;

  incoming.forEach((raw, index) => {
    const name = (raw && raw.name) || '(unnamed)';
    const stored = raw && raw.id ? storedById.get(raw.id) : undefined;

    if (raw && raw.id && seenInFile.has(raw.id)) {
      counts.duplicate++;
      items.push({ index, name, status: 'duplicate', reason: 'Repeated id in this file', changedFields: [] });
      return;
    }

    // The body-hash check is for genuinely new records only. A collision on id is a
    // resend of a query we already hold, so its body matching itself is expected.
    if (!stored && raw && raw.query && bodyHashes.has(simpleHash(raw.query))) {
      counts.duplicate++;
      items.push({ index, name, status: 'duplicate', reason: 'Duplicate query body', changedFields: [] });
      return;
    }

    const validation = validateQuery({
      ...raw,
      id: (raw && raw.id) || generateId(),
      created: (raw && raw.created) || now,
      updated: (raw && raw.updated) || now,
    });
    if (!validation.sanitized) {
      counts.error++;
      items.push({ index, name, status: 'error', reason: validation.errors.join('; '), changedFields: [] });
      return;
    }
    const sanitized = validation.sanitized;
    seenInFile.add(sanitized.id);

    if (!stored) {
      counts.add++;
      bodyHashes.add(simpleHash(sanitized.query));
      storedById.set(sanitized.id, sanitized);
      items.push({ index, name: sanitized.name, status: 'add', reason: null, changedFields: [], sanitized });
      return;
    }

    const changedFields = diffQueryFields(sanitized, stored);
    if (changedFields.length === 0) {
      counts.identical++;
      items.push({ index, name: sanitized.name, status: 'identical', reason: 'Already up to date', changedFields, stored });
      return;
    }
    if (!isNewer(sanitized.updated, stored.updated)) {
      counts.older++;
      items.push({
        index,
        name: sanitized.name,
        status: 'older',
        reason: 'Stored copy is newer',
        changedFields,
        stored,
      });
      return;
    }

    // created belongs to the row, not to this edit, and usageCount is monotonic — both
    // merge rules mirror what the server does, so the optimistic local copy and the row
    // that comes back from the API agree.
    const merged = {
      ...sanitized,
      created: stored.created || sanitized.created,
      usageCount: Math.max(sanitized.usageCount || 0, stored.usageCount || 0),
    };
    counts.update++;
    bodyHashes.add(simpleHash(merged.query));
    storedById.set(merged.id, merged);
    items.push({
      index,
      name: merged.name,
      status: 'update',
      reason: `Changes: ${changedFields.join(', ')}`,
      changedFields,
      stored,
      sanitized: merged,
    });
  });

  return { items, byIndex: new Map(items.map((i) => [i.index, i])), counts };
}

/**
 * Pull the query array out of whatever an import file happens to be — a bare array, or a
 * versioned blob that has to run the migration chain first. Returns the reason instead
 * when the file cannot be used, so the caller can report it verbatim.
 */
function readImportFile(jsonString) {
  const parsed = safeJsonParse(jsonString);
  if (!parsed.ok) return { error: 'Invalid JSON: ' + parsed.error };

  let incoming = parsed.data;
  if (incoming && typeof incoming === 'object' && !Array.isArray(incoming) && Array.isArray(incoming.queries)) {
    // A file from a newer build is refused rather than silently downgraded, because
    // importing it would strip fields this build does not know about.
    const migrated = migrateData(incoming);
    if (migrated && migrated.tooNew) {
      return {
        error: `This file was exported by a newer version of KQL Store (schema v${migrated.schemaVersion}). `
             + 'Upgrade before importing it, or fields would be silently dropped.',
      };
    }
    incoming = migrated ? migrated.queries : incoming.queries;
  }

  if (!Array.isArray(incoming)) {
    return { error: 'Expected an array of queries or a data blob with queries array' };
  }
  return { queries: incoming };
}

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

  // Sync all local data to API (used when API comes back online).
  //
  // This function owns apiAvailableRef, and it only raises the flag once the data has
  // actually round-tripped. Nothing else may raise it on this path: the retry loop used to
  // set it from a bare health check and then call this, so a sync that failed immediately
  // afterwards left the flag up and the retry loop — which only runs while the flag is
  // down — never ran again. Offline work then sat in localStorage until some unrelated
  // write happened to fail and put the flag back down.
  const syncToApi = useCallback(async () => {
    try {
      const current = queriesRef.current;
      if (current.length > 0) {
        // 'upsert', not the default insert. This runs after a spell offline, so the rows
        // being pushed already exist on the server; under insert semantics the server
        // keeps its own copy and the edit made while offline is discarded with a success
        // response. The server still refuses anything not strictly newer, so this cannot
        // roll back a later edit made in another browser.
        await StorageAdapter.importQueries(current, { mode: 'upsert' });
      }
      // Re-fetch from API to get the merged state
      const apiQueries = await StorageAdapter.fetchAll();
      setQueries(apiQueries);
      const blob = buildBlob(apiQueries);
      StorageAdapter.setCachedData(blob);
      apiAvailableRef.current = true;
      return true;
    } catch {
      // Leave the latch down so the retry interval is still armed for the next tick.
      apiAvailableRef.current = false;
      return false;
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

    // Retry interval: when API is unavailable, periodically try to re-sync.
    // The health check is only a cheap gate on attempting the sync — it must not raise
    // apiAvailableRef itself, because a pod that answers /health while the database is
    // unwritable would then disarm this loop for the rest of the session. syncToApi sets
    // the flag, and only when the data actually made it across.
    retryIntervalRef.current = setInterval(async () => {
      if (apiAvailableRef.current) return;
      try {
        await StorageAdapter.healthCheck();
      } catch {
        return; // Still unavailable, will retry next interval
      }
      await syncToApi();
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
    } catch (e) {
      apiAvailableRef.current = false;
      setSavingState('error');
      // The message carries the server's own reason — which field it refused, or that
      // nothing answered at all. "Save failed" alone left the user with no way to tell a
      // rejected value apart from an unreachable pod.
      setError(`Save failed (${e.message}) — stored locally only. Changes may be lost if you clear browser data.`);
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
    } catch (e) {
      apiAvailableRef.current = false;
      // The row is gone locally but still on the server, and the reconnect sync pushes
      // rows up rather than deleting them — so it will come back on the next load. Say
      // so, with the server's reason, rather than reporting a clean delete.
      setError(`Delete failed (${e.message}) — removed locally only; it may reappear when the API returns.`);
    }

    return true;
  }, [persistQueries]);

  // Get query by id
  const getQuery = useCallback((id) => {
    return queriesRef.current.find((q) => q.id === id) || null;
  }, []);

  // Import with deduplication — FIXES Finding 5, Finding 9: validates + strips unexpected fields
  //
  // `options.mode` is the user's answer to "may this overwrite what I already have?":
  //
  //   'insert' (default) — an incoming query whose id already exists is left alone. This
  //                        is what the Import button has always done and must keep doing.
  //   'upsert'           — collisions are overwritten, but only where the incoming copy is
  //                        strictly newer AND its content actually differs. Everything
  //                        else is still reported and skipped.
  //
  // Anything other than the exact string 'upsert' means insert, so a caller that forwards
  // a click event where options were expected cannot trigger a bulk overwrite.
  const importQueries = useCallback(async (jsonString, options) => {
    const mode = options && options.mode === 'upsert' ? 'upsert' : 'insert';
    // added/skipped/duplicateBody/errors describe what happened and keep the meaning every
    // existing caller already reads. updated/updatable/older/identical describe the id
    // collisions: `updated` is rows actually overwritten, `updatable` is rows an upsert
    // would have overwritten — which is how an insert-mode run can tell the user that an
    // update is available without performing one.
    const report = {
      mode,
      added: 0, skipped: 0, duplicateBody: 0, errors: 0,
      updated: 0, updatable: 0, older: 0, identical: 0,
      details: [],
    };

    const file = readImportFile(jsonString);
    if (file.error) {
      report.errors = 1;
      report.details.push({ error: file.error });
      return report;
    }

    const plan = planImport(file.queries, queriesRef.current);
    const newQueries = [...queriesRef.current];
    const toCreate = [];
    const toUpdate = [];

    for (const item of plan.items) {
      const { index, name, status, reason } = item;
      if (status === 'add') {
        newQueries.push(item.sanitized);
        toCreate.push(item.sanitized);
        report.added++;
        report.details.push({ index, name, status: 'added' });
        continue;
      }
      if (status === 'duplicate') {
        report.duplicateBody++;
        report.details.push({ index, name, status: 'duplicate_body', reason });
        continue;
      }
      if (status === 'error') {
        report.errors++;
        report.details.push({ index, name, status: 'invalid', reason });
        continue;
      }
      // Everything below is an id collision. Under insert semantics all three outcomes
      // are the same skip they have always been; the classification only becomes a
      // decision when the user has asked for an upsert.
      if (mode !== 'upsert' || status !== 'update') {
        report.skipped++;
        if (status === 'update') report.updatable++;
        else if (status === 'older') report.older++;
        else report.identical++;
        report.details.push({
          index,
          name,
          status: 'skipped',
          reason: mode === 'upsert' ? reason : 'Duplicate ID',
          changedFields: item.changedFields,
        });
        continue;
      }

      const at = newQueries.findIndex((q) => q.id === item.sanitized.id);
      if (at >= 0) newQueries[at] = item.sanitized;
      toUpdate.push(item.sanitized);
      report.updated++;
      report.details.push({ index, name, status: 'updated', reason, changedFields: item.changedFields });
    }

    setQueries(newQueries);
    persistQueries(newQueries);

    // Bulk import to API — always attempt. The rows are sent as one request so the server
    // applies them in a single transaction; under 'upsert' its own newer-wins check runs
    // again on the authoritative stored row, which is what stops a stale tab from
    // rolling back an edit made elsewhere while this one was offline.
    const outgoing = [...toCreate, ...toUpdate];
    if (outgoing.length > 0) {
      try {
        const result = await StorageAdapter.importQueries(outgoing, { mode });
        apiAvailableRef.current = true;
        // The server validates independently of validateQuery and reports what it would
        // not store. Dropping that on the floor is how a row ends up living in the cache
        // and nowhere else, with a success message on screen.
        if (result && Array.isArray(result.rejected) && result.rejected.length > 0) {
          report.errors += result.rejected.length;
          report.apiRejected = result.rejected.length;
          for (const r of result.rejected) {
            report.details.push({ index: r.index, status: 'api_rejected', reason: `Server rejected: ${r.reason}` });
          }
        }
      } catch (e) {
        apiAvailableRef.current = false;
        // Data is safe in cache and the retry loop will sync it, so this is not counted
        // as an import error — but it is no longer silent.
        report.apiError = e.message;
        report.details.push({ status: 'api_unreachable', reason: `Saved locally only — ${e.message}` });
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
      } catch (e) {
        apiAvailableRef.current = false;
        // A purge that only emptied the cache is not a purge — the rows return on the
        // next load. The server's reason is the difference between "pod is down, try
        // again" and "one row would not delete".
        setError(`Purge incomplete (${e.message}) — cleared locally, but the API still holds these queries.`);
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

export { useKQLStorage, planImport, readImportFile, diffQueryFields, DIFF_FIELDS };
