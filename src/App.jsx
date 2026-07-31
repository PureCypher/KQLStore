import React, { useState, useEffect, useCallback, useMemo, useRef, useId } from 'react';
import { Search, Plus, Upload, Filter, X, Keyboard, Terminal, Database, AlertTriangle } from 'lucide-react';
import { CATEGORIES, BACKUP_KEY, CURRENT_SCHEMA_VERSION } from './constants.js';
import { generateId } from './lib/id.js';
import { getTableDisplayName } from './domain/tables.js';
import { validateQuery } from './domain/validate.js';
import { migrateData } from './domain/migrate.js';
import { simpleHash } from './domain/hash.js';
import { makeFork, indexById, childrenOf, matchesLineageFilter } from './domain/lineage.js';
import { safeJsonParse } from './lib/json.js';
import { StorageAdapter } from './storage/adapter.js';
import { useKQLStorage } from './storage/useKQLStorage.js';
import { useDebounce } from './hooks/useDebounce.js';
import { ToastContext } from './context/toast.js';
import { StorageInspector } from './components/StorageInspector.jsx';
import { ExportMenu } from './components/ExportMenu.jsx';
import { Modal } from './components/Modal.jsx';
import { AppContext } from './context/app.js';
import { ToastContainer } from './components/ToastContainer.jsx';
import { KeyboardHelp } from './components/KeyboardHelp.jsx';
import { QueryEditorModal } from './components/QueryEditorModal.jsx';
import { QueryCard } from './components/QueryCard.jsx';
import { SidebarContent } from './components/SidebarContent.jsx';
import { ImportPreviewModal } from './components/ImportPreviewModal.jsx';
import { BulkActionBar } from './components/BulkActionBar.jsx';
import { SavingIndicator } from './components/SavingIndicator.jsx';

