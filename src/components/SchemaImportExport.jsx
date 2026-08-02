// ---------------------------------------------------------------------------
// JSON export/import for the schema store, and the review modal that gates it.
//
// This is one of SchemaView's three separable responsibilities — the list + search, the
// name/paste/notes form, and this export/import block. It lives here so the view stays
// a view: the export/import logic is self-contained (state, handlers, the modal) and
// SchemaView just calls the hook and renders the modal when there is a preview.
//
// Import does not reuse ImportPreviewModal.jsx: that component reads confirmImport and
// `queries` off AppContext and diffs against the query domain via planImport, neither of
// which applies to a table_schemas row. What IS shared is the presentational chrome —
// ImportPreviewShell — over the same { index, name, status, reason } item shape, with
// the review-before-commit decision built locally against StorageAdapter.saveSchema.
// ---------------------------------------------------------------------------
import React, { useState, useRef, useId } from 'react';
import { StorageAdapter } from '../storage/adapter.js';
import { safeJsonParse } from '../lib/json.js';
import { ImportPreviewShell } from './ImportPreviewShell.jsx';
import { FOCUS_RING } from './a11y.jsx';

const IMPORT_STATUS_COLORS = { add: '#00ff88', update: '#00d4ff', error: '#ff4444' };
const IMPORT_STATUS_LABELS = { add: 'New', update: 'Update', error: 'Invalid' };

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

function SchemaImportModal({ preview, importing, onCancel, onConfirm }) {
  const summaryId = useId();
  const acceptedCount = preview.willAdd + preview.willUpdate;
  return (
    <ImportPreviewShell
      title="Import Schemas"
      items={preview.items}
      statusColors={IMPORT_STATUS_COLORS}
      statusLabels={IMPORT_STATUS_LABELS}
      listAriaLabel="Schemas in this import"
      onClose={onCancel}
      summary={(
        <div id={summaryId} className="flex gap-4 mb-4 text-xs">
          <span style={{ color: '#00ff88' }}>{preview.willAdd} new</span>
          <span style={{ color: '#00d4ff' }}>{preview.willUpdate} updated</span>
          <span style={{ color: '#ff4444' }}>{preview.willError} invalid</span>
          <span className="ml-auto text-gray-500">{preview.total} total</span>
        </div>
      )}
      footer={(
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
      )}
    />
  );
}

/**
 * The export/import unit: preview state, the file reader, the confirm loop, and the
 * export download. `load` is the caller's refetch (used to refresh the list after a
 * successful import); `addToast` and `setActionError` are the caller's feedback channels
 * (a failed write is durable via setActionError, not a toast — see SchemaView's comment
 * on actionError).
 */
function useSchemaImportExport({ schemas, load, addToast, setActionError }) {
  const [importPreview, setImportPreview] = useState(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef(null);

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
      // preview promised. That is durable, not a toast — see SchemaView's actionError.
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

  const dismissImport = () => setImportPreview(null);

  return { importPreview, importing, fileInputRef, handleExport, handleImportFile, confirmImport, dismissImport };
}

export { useSchemaImportExport, SchemaImportModal };
