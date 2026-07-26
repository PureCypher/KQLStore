import React, { useState } from 'react';
import { Trash2, Download, ChevronDown, X, Tag, Database } from 'lucide-react';
import { CATEGORIES, DEFENDER_TABLES, SENTINEL_TABLES } from '../constants.js';
import { useApp } from '../context/app.js';

const BulkActionBar = () => {
  const { handleBulkCategory, handleBulkDelete, handleBulkExport, handleBulkTable, selectedIds, setSelectedIds } = useApp();
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

export { BulkActionBar };