export default function App() {
  const storage = useKQLStorage();
  const {
    queries,
    isLoading,
    error: storageError,
    setError: setStorageError,
    savingState,
    lastSavedTimestamp,
    stats,
  } = storage;

  const [searchTerm, setSearchTerm] = useState('');
  const debouncedSearch = useDebounce(searchTerm, 250);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [selectedTable, setSelectedTable] = useState(null);
  const [tableFilterExpanded, setTableFilterExpanded] = useState({ sentinel: true, defender: true, custom: true });
  const [selectedTags, setSelectedTags] = useState([]);
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [lineageFilter, setLineageFilter] = useState(null);
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
  const mobileSidebarTitleId = useId();
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

  // Both of these must go through storage.saveQuery, not persistQueries. persistQueries only
  // writes the localStorage cache, and since the API became the source of truth the next load
  // overwrites that cache with the server row — so a starred query silently un-starred itself
  // and every usage count reset on reload. saveQuery does the optimistic update, the cache
  // write and the PUT, and surfaces failure through savingState.
  const toggleFavorite = useCallback((id) => {
    const current = queries.find((q) => q.id === id);
    if (!current) return;
    storage.saveQuery({ ...current, favorite: !current.favorite });
  }, [queries, storage]);

  const incrementUsage = useCallback((id) => {
    const current = queries.find((q) => q.id === id);
    if (!current) return;
    storage.saveQuery({ ...current, usageCount: (current.usageCount || 0) + 1 });
  }, [queries, storage]);

  const duplicateQuery = useCallback(async (query) => {
    const now = new Date().toISOString();
    const dup = { ...query, id: generateId(), name: `${query.name} (copy)`, created: now, updated: now, usageCount: 0 };
    const ok = await storage.saveQuery(dup);
    addToast(ok ? 'Query duplicated' : 'Duplicate saved locally only — API unreachable', ok ? 'success' : 'error');
  }, [storage, addToast]);

  // Lineage maps are derived from `queries` client-side rather than denormalised into the
  // database, so they only need to stay in sync with a value already in state.
  const lineage = useMemo(
    () => ({ byId: indexById(queries), forkIndex: childrenOf(queries) }),
    [queries],
  );

  // Forking opens a draft in the editor rather than writing immediately — the draft's id
  // is not yet in `queries`, so nothing is persisted until the user saves.
  const forkQuery = useCallback((source) => {
    setEditingQuery(makeFork(source, generateId(), new Date().toISOString()));
  }, []);

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

  // `options` carries the mode the preview chose. It must be forwarded: without it the
  // "update existing" button silently performs an insert-only import, which is safe but
  // does nothing — a promise the UI should not make. Anything that is not exactly
  // { mode: 'upsert' } is treated as an insert by importQueries, so a forwarded click
  // event cannot turn into a bulk overwrite.
  const confirmImport = useCallback(async (options) => {
    if (!importPreview) return;
    try {
      const report = await storage.importQueries(importPreview.text, options);

      // A request the server refused outright, or per-row rejections it returned with a
      // 200. Both used to be discarded, so a rejected import looked like an empty one.
      if (report.apiError) {
        addToast(`Import failed: ${report.apiError}`, 'error');
      } else if (report.errors > 0 && report.added === 0 && !report.updated) {
        addToast(`Import failed: ${report.details.map(d => d.error || d.reason).filter(Boolean).join('; ')}`, 'error');
      } else {
        const parts = [`${report.added} new`];
        if (report.updated) parts.push(`${report.updated} updated`);
        if (report.skipped) parts.push(`${report.skipped} skipped`);
        if (report.duplicateBody) parts.push(`${report.duplicateBody} duplicate bodies`);
        if (report.errors) parts.push(`${report.errors} errors`);
        const changed = report.added > 0 || report.updated > 0;
        addToast(`Imported ${parts.join(', ')}`, changed ? 'success' : 'info');
      }
      if (report.apiRejected?.length) {
        addToast(`${report.apiRejected.length} row(s) rejected by the server`, 'error');
      }
    } catch {
      addToast('Failed to import -- unexpected error', 'error');
    }
    setImportPreview(null);
  }, [importPreview, storage, addToast]);

  // --- Bulk Operations ---
  // These must reach the API like the single-item operations do. Writing only the localStorage
  // cache meant the next load replaced it with the server rows, so bulk-deleted queries came
  // back and bulk re-categorisation was discarded — in both cases after a success toast.
  const applyBulk = useCallback(async (ids, fn, verb) => {
    const results = await Promise.allSettled(ids.map(fn));
    const failed = results.filter((r) => r.status === 'rejected' || r.value === false).length;
    if (failed === 0) {
      addToast(`${verb} ${ids.length} queries`, 'success');
    } else {
      addToast(`${verb} ${ids.length - failed} of ${ids.length} — ${failed} failed, API may be unreachable`, 'error');
    }
    setSelectedIds(new Set());
  }, [addToast]);

  const handleBulkDelete = useCallback(() => {
    applyBulk([...selectedIds], (id) => storage.deleteQuery(id), 'Deleted');
  }, [selectedIds, storage, applyBulk]);

  const handleBulkExport = useCallback(() => {
    const selected = queries.filter((q) => selectedIds.has(q.id));
    handleExport(selected);
    setSelectedIds(new Set());
  }, [queries, selectedIds, handleExport]);

  const handleBulkCategory = useCallback((category) => {
    applyBulk([...selectedIds], (id) => {
      const q = queries.find((x) => x.id === id);
      return q ? storage.saveQuery({ ...q, category }) : false;
    }, `Moved to ${category}:`);
  }, [selectedIds, queries, storage, applyBulk]);

  const handleBulkTable = useCallback((table) => {
    applyBulk([...selectedIds], (id) => {
      const q = queries.find((x) => x.id === id);
      return q ? storage.saveQuery({ ...q, table }) : false;
    }, `Set table ${getTableDisplayName(table)} on`);
  }, [selectedIds, queries, storage, applyBulk]);

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
    if (lineageFilter) result = result.filter((q) => matchesLineageFilter(q, lineageFilter, lineage.forkIndex, lineage.byId));
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
  }, [queries, debouncedSearch, selectedCategory, selectedTable, selectedTags, showFavoritesOnly, lineageFilter, lineage, sortBy, sortDir]);

  // --- Clipboard ---
  // navigator.clipboard only exists in a secure context. Over plain HTTP on a non-localhost
  // origin — exactly what the k8s manifests serve without a TLS-terminating proxy in front —
  // it is undefined, so this threw a TypeError that the bare catch turned into a useless
  // "Failed to copy". Copy is the app's primary action, so it degrades instead of failing:
  // the execCommand path still works without a secure context, and if both fail the message
  // names the actual cause.
  const copyToClipboard = useCallback(async (text, queryId) => {
    const legacyCopy = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      // Keep it off-screen and non-focusable-looking so the page does not jump.
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try {
        return document.execCommand('copy');
      } finally {
        ta.remove();
      }
    };

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else if (!legacyCopy()) {
        throw new Error('execCommand copy rejected');
      }
      if (queryId) incrementUsage(queryId);
      addToast('Copied to clipboard!', 'success');
    } catch {
      addToast(
        window.isSecureContext
          ? 'Failed to copy'
          : 'Clipboard blocked — serve this page over HTTPS or via localhost',
        'error',
      );
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
    setSelectedTags([]); setShowFavoritesOnly(false); setLineageFilter(null);
  }, []);

  const hasActiveFilters = selectedCategory || selectedTable || selectedTags.length > 0 || showFavoritesOnly || debouncedSearch || lineageFilter;

  // Every value the hoisted shell components read. Memoised so the identity only changes
  // when something they actually use changes.
  const appValue = useMemo(() => ({
    toasts,
    showKeyboardHelp, setShowKeyboardHelp,
    editingQuery, setEditingQuery, saveQuery,
    copyToClipboard,
    deleteQuery, duplicateQuery, forkQuery, lineage, toggleFavorite, toggleExpand, toggleSelect,
    selectedIds, setSelectedIds, selectedTags, setSelectedTags,
    queries, stats, allTags, categoryCounts,
    searchRef, searchTerm, setSearchTerm,
    selectedCategory, setSelectedCategory, selectedTable, setSelectedTable,
    showFavoritesOnly, setShowFavoritesOnly,
    lineageFilter, setLineageFilter,
    sortBy, setSortBy, sortDir, setSortDir,
    tableFilterExpanded, setTableFilterExpanded,
    hasActiveFilters, clearFilters,
    importPreview, setImportPreview, confirmImport,
    handleBulkDelete, handleBulkExport, handleBulkCategory, handleBulkTable,
    savingState,
    expandedIds,
  }), [
    toasts, showKeyboardHelp, editingQuery, saveQuery, copyToClipboard, deleteQuery,
    duplicateQuery, forkQuery, lineage, toggleFavorite, toggleExpand, toggleSelect, selectedIds, selectedTags,
    queries, stats, allTags, categoryCounts, searchTerm, selectedCategory, selectedTable,
    showFavoritesOnly, lineageFilter, sortBy, sortDir, tableFilterExpanded, hasActiveFilters, clearFilters,
    importPreview, confirmImport, handleBulkDelete, handleBulkExport, handleBulkCategory,
    handleBulkTable, savingState, expandedIds, searchRef,
  ]);

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
    <AppContext.Provider value={appValue}>
    <ToastContext.Provider value={{ addToast }}>
      <div className="flex h-screen font-mono overflow-hidden" style={{ background: '#0a0a0f', color: '#e0e0e0' }}>
        <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleImport} />

        {/* Mobile sidebar. It behaves as a modal overlay — it covers the page and the
            content behind it is unreachable — so it needs the same dialog semantics as the
            other overlays: a focus trap, Escape to close, and focus returned to the button
            that opened it. It was previously a bare div, so a keyboard or screen-reader
            user could tab straight through it into the cards underneath. */}
        {showMobileSidebar && (
          <Modal
            labelledBy={mobileSidebarTitleId}
            onClose={() => setShowMobileSidebar(false)}
            backdropClassName="lg:hidden"
            className="relative w-72 h-full shadow-2xl"
            style={{ background: '#0d0d14' }}
          >
            <h2 id={mobileSidebarTitleId} className="sr-only">Filters and sorting</h2>
            <button
              onClick={() => setShowMobileSidebar(false)}
              aria-label="Close filters"
              title="Close filters"
              className="absolute top-3 right-3 p-1 rounded hover:bg-white/10 z-10 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00d4ff]"
            >
              <X size={16} className="text-gray-400" />
            </button>
            <SidebarContent />
          </Modal>
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
              <button onClick={() => setShowMobileSidebar(true)} aria-label="Open filters" title="Filters" className="lg:hidden p-1.5 rounded-md hover:bg-white/5 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00d4ff]">
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
              <button onClick={() => fileInputRef.current?.click()} aria-label="Import queries from a JSON file"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs hover:bg-white/5 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00d4ff]"
                style={{ border: '1px solid #2a2a3e', color: '#aaa' }}><Upload size={14} /><span className="hidden sm:inline">Import</span></button>
              <ExportMenu queries={filteredQueries} onToast={addToast} />
              <button onClick={() => setShowKeyboardHelp(true)} aria-label="Keyboard shortcuts" className="p-1.5 rounded-md hover:bg-white/5 hidden sm:block focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00d4ff]" title="Keyboard shortcuts (?)">
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
            style={{ borderTop: '1px solid #1e1e2e', background: '#0d0d14', color: '#9ca3af' }}>
            <div className="flex items-center gap-4">
              <span>{filteredQueries.length} / {queries.length} queries</span>
              {hasActiveFilters && <span style={{ color: '#00d4ff' }}>filtered</span>}
            </div>
            <div className="flex items-center gap-4">
              <SavingIndicator />
              {lastSavedTimestamp && <span>synced {new Date(lastSavedTimestamp).toLocaleTimeString()}</span>}
              <button onClick={() => setShowInspector((p) => !p)} aria-label="Storage inspector" className="hover:text-gray-300 flex items-center gap-1 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00d4ff]" title="Storage Inspector (Ctrl+Shift+D)">
                <Database size={10} />
                <span>v{CURRENT_SCHEMA_VERSION}</span>
              </button>
            </div>
          </footer>
        </main>

        {/* Overlays */}
        <ToastContainer />
        <KeyboardHelp />
        {/* Mounted only while open, and keyed on the target query. Rendering it
            unconditionally left it mounted with `return null` inside, so its form state
            survived close/reopen: a draft leaked into the next new query, and opening an
            existing query showed the previous draft instead of that query's contents. */}
        {editingQuery && <QueryEditorModal key={editingQuery.id ?? 'new'} />}
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
    </AppContext.Provider>
  );
}
