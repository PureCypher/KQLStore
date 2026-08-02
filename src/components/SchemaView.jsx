import React, { useState, useEffect, useMemo, useId, useRef, useCallback } from 'react';
import { Search, Plus, Trash2, Download, Upload, X, AlertTriangle } from 'lucide-react';
import { parseGetSchema } from '../domain/getschema.js';
import { StorageAdapter } from '../storage/adapter.js';
import { safeJsonParse } from '../lib/json.js';
import { useToast } from '../context/toast.js';
import { useDebounce } from '../hooks/useDebounce.js';
import { Modal } from './Modal.jsx';
import { FOCUS_RING } from './a11y.jsx';

// ---------------------------------------------------------------------------
// Schema store: a searchable list of table_schemas rows, a paste box that runs
// parseGetSchema before anything is sent to the API, and JSON export/import for the
// whole set.
//
// There is no separate "edit columns" form. PUT /api/schemas/:name is an upsert keyed
// on name, so re-saving an existing row IS the edit: selecting a row from the list
// loads its name and notes into the form, and pasting fresh getschema output replaces
// its columns. Leaving the paste box empty keeps the columns already on file — the
// server requires `columns` on every PUT, so they travel back out of `schemas` state
// rather than being re-parsed. Renaming is not offered: the API has no path for it,
// only upsert-by-name, and a text field that silently created a second row under a
// typo'd name would be worse than no rename at all.
//
// Import intentionally does not reuse ImportPreviewModal.jsx: that component reads
// `confirmImport`/`queries` off AppContext and diffs against the query domain via
// planImport, neither of which applies to a table_schemas row, and it is out of scope
// for this task to rework. What is reused is the item shape it renders —
// { index, name, status, reason } — and the same review-before-commit shape, built
// locally against StorageAdapter.saveSchema instead.
//
// nameInput/pasteText/notesInput are owned by App, not this component: SchemaView is
// unmounted whenever `view !== 'schemas'` (App keeps exactly one tabpanel in the DOM at a
// time — see App.jsx's comment on that choice), and local state does not survive an
// unmount. Owning the three form fields one level up means a paste and hand-typed notes
// are still there when the user comes back from the Queries tab to check something.
// ---------------------------------------------------------------------------

const SOURCE_LABELS = {
  getschema: 'getschema',
  manual: 'manual',
  import: 'import',
};

// Screen readers get the settled outcome, not a running commentary: parseGetSchema is
// cheap enough to re-run on every keystroke for the sighted, always-current hint text, but
// an aria-live region that changes on every keystroke reads out a new value on every
// keystroke too — a screen-reader user typing a 40-column paste hears it interrupted and
// re-announced dozens of times. The visible hint stays live; a second, hidden, debounced
// node is what gets announced, once typing pauses.
const PASTE_ANNOUNCE_DELAY_MS = 500;

function columnWord(n) {
  return `${n} column${n === 1 ? '' : 's'}`;
}

/** The paste-box hint text, live for sighted users and (debounced) for screen readers. */
function describePasteHint(text, parseResult, selectedSchema) {
  if (text.trim()) {
    return parseResult.ok ? `${columnWord(parseResult.columns.length)} parsed.` : parseResult.error;
  }
  if (selectedSchema) {
    return `Keeping the stored ${columnWord(selectedSchema.columns.length)}. Paste new getschema output to replace them.`;
  }
  return 'Paste getschema output to add columns.';
}

/** Build the accepted-or-rejected preview for one row of an imported schema file. */
function planImportRow(raw, index, existingNames) {
  const name = raw && typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return { index, name: '(unnamed)', status: 'error', reason: '"name" is required' };
  if (!Array.isArray(raw.columns)) return { index, name, status: 'error', reason: '"columns" must be an array' };
  const entry = { name, columns: raw.columns, notes: typeof raw.notes === 'string' ? raw.notes : '' };
  return existingNames.has(name)
    ? { index, name, status: 'update', reason: 'Overwrites the stored schema', entry }
    : { index, name, status: 'add', reason: null, entry };
}

