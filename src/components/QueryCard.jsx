import React, { useState, useRef } from 'react';
import { Copy, Pencil, Trash2, Star, Clock, Layers, Square, CheckSquare } from 'lucide-react';
import { CATEGORY_COLORS, TABLE_STYLES } from '../constants.js';
import { getTableDisplayName, getTableGroup } from '../domain/tables.js';
import { CodeBlock } from './CodeBlock.jsx';
import { QueryDescription } from './QueryDescription.jsx';
import { useApp } from '../context/app.js';

const QueryCard = React.memo(({ query }) => {
  const { copyToClipboard, deleteQuery, duplicateQuery, selectedIds, selectedTags, setEditingQuery, setSelectedTags, toggleExpand, toggleFavorite, toggleSelect } = useApp();
  const isSelected = selectedIds.has(query.id);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const clickTimer = useRef(null);

  const handleNameClick = () => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
      copyToClipboard(query.query, query.id);
    } else {
      clickTimer.current = setTimeout(() => { clickTimer.current = null; toggleExpand(query.id); }, 250);
    }
  };

  return (
    <div className="rounded-xl overflow-hidden transition-all" style={{ background: '#12121a', border: `1px solid ${isSelected ? '#00d4ff' : '#1e1e2e'}` }}>
      <div className="flex items-start gap-3 p-4 pb-2">
        <button onClick={(e) => { e.stopPropagation(); toggleSelect(query.id); }} className="mt-0.5 shrink-0">
          {isSelected ? <CheckSquare size={16} style={{ color: '#00d4ff' }} /> : <Square size={16} className="text-gray-600 hover:text-gray-400" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-bold text-gray-200 cursor-pointer hover:underline decoration-gray-600 truncate" onClick={handleNameClick} title="Click to expand, double-click to copy">
              {query.name}
            </h3>
            <button onClick={() => toggleFavorite(query.id)} className="shrink-0">
              <Star size={14} fill={query.favorite ? '#ffcc00' : 'none'} style={{ color: query.favorite ? '#ffcc00' : '#3a3a4e' }} />
            </button>
          </div>
          {query.description && <QueryDescription description={query.description} />}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => copyToClipboard(query.query, query.id)} className="p-1.5 rounded-md hover:bg-white/5" title="Copy"><Copy size={14} className="text-gray-500 hover:text-gray-300" /></button>
          <button onClick={() => setEditingQuery(query)} className="p-1.5 rounded-md hover:bg-white/5" title="Edit"><Pencil size={14} className="text-gray-500 hover:text-gray-300" /></button>
          <button onClick={() => duplicateQuery(query)} className="p-1.5 rounded-md hover:bg-white/5" title="Duplicate"><Layers size={14} className="text-gray-500 hover:text-gray-300" /></button>
          {confirmDelete ? (
            <div className="flex items-center gap-1">
              <button onClick={() => { deleteQuery(query.id); setConfirmDelete(false); }}
                className="px-2 py-1 rounded text-xs font-mono" style={{ background: '#2a1010', color: '#ff4444', border: '1px solid #ff4444' }}>Delete</button>
              <button onClick={() => setConfirmDelete(false)} className="px-2 py-1 rounded text-xs font-mono text-gray-400 hover:text-gray-200">Cancel</button>
            </div>
          ) : (
            <button onClick={() => setConfirmDelete(true)} className="p-1.5 rounded-md hover:bg-white/5" title="Delete"><Trash2 size={14} className="text-gray-500 hover:text-red-400" /></button>
          )}
        </div>
      </div>
      <div className="px-4 pb-3"><CodeBlock query={query.query} queryId={query.id} /></div>
      <div className="px-4 pb-3 flex flex-wrap items-center gap-2 text-xs">
        {(query.tags || []).map((t) => (
          <button key={t} onClick={() => setSelectedTags((prev) => prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t])}
            className="px-2 py-0.5 rounded-full font-mono" style={{
              background: selectedTags.includes(t) ? '#00d4ff20' : '#1a1a2e',
              color: selectedTags.includes(t) ? '#00d4ff' : '#888',
              border: `1px solid ${selectedTags.includes(t) ? '#00d4ff' : '#2a2a3e'}`,
            }}>{t}</button>
        ))}
        <span className="ml-auto flex items-center gap-3 text-gray-600 flex-wrap">
          {query.table && (() => {
            const group = getTableGroup(query.table);
            const style = TABLE_STYLES[group];
            return (
              <span className="px-2 py-0.5 rounded font-mono text-xs" style={{ background: style.bg, color: style.text, border: `1px solid ${style.border}` }}>
                {getTableDisplayName(query.table)}
              </span>
            );
          })()}
          {(() => {
            const catColors = CATEGORY_COLORS[query.category];
            return catColors ? (
              <span className="px-2 py-0.5 rounded font-mono text-xs" style={{ background: catColors.bg, color: catColors.text, border: `1px solid ${catColors.border}` }}>
                {query.category}
              </span>
            ) : null;
          })()}
          {query.usageCount > 0 && <span className="flex items-center gap-1"><Copy size={10} />{query.usageCount}</span>}
          <span className="flex items-center gap-1"><Clock size={10} />{new Date(query.updated || query.created).toLocaleDateString()}</span>
        </span>
      </div>
    </div>
  );
});

export { QueryCard };
