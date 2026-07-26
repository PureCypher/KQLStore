import React, { useId, useMemo } from 'react';
import { X } from 'lucide-react';
import { useApp } from '../context/app.js';
import { planImport, readImportFile } from '../storage/useKQLStorage.js';
import { FOCUS_RING } from './a11y.jsx';
import { Modal } from './Modal.jsx';

// ---------------------------------------------------------------------------
// Import preview.
//
// The counts and the row list come from the preview App computed when the file was
// opened. What App cannot tell the user is what an id collision actually means: it
// reports every one of them as "Duplicate ID", which is why a shared detection pack could
// only ever be received once — version 2 of a rule looked identical to a mistake.
//
// This dialog re-reads the same file through planImport(), the function the import itself
// uses, and splits those collisions three ways: the stored copy is older and would be
// overwritten (update), the stored copy is the newer one (older), or nothing would change
// (identical). Updates list the fields that move, because a detection engineer asked to
// bulk-overwrite rules they own is entitled to see whether the incoming pack rewrites the
// query body or only bumps a reference URL.
//
// Two commit paths, never one: the default button keeps the insert-only behaviour it has
// always had, and overwriting is a separate, explicitly labelled action.
// ---------------------------------------------------------------------------

const STATUS_COLORS = {
  add: '#00ff88',
  skip: '#888',
  duplicate: '#ffcc00',
  error: '#ff4444',
  update: '#00d4ff',
  older: '#888',
  identical: '#888',
};

const STATUS_LABELS = {
  add: 'New',
  skip: 'Skip',
  duplicate: 'Duplicate',
  error: 'Invalid',
  update: 'Update',
  older: 'Older',
  identical: 'Same',
};

// Enough field names to judge the change at a glance; the full list stays in the tooltip.
const FIELDS_SHOWN = 4;

/** "name, query, tags +2 more" — a diff summary that fits on one row. */
function describeFields(fields) {
  if (!fields || fields.length === 0) return '';
  const shown = fields.slice(0, FIELDS_SHOWN).join(', ');
  return fields.length > FIELDS_SHOWN ? `${shown} +${fields.length - FIELDS_SHOWN} more` : shown;
}

