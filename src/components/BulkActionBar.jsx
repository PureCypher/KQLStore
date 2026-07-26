import React, { useId, useState } from 'react';
import { Trash2, Download, ChevronDown, X, Tag, Database } from 'lucide-react';
import { CATEGORIES, DEFENDER_TABLES, SENTINEL_TABLES } from '../constants.js';
import { useApp } from '../context/app.js';
import { FOCUS_RING } from './a11y.jsx';

const BulkActionBar = () => {
  const { handleBulkCategory, handleBulkDelete, handleBulkExport, handleBulkTable, selectedIds, setSelectedIds } = useApp();
  // Hooks before the early return — see QueryEditorModal for the same constraint.
  const [showCatMenu, setShowCatMenu] = useState(false);
  const [showTableMenu, setShowTableMenu] = useState(false);
  const baseId = useId();
  const catMenuId = `${baseId}-categories`;
  const tableMenuId = `${baseId}-tables`;
  if (selectedIds.size === 0) return null;
  const count = selectedIds.size;
  const noun = count === 1 ? 'query' : 'queries';
  return (
    // A labelled group rather than a bare div: this bar appears out of nowhere at the
    // bottom of the viewport and its controls act on a selection made elsewhere, so it
    // needs to announce what it is and what it is acting on.
    <div role="group" aria-label={`Bulk actions for ${count} selected ${noun}`}
      className="fixed bottom-16 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-5 py-3 rounded-xl shadow-2xl font-mono text-sm"
      style={{ background: '#1a1a2e', border: '1px solid #2a2a3e' }}>
      <span style={{ color: '#00d4ff' }}>{count} selected</span>
      <button onClick={handleBulkDelete} className={`px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5 ${FOCUS_RING}`}
        aria-label={`Delete ${count} selected ${noun}`}
        style={{ background: '#2a1010', color: '#ff4444', border: '1px solid #ff4444' }}><Trash2 size={12} aria-hidden="true" />Delete</button>
      <button onClick={handleBulkExport} className={`px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5 ${FOCUS_RING}`}
        aria-label={`Export ${count} selected ${noun}`}
        style={{ background: '#102a10', color: '#00ff88', border: '1px solid #00ff88' }}><Download size={12} aria-hidden="true" />Export</button>
      <div className="relative">
        <button onClick={() => { setShowCatMenu((p) => !p); setShowTableMenu(false); }}
          aria-expanded={showCatMenu} aria-controls={showCatMenu ? catMenuId : undefined}
          className={`px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5 ${FOCUS_RING}`}
          style={{ background: '#101a2a', color: '#00d4ff', border: '1px solid #00d4ff' }}><Tag size={12} aria-hidden="true" />Category <ChevronDown size={10} aria-hidden="true" /></button>
        {showCatMenu && (
          <div id={catMenuId} role="group" aria-label="Set category"
            className="absolute bottom-full left-0 mb-2 rounded-lg py-1 shadow-xl min-w-40" style={{ background: '#1a1a2e', border: '1px solid #2a2a3e' }}>
            {CATEGORIES.map((c) => (
              <button key={c} onClick={() => { handleBulkCategory(c); setShowCatMenu(false); }}
                className={`block w-full px-4 py-1.5 text-xs text-left text-gray-400 hover:text-white hover:bg-white/5 ${FOCUS_RING}`}>{c}</button>
            ))}
          </div>
        )}
      </div>
      <div className="relative">
        <button onClick={() => { setShowTableMenu((p) => !p); setShowCatMenu(false); }}
          aria-expanded={showTableMenu} aria-controls={showTableMenu ? tableMenuId : undefined}
          className={`px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5 ${FOCUS_RING}`}
          style={{ background: '#1a1a20', color: '#e5c07b', border: '1px solid #e5c07b' }}><Database size={12} aria-hidden="true" />Table <ChevronDown size={10} aria-hidden="true" /></button>
        {showTableMenu && (
          <div id={tableMenuId} role="group" aria-label="Set table"
            className="absolute bottom-full left-0 mb-2 rounded-lg py-1 shadow-xl min-w-48 max-h-64 overflow-y-auto" style={{ background: '#1a1a2e', border: '1px solid #2a2a3e' }}>
            <div className="px-3 py-1 text-xs font-bold" style={{ color: '#e5c07b' }}>Sentinel</div>
            {SENTINEL_TABLES.map((t) => (
              <button key={t} onClick={() => { handleBulkTable(t); setShowTableMenu(false); }}
                className={`block w-full px-4 py-1.5 text-xs text-left text-gray-400 hover:text-white hover:bg-white/5 ${FOCUS_RING}`}>{t}</button>
            ))}
            <div className="px-3 py-1 text-xs font-bold mt-1" style={{ color: '#61afef' }}>Defender</div>
            {DEFENDER_TABLES.map((t) => (
              <button key={t} onClick={() => { handleBulkTable(t); setShowTableMenu(false); }}
                className={`block w-full px-4 py-1.5 text-xs text-left text-gray-400 hover:text-white hover:bg-white/5 ${FOCUS_RING}`}>{t}</button>
            ))}
            <div className="px-3 py-1 text-xs font-bold mt-1" style={{ color: '#8b8fa3' }}>Custom</div>
            <button onClick={() => { handleBulkTable('Custom'); setShowTableMenu(false); }}
              className={`block w-full px-4 py-1.5 text-xs text-left text-gray-400 hover:text-white hover:bg-white/5 ${FOCUS_RING}`}>Custom</button>
          </div>
        )}
      </div>
      <button onClick={() => setSelectedIds(new Set())} className={`p-1.5 rounded-md hover:bg-white/10 ${FOCUS_RING}`}
        aria-label="Clear selection" title="Clear selection"><X size={14} className="text-gray-400" aria-hidden="true" /></button>
    </div>
  );
};

export { BulkActionBar };
