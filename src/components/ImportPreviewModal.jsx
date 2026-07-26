import React, { useId } from 'react';
import { X } from 'lucide-react';
import { useApp } from '../context/app.js';
import { FOCUS_RING } from './a11y.jsx';
import { Modal } from './Modal.jsx';

const ImportPreviewModal = () => {
  const { confirmImport, importPreview, setImportPreview } = useApp();
  // Hooks before the early return — see QueryEditorModal for the same constraint.
  const titleId = useId();
  const summaryId = useId();
  if (!importPreview) return null;
  const { preview } = importPreview;
  const statusColors = { add: '#00ff88', skip: '#888', duplicate: '#ffcc00', error: '#ff4444' };
  const statusLabels = { add: 'New', skip: 'Skip', duplicate: 'Duplicate', error: 'Invalid' };
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
      <div id={summaryId} className="flex gap-4 mb-4 text-xs">
        <span style={{ color: '#00ff88' }}>{preview.willAdd} new</span>
        <span style={{ color: '#888' }}>{preview.willSkip} skipped</span>
        <span style={{ color: '#ffcc00' }}>{preview.willDuplicate} duplicates</span>
        <span style={{ color: '#ff4444' }}>{preview.willError} invalid</span>
        <span className="ml-auto text-gray-500">{preview.total} total</span>
      </div>
      <ul aria-label="Queries in this import" className="max-h-64 overflow-y-auto space-y-1 mb-4"
        style={{ background: '#0a0a0f', borderRadius: 8, padding: 8, border: '1px solid #1a1a2e' }}>
        {preview.items.map((item, i) => (
          <li key={i} className="flex items-center gap-2 text-xs py-1 px-2 rounded" style={{ background: i % 2 === 0 ? 'transparent' : '#12121a' }}>
            <span className="w-14 shrink-0 text-right" style={{ color: statusColors[item.status] }}>{statusLabels[item.status]}</span>
            <span className="truncate text-gray-300 flex-1">{item.name}</span>
            {item.reason && <span className="text-gray-600 shrink-0 text-right truncate max-w-40">{item.reason}</span>}
          </li>
        ))}
      </ul>
      {preview.willAdd === 0 ? (
        <div className="text-center text-gray-500 text-sm mb-4">No new queries to import.</div>
      ) : null}
      <div className="flex justify-end gap-3">
        <button onClick={() => setImportPreview(null)}
          className={`px-4 py-2 rounded-lg text-sm font-mono text-gray-400 hover:text-gray-200 hover:bg-white/5 ${FOCUS_RING}`}
          style={{ border: '1px solid #2a2a3e' }}>Cancel</button>
        <button onClick={confirmImport}
          disabled={preview.willAdd === 0}
          aria-describedby={summaryId}
          className={`px-4 py-2 rounded-lg text-sm font-mono font-bold disabled:opacity-40 ${FOCUS_RING}`}
          style={{ background: preview.willAdd > 0 ? '#00ff88' : '#333', color: '#0a0a0f' }}>
          Import {preview.willAdd} {preview.willAdd === 1 ? 'Query' : 'Queries'}
        </button>
      </div>
    </Modal>
  );
};

export { ImportPreviewModal };
