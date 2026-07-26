import React from 'react';
import { X } from 'lucide-react';
import { useApp } from '../context/app.js';

const ImportPreviewModal = () => {
  const { confirmImport, importPreview, queries, setImportPreview } = useApp();
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

export { ImportPreviewModal };