const ImportPreviewModal = () => {
  const { confirmImport, importPreview, setImportPreview, queries } = useApp();
  // Hooks before the early return — see QueryEditorModal for the same constraint.
  const titleId = useId();
  const summaryId = useId();
  const collisionsId = useId();

  const text = importPreview ? importPreview.text : null;
  // Re-planned rather than passed in, because the store can have moved since the file was
  // opened. A file this build cannot read leaves plan null and the dialog renders exactly
  // as it did before — the preview degrades, it never blocks the import.
  const plan = useMemo(() => {
    if (typeof text !== 'string') return null;
    const file = readImportFile(text);
    if (file.error) return null;
    return planImport(file.queries, queries || []);
  }, [text, queries]);

  if (!importPreview) return null;
  const { preview } = importPreview;
  const counts = plan ? plan.counts : { update: 0, older: 0, identical: 0 };
  const collisions = counts.update + counts.older + counts.identical;

  const updateLabel = preview.willAdd > 0
    ? `Import ${preview.willAdd} + update ${counts.update}`
    : `Update ${counts.update} existing`;

  return (
    <Modal
      labelledBy={titleId}
      onClose={() => setImportPreview(null)}
      backdropClassName="z-[80] items-start justify-center pt-8 pb-8 overflow-y-auto"
      className="rounded-xl p-6 font-mono w-full max-w-xl mx-4"
      style={{ background: '#12121a', border: '1px solid #2a2a3e' }}
    >
      <div className="flex justify-between items-center mb-4">
        <h2 id={titleId} className="text-lg font-bold" style={{ color: '#00ff88' }}>Import Preview</h2>
        <button onClick={() => setImportPreview(null)} className={`p-1 rounded hover:bg-white/10 ${FOCUS_RING}`}
          aria-label="Close import preview" title="Close">
          <X size={16} className="text-gray-400" aria-hidden="true" />
        </button>
      </div>
      {/* The counts are the decision the user is being asked to make, so they are attached
          to the confirm button as its description rather than left as four coloured
          numbers floating above it. Each already carries its own word, so colour is not
          the only thing distinguishing them (WCAG 1.4.1). */}
      <div id={summaryId} className="flex gap-4 mb-2 text-xs">
        <span style={{ color: '#00ff88' }}>{preview.willAdd} new</span>
        <span style={{ color: '#888' }}>{preview.willSkip} skipped</span>
        <span style={{ color: '#ffcc00' }}>{preview.willDuplicate} duplicates</span>
        <span style={{ color: '#ff4444' }}>{preview.willError} invalid</span>
        <span className="ml-auto text-gray-500">{preview.total} total</span>
      </div>
      {collisions > 0 && (
        <div id={collisionsId} className="flex gap-4 mb-4 text-xs">
          <span style={{ color: '#00d4ff' }}>{counts.update} newer, can update</span>
          <span style={{ color: '#888' }}>{counts.older} older than stored</span>
          <span style={{ color: '#888' }}>{counts.identical} unchanged</span>
        </div>
      )}
      <ul aria-label="Queries in this import" className={`max-h-64 overflow-y-auto space-y-1 mb-4 ${collisions > 0 ? '' : 'mt-2'}`}
        style={{ background: '#0a0a0f', borderRadius: 8, padding: 8, border: '1px solid #1a1a2e' }}>
        {preview.items.map((item, i) => {
          // Only the collision rows are re-labelled. Everything else is App's verdict,
          // so the two never disagree about the same row.
          const detail = plan && item.status === 'skip' ? plan.byIndex.get(item.index) : undefined;
          const status = detail ? detail.status : item.status;
          const fields = detail ? describeFields(detail.changedFields) : '';
          const reason = fields || (detail ? detail.reason : item.reason);
          return (
            <li key={i} className="flex items-center gap-2 text-xs py-1 px-2 rounded" style={{ background: i % 2 === 0 ? 'transparent' : '#12121a' }}>
              <span className="w-14 shrink-0 text-right" style={{ color: STATUS_COLORS[status] }}>{STATUS_LABELS[status]}</span>
              <span className="truncate text-gray-300 flex-1">{item.name}</span>
              {reason && (
                <span className="text-gray-600 shrink-0 text-right truncate max-w-56"
                  title={detail && detail.changedFields.length > 0 ? `Changes: ${detail.changedFields.join(', ')}` : undefined}>
                  {reason}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {preview.willAdd === 0 && counts.update === 0 ? (
        <div className="text-center text-gray-500 text-sm mb-4">No new queries to import.</div>
      ) : null}
      {counts.update > 0 && (
        <p className="text-xs text-gray-500 mb-3">
          Updating overwrites the stored copy of the {counts.update === 1 ? 'query' : 'queries'} marked
          <span style={{ color: '#00d4ff' }}> Update</span>. Only queries whose incoming copy is newer are
          overwritten; your usage counts are kept.
        </p>
      )}
      <div className="flex justify-end gap-3">
        <button onClick={() => setImportPreview(null)}
          className={`px-4 py-2 rounded-lg text-sm font-mono text-gray-400 hover:text-gray-200 hover:bg-white/5 ${FOCUS_RING}`}
          style={{ border: '1px solid #2a2a3e' }}>Cancel</button>
        {/* The default action is unchanged and still insert-only — the mode is passed
            explicitly so nothing about it depends on a default further down the stack. */}
        <button onClick={() => confirmImport({ mode: 'insert' })}
          disabled={preview.willAdd === 0}
          aria-describedby={summaryId}
          className={`px-4 py-2 rounded-lg text-sm font-mono font-bold disabled:opacity-40 ${FOCUS_RING}`}
          style={{ background: preview.willAdd > 0 ? '#00ff88' : '#333', color: '#0a0a0f' }}>
          Import {preview.willAdd} {preview.willAdd === 1 ? 'Query' : 'Queries'}
        </button>
        {counts.update > 0 && (
          <button onClick={() => confirmImport({ mode: 'upsert' })}
            aria-describedby={collisionsId}
            className={`px-4 py-2 rounded-lg text-sm font-mono font-bold ${FOCUS_RING}`}
            style={{ background: '#00d4ff', color: '#0a0a0f' }}>
            {updateLabel}
          </button>
        )}
      </div>
    </Modal>
  );
};

export { ImportPreviewModal };
