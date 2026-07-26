import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import { SENTINEL_TABLES, DEFENDER_TABLES, ALL_KNOWN_TABLES } from '../constants.js';
import { getTableDisplayName } from '../domain/tables.js';

function TableSelector({ value, onChange }) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = search
    ? ALL_KNOWN_TABLES.filter(t => t.toLowerCase().includes(search.toLowerCase()))
    : ALL_KNOWN_TABLES;

  const sentinelFiltered = filtered.filter(t => SENTINEL_TABLES.includes(t));
  const defenderFiltered = filtered.filter(t => DEFENDER_TABLES.includes(t));

  const displayValue = value ? getTableDisplayName(value) : 'Select table...';

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(p => !p)}
        className="w-full px-3 py-2 rounded-lg font-mono text-sm text-left flex items-center justify-between"
        style={{ background: '#1a1a2e', border: '1px solid #2a2a3e', color: value ? '#e0e0e0' : '#666' }}>
        <span className="truncate">{displayValue}</span>
        <ChevronDown size={14} className="text-gray-500 shrink-0" />
      </button>
      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 rounded-lg overflow-hidden z-10 shadow-xl"
          style={{ background: '#1a1a2e', border: '1px solid #2a2a3e', maxHeight: 280, overflowY: 'auto' }}>
          <div className="p-2 sticky top-0" style={{ background: '#1a1a2e' }}>
            <input type="text" placeholder="Search tables..." value={search} onChange={e => setSearch(e.target.value)}
              className="w-full px-2 py-1.5 rounded text-xs font-mono outline-none"
              style={{ background: '#12121a', border: '1px solid #2a2a3e', color: '#e0e0e0' }}
              autoFocus />
          </div>
          {sentinelFiltered.length > 0 && (
            <div>
              <div className="px-3 py-1 text-xs font-bold" style={{ color: '#e5c07b' }}>Sentinel</div>
              {sentinelFiltered.map(t => (
                <button key={t} type="button" onClick={() => { onChange(t); setOpen(false); setSearch(''); }}
                  className="w-full px-3 py-1.5 text-xs text-left hover:bg-white/5"
                  style={{ color: value === t ? '#e5c07b' : '#aaa' }}>{t}</button>
              ))}
            </div>
          )}
          {defenderFiltered.length > 0 && (
            <div>
              <div className="px-3 py-1 text-xs font-bold" style={{ color: '#61afef' }}>Defender</div>
              {defenderFiltered.map(t => (
                <button key={t} type="button" onClick={() => { onChange(t); setOpen(false); setSearch(''); }}
                  className="w-full px-3 py-1.5 text-xs text-left hover:bg-white/5"
                  style={{ color: value === t ? '#61afef' : '#aaa' }}>{t}</button>
              ))}
            </div>
          )}
          <div>
            <div className="px-3 py-1 text-xs font-bold" style={{ color: '#8b8fa3' }}>Custom</div>
            <button type="button" onClick={() => { onChange('Custom'); setOpen(false); setSearch(''); }}
              className="w-full px-3 py-1.5 text-xs text-left hover:bg-white/5"
              style={{ color: value === 'Custom' ? '#8b8fa3' : '#aaa' }}>Custom</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Main Application

export { TableSelector };