function DeleteSchemaModal({ name, deleting, onCancel, onConfirm }) {
  const titleId = useId();
  return (
    <Modal
      labelledBy={titleId}
      onClose={onCancel}
      backdropClassName="z-[80] items-center justify-center"
      className="rounded-xl p-6 font-mono w-full max-w-sm mx-4"
      style={{ background: '#12121a', border: '1px solid #2a2a3e' }}
    >
      <h2 id={titleId} className="text-lg font-bold mb-3" style={{ color: '#ff4444' }}>Delete schema?</h2>
      <p className="text-sm text-gray-300 mb-5">
        This removes <span style={{ color: '#00d4ff' }}>{name}</span> from the schema store. This cannot be undone.
      </p>
      <div className="flex justify-end gap-3">
        <button onClick={onCancel}
          className={`px-4 py-2 rounded-lg text-sm font-mono text-gray-400 hover:text-gray-200 hover:bg-white/5 ${FOCUS_RING}`}
          style={{ border: '1px solid #2a2a3e' }}>Cancel</button>
        <button onClick={onConfirm} disabled={deleting}
          className={`px-4 py-2 rounded-lg text-sm font-mono font-bold disabled:opacity-40 ${FOCUS_RING}`}
          style={{ background: '#ff4444', color: '#0a0a0f' }}>
          {deleting ? 'Deleting...' : 'Delete'}
        </button>
      </div>
    </Modal>
  );
}

function SaveCollisionModal({ name, existing, saving, onCancel, onConfirm }) {
  const titleId = useId();
  return (
    <Modal
      labelledBy={titleId}
      onClose={onCancel}
      backdropClassName="z-[80] items-center justify-center"
      className="rounded-xl p-6 font-mono w-full max-w-sm mx-4"
      style={{ background: '#12121a', border: '1px solid #2a2a3e' }}
    >
      <h2 id={titleId} className="text-lg font-bold mb-3" style={{ color: '#ffb020' }}>Overwrite existing schema?</h2>
      <p className="text-sm text-gray-300 mb-5">
        A schema named <span style={{ color: '#00d4ff' }}>{name}</span> already exists, with {columnWord(existing.columns.length)}
        {existing.notes ? ' and notes' : ''}. Saving replaces its columns{existing.notes ? ' and clears its notes' : ''} — this cannot be undone.
      </p>
      <div className="flex justify-end gap-3">
        <button onClick={onCancel}
          className={`px-4 py-2 rounded-lg text-sm font-mono text-gray-400 hover:text-gray-200 hover:bg-white/5 ${FOCUS_RING}`}
          style={{ border: '1px solid #2a2a3e' }}>Cancel</button>
        <button onClick={onConfirm} disabled={saving}
          className={`px-4 py-2 rounded-lg text-sm font-mono font-bold disabled:opacity-40 ${FOCUS_RING}`}
          style={{ background: '#ffb020', color: '#0a0a0f' }}>
          {saving ? 'Saving...' : 'Overwrite'}
        </button>
      </div>
    </Modal>
  );
}

const IMPORT_STATUS_COLORS = { add: '#00ff88', update: '#00d4ff', error: '#ff4444' };
const IMPORT_STATUS_LABELS = { add: 'New', update: 'Update', error: 'Invalid' };

function SchemaImportModal({ preview, importing, onCancel, onConfirm }) {
  const titleId = useId();
  const summaryId = useId();
  const acceptedCount = preview.willAdd + preview.willUpdate;
  return (
    <Modal
      labelledBy={titleId}
      onClose={onCancel}
      backdropClassName="z-[80] items-start justify-center pt-8 pb-8 overflow-y-auto"
      className="rounded-xl p-6 font-mono w-full max-w-xl mx-4"
      style={{ background: '#12121a', border: '1px solid #2a2a3e' }}
    >
      <div className="flex justify-between items-center mb-4">
        <h2 id={titleId} className="text-lg font-bold" style={{ color: '#00ff88' }}>Import Schemas</h2>
        <button onClick={onCancel} className={`p-1 rounded hover:bg-white/10 ${FOCUS_RING}`}
          aria-label="Close import preview" title="Close">
          <X size={16} className="text-gray-400" aria-hidden="true" />
        </button>
      </div>
      <div id={summaryId} className="flex gap-4 mb-4 text-xs">
        <span style={{ color: '#00ff88' }}>{preview.willAdd} new</span>
        <span style={{ color: '#00d4ff' }}>{preview.willUpdate} updated</span>
        <span style={{ color: '#ff4444' }}>{preview.willError} invalid</span>
        <span className="ml-auto text-gray-500">{preview.total} total</span>
      </div>
      <ul aria-label="Schemas in this import" className="max-h-64 overflow-y-auto space-y-1 mb-4"
        style={{ background: '#0a0a0f', borderRadius: 8, padding: 8, border: '1px solid #1a1a2e' }}>
        {preview.items.map((item) => (
          <li key={item.index} className="flex items-center gap-2 text-xs py-1 px-2 rounded">
            <span className="w-14 shrink-0 text-right" style={{ color: IMPORT_STATUS_COLORS[item.status] }}>
              {IMPORT_STATUS_LABELS[item.status]}
            </span>
            <span className="truncate text-gray-300 flex-1">{item.name}</span>
            {item.reason && <span className="text-gray-600 shrink-0 text-right truncate max-w-56">{item.reason}</span>}
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-3">
        <button onClick={onCancel}
          className={`px-4 py-2 rounded-lg text-sm font-mono text-gray-400 hover:text-gray-200 hover:bg-white/5 ${FOCUS_RING}`}
          style={{ border: '1px solid #2a2a3e' }}>Cancel</button>
        <button onClick={onConfirm} disabled={acceptedCount === 0 || importing}
          aria-describedby={summaryId}
          className={`px-4 py-2 rounded-lg text-sm font-mono font-bold disabled:opacity-40 ${FOCUS_RING}`}
          style={{ background: acceptedCount > 0 ? '#00ff88' : '#333', color: '#0a0a0f' }}>
          {importing ? 'Importing...' : `Import ${acceptedCount} ${acceptedCount === 1 ? 'Schema' : 'Schemas'}`}
        </button>
      </div>
    </Modal>
  );
}

function SchemaView({ nameInput, setNameInput, pasteText, setPasteText, notesInput, setNotesInput }) {
  const { addToast } = useToast();
  const [schemas, setSchemas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  // Durable surface for a failed WRITE (save/delete/import), mirroring the query-side error
  // banner in App.jsx rather than a toast: a toast is gone in 3 seconds, and a failed write
  // leaves nothing else on screen to say the store did not get what the user thinks it got.
  // loadError above covers the initial fetch; this covers everything after.
  const [actionError, setActionError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedName, setSelectedName] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [collisionTarget, setCollisionTarget] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef(null);
  const baseId = useId();
  const ids = {
    search: `${baseId}-search`,
    name: `${baseId}-name`,
    paste: `${baseId}-paste`,
    pasteHint: `${baseId}-paste-hint`,
    notes: `${baseId}-notes`,
  };

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setSchemas(await StorageAdapter.fetchSchemas());
    } catch (e) {
      setLoadError(e.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const selectedSchema = useMemo(
    () => (selectedName ? schemas.find((s) => s.name === selectedName) || null : null),
    [selectedName, schemas],
  );

  const parseResult = useMemo(() => (pasteText.trim() ? parseGetSchema(pasteText) : null), [pasteText]);
  const debouncedPasteText = useDebounce(pasteText, PASTE_ANNOUNCE_DELAY_MS);
  const debouncedParseResult = useMemo(
    () => (debouncedPasteText.trim() ? parseGetSchema(debouncedPasteText) : null),
    [debouncedPasteText],
  );
  const columnsForSave = pasteText.trim()
    ? (parseResult.ok ? parseResult.columns : null)
    : (selectedSchema ? selectedSchema.columns : null);
  const trimmedName = nameInput.trim();
  const canSave = Boolean(trimmedName) && Boolean(columnsForSave) && !saving;

  const filteredSchemas = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return schemas;
    return schemas.filter((s) => s.name.toLowerCase().includes(term));
  }, [schemas, searchTerm]);

  const resetForm = () => {
    setSelectedName(null);
    setNameInput('');
    setNotesInput('');
    setPasteText('');
  };

  const handleSelect = (schema) => {
    setSelectedName(schema.name);
    setNameInput(schema.name);
    setNotesInput(schema.notes || '');
    setPasteText('');
  };

  const upsertLocal = (saved) => {
    setSchemas((prev) => {
      const idx = prev.findIndex((s) => s.name === saved.name);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = saved;
        return next;
      }
      return [...prev, saved].sort((a, b) => a.name.localeCompare(b.name));
    });
  };

  const performSave = async () => {
    setSaving(true);
    setActionError(null);
    const source = pasteText.trim() ? 'getschema' : (selectedSchema ? selectedSchema.source : 'manual');
    try {
      const saved = await StorageAdapter.saveSchema(trimmedName, { columns: columnsForSave, notes: notesInput, source });
      upsertLocal(saved);
      addToast(`Schema "${saved.name}" saved`, 'success');
      setSelectedName(saved.name);
      setPasteText('');
    } catch (e) {
      // Durable, not a toast — see the comment on actionError's declaration.
      setActionError(`Failed to save schema "${trimmedName}": ${e.message}`);
    }
    setSaving(false);
  };

  // A save under a typed name that already exists in the loaded list is the only
  // destructive action in this component with no guard: PUT is an upsert, so it replaces
  // the stored columns and — if Notes was left empty — blanks the notes too, with no way
  // back. Delete already confirms, and the JSON import preview already labels this same
  // collision "Overwrites the stored schema"; this makes the direct-save path consistent
  // with both instead of the only silent one. Editing via the list (selectedSchema truthy)
  // is exempt — selecting an existing row and clicking Update IS the edit, not a collision.
  const handleSave = () => {
    if (!canSave) return;
    const collision = !selectedSchema ? schemas.find((s) => s.name === trimmedName) : null;
    if (collision) {
      setCollisionTarget(collision);
      return;
    }
    performSave();
  };

  const handleCollisionConfirm = async () => {
    await performSave();
    setCollisionTarget(null);
  };

  const handleDeleteConfirm = async () => {
    const name = deleteTarget;
    if (!name) return;
    setDeleting(true);
    setActionError(null);
    try {
      await StorageAdapter.deleteSchema(name);
      setSchemas((prev) => prev.filter((s) => s.name !== name));
      if (selectedName === name) resetForm();
      addToast(`Schema "${name}" deleted`, 'info');
    } catch (e) {
      // Durable, not a toast — see the comment on actionError's declaration.
      setActionError(`Failed to delete schema "${name}": ${e.message}`);
    }
    setDeleting(false);
    setDeleteTarget(null);
  };

  const handleExport = async () => {
    try {
      const data = await StorageAdapter.fetchSchemas();
      const blob = new Blob([JSON.stringify({ schemas: data }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `kql-store-schemas-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      addToast(`Exported ${data.length} schemas`, 'success');
    } catch (e) {
      addToast(`Failed to export schemas: ${e.message}`, 'error');
    }
  };

  const handleImportFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = safeJsonParse(text);
      if (!parsed.ok) {
        addToast('Failed to import -- invalid JSON: ' + parsed.error, 'error');
        e.target.value = '';
        return;
      }
      let incoming = parsed.data;
      if (incoming && typeof incoming === 'object' && !Array.isArray(incoming) && Array.isArray(incoming.schemas)) {
        incoming = incoming.schemas;
      }
      if (!Array.isArray(incoming)) {
        addToast('Failed to import -- expected an array of schemas', 'error');
        e.target.value = '';
        return;
      }
      const existingNames = new Set(schemas.map((s) => s.name));
      const items = incoming.map((raw, index) => planImportRow(raw || {}, index, existingNames));
      setImportPreview({
        items,
        willAdd: items.filter((i) => i.status === 'add').length,
        willUpdate: items.filter((i) => i.status === 'update').length,
        willError: items.filter((i) => i.status === 'error').length,
        total: items.length,
      });
    } catch {
      addToast('Failed to read import file', 'error');
    }
    e.target.value = '';
  };

  const confirmImport = async () => {
    if (!importPreview) return;
    setImporting(true);
    setActionError(null);
    const accepted = importPreview.items.filter((i) => i.status === 'add' || i.status === 'update');
    let succeeded = 0;
    let failed = 0;
    for (const item of accepted) {
      try {
        // Awaited one at a time (not Promise.all) so a partial failure still leaves the
        // rows that already landed saved, rather than the batch racing and losing track
        // of which upserts actually committed.
        await StorageAdapter.saveSchema(item.entry.name, {
          columns: item.entry.columns, notes: item.entry.notes, source: 'import',
        });
        succeeded++;
      } catch {
        failed++;
      }
    }
    if (succeeded > 0) await load();
    if (failed > 0) {
      // At least one row failed to write, which means the store now holds less than the
      // preview promised. That is durable, not a toast — see actionError's declaration.
      const parts = [`${failed} of ${accepted.length} schemas failed to import`];
      if (succeeded) parts.push(`${succeeded} succeeded`);
      setActionError(parts.join(', '));
    } else {
      // Nothing failed to write — the invalid rows below were never attempted, and the
      // preview modal already showed them before the user confirmed, so a toast is enough.
      const parts = [`${succeeded} imported`];
      if (importPreview.willError) parts.push(`${importPreview.willError} invalid, skipped`);
      addToast(`Import: ${parts.join(', ')}`, importPreview.willError ? 'error' : 'success');
    }
    setImporting(false);
    setImportPreview(null);
  };

  const inputCls = `w-full px-3 py-2 rounded-lg font-mono text-sm text-gray-200 outline-hidden focus:ring-1 focus:ring-[#00ff88] ${FOCUS_RING}`;
  const inputSty = { background: '#1a1a2e', border: '1px solid #2a2a3e' };
  const labelCls = 'text-xs text-gray-400 mb-1 block';

  const pasteHint = describePasteHint(pasteText, parseResult, selectedSchema);
  const announcedPasteHint = describePasteHint(debouncedPasteText, debouncedParseResult, selectedSchema);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleImportFile} />

      <div className="flex items-center gap-2 px-4 py-3 shrink-0" style={{ borderBottom: '1px solid #1e1e2e', background: '#0d0d14' }}>
        <label htmlFor={ids.search} className="sr-only">Search schemas</label>
        <div className="relative flex-1 max-w-xs">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" aria-hidden="true" />
          <input id={ids.search} className={`${inputCls} pl-8`} style={inputSty} value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)} placeholder="Search table schemas..." />
        </div>
        <span className="text-xs text-gray-500">{schemas.length} schemas</span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={resetForm} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold ${FOCUS_RING}`}
            style={{ background: '#00ff88', color: '#0a0a0f' }}><Plus size={14} aria-hidden="true" /><span className="hidden sm:inline">New Schema</span></button>
          <button onClick={() => fileInputRef.current?.click()} aria-label="Import schemas from a JSON file"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs hover:bg-white/5 ${FOCUS_RING}`}
            style={{ border: '1px solid #2a2a3e', color: '#aaa' }}><Upload size={14} aria-hidden="true" /><span className="hidden sm:inline">Import</span></button>
          <button onClick={handleExport} aria-label="Export all schemas to a JSON file"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs hover:bg-white/5 ${FOCUS_RING}`}
            style={{ border: '1px solid #2a2a3e', color: '#aaa' }}><Download size={14} aria-hidden="true" /><span className="hidden sm:inline">Export</span></button>
        </div>
      </div>

      {loadError && (
        <div className="px-4 py-2 flex items-center justify-between text-xs" style={{ background: '#2a1010', borderBottom: '1px solid #ff444440' }}>
          <span style={{ color: '#ff4444' }}><AlertTriangle size={12} className="inline mr-2" aria-hidden="true" />{loadError}</span>
          <button onClick={load} className="px-2 py-1 rounded text-xs" style={{ color: '#00d4ff', border: '1px solid #2a2a3e' }}>Retry</button>
        </div>
      )}

      {actionError && (
        <div className="px-4 py-2 flex items-center justify-between text-xs" style={{ background: '#2a1010', borderBottom: '1px solid #ff444440' }}>
          <span style={{ color: '#ff4444' }}><AlertTriangle size={12} className="inline mr-2" aria-hidden="true" />{actionError}</span>
          <button onClick={() => setActionError(null)} className="px-2 py-1 rounded text-xs text-gray-500 hover:text-gray-300">Dismiss</button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-4xl mx-auto grid gap-4 md:grid-cols-2">
          <section aria-label="Stored schemas">
            {loading ? (
              <p className="text-gray-500 text-sm">Loading schemas...</p>
            ) : filteredSchemas.length === 0 ? (
              <p className="text-gray-500 text-sm">
                {schemas.length === 0 ? 'No schemas stored yet.' : 'No schemas match your search.'}
              </p>
            ) : (
              <ul className="space-y-2">
                {filteredSchemas.map((s) => (
                  <li key={s.name} className="flex items-center gap-2 rounded-lg"
                    style={{ background: selectedName === s.name ? '#12121a' : 'transparent', border: `1px solid ${selectedName === s.name ? '#00d4ff' : '#1e1e2e'}` }}>
                    <button onClick={() => handleSelect(s)} className={`flex-1 text-left px-3 py-2 ${FOCUS_RING}`}
                      aria-current={selectedName === s.name ? 'true' : undefined}>
                      <div className="text-sm text-gray-200">{s.name}</div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {columnWord(s.columns.length)} &middot; {SOURCE_LABELS[s.source] || s.source} &middot; {s.updated ? new Date(s.updated).toLocaleDateString() : 'unknown'}
                      </div>
                    </button>
                    <button onClick={() => setDeleteTarget(s.name)} aria-label={`Delete schema ${s.name}`} title="Delete"
                      className={`p-2 mr-1 rounded hover:bg-white/10 ${FOCUS_RING}`}>
                      <Trash2 size={14} style={{ color: '#ff6b6b' }} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label={selectedSchema ? `Edit schema ${selectedSchema.name}` : 'New schema'} className="space-y-4">
            <div>
              <label className={labelCls} htmlFor={ids.name}>Table name <span aria-hidden="true">*</span></label>
              <input id={ids.name} className={inputCls} style={inputSty} value={nameInput}
                aria-required="true" disabled={Boolean(selectedSchema)}
                onChange={(e) => setNameInput(e.target.value)} placeholder="e.g. SigninLogs" />
            </div>
            <div>
              <label className={labelCls} htmlFor={ids.paste}>Paste `| getschema` output</label>
              <textarea id={ids.paste} className={`${inputCls} font-mono`} style={{ ...inputSty, minHeight: 140, resize: 'vertical' }}
                aria-describedby={ids.pasteHint} spellCheck={false}
                value={pasteText} onChange={(e) => setPasteText(e.target.value)}
                placeholder={'ColumnName    ColumnType\nTimeGenerated  datetime\nAccount        string'} />
              <p id={ids.pasteHint} className="text-xs mt-1"
                style={{ color: pasteText.trim() && !parseResult.ok ? '#ff6b6b' : '#8b8fa3' }}>{pasteHint}</p>
              {/* Screen-reader-only and debounced: see PASTE_ANNOUNCE_DELAY_MS above. The
                  visible paragraph above updates every keystroke for sighted users; this one
                  only changes once typing has paused, so aria-live="polite" announces the
                  settled outcome instead of narrating every character typed. */}
              <p role="status" aria-live="polite" className="sr-only">{announcedPasteHint}</p>
            </div>
            <div>
              <label className={labelCls} htmlFor={ids.notes}>Notes</label>
              <textarea id={ids.notes} className={inputCls} style={{ ...inputSty, minHeight: 80, resize: 'vertical' }}
                value={notesInput} onChange={(e) => setNotesInput(e.target.value)}
                placeholder="Anything worth remembering about this table..." />
            </div>
            <div className="flex justify-end gap-3">
              {selectedSchema && (
                <button onClick={resetForm} className={`px-4 py-2 rounded-lg text-sm font-mono text-gray-400 hover:text-gray-200 hover:bg-white/5 ${FOCUS_RING}`}
                  style={{ border: '1px solid #2a2a3e' }}>Clear</button>
              )}
              <button onClick={handleSave} disabled={!canSave}
                className={`px-4 py-2 rounded-lg text-sm font-mono font-bold disabled:opacity-40 ${FOCUS_RING}`}
                style={{ background: '#00ff88', color: '#0a0a0f' }}>
                {saving ? 'Saving...' : selectedSchema ? 'Update Schema' : 'Save Schema'}
              </button>
            </div>
          </section>
        </div>
      </div>

      {deleteTarget && (
        <DeleteSchemaModal name={deleteTarget} deleting={deleting} onCancel={() => setDeleteTarget(null)} onConfirm={handleDeleteConfirm} />
      )}
      {collisionTarget && (
        <SaveCollisionModal name={trimmedName} existing={collisionTarget} saving={saving}
          onCancel={() => setCollisionTarget(null)} onConfirm={handleCollisionConfirm} />
      )}
      {importPreview && (
        <SchemaImportModal preview={importPreview} importing={importing} onCancel={() => setImportPreview(null)} onConfirm={confirmImport} />
      )}
    </div>
  );
}

export { SchemaView };
