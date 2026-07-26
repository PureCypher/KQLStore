import React, { useEffect, useState, useRef } from 'react';
import { Copy, Pencil, Trash2, Star, Clock, Layers, Square, CheckSquare } from 'lucide-react';
import { CATEGORY_COLORS, TABLE_STYLES } from '../constants.js';
import { getTableDisplayName, getTableGroup } from '../domain/tables.js';
import { CodeBlock } from './CodeBlock.jsx';
import { QueryDescription } from './QueryDescription.jsx';
import { useApp } from '../context/app.js';
import { FOCUS_RING } from './a11y.jsx';

const QueryCard = React.memo(({ query }) => {
  const { copyToClipboard, deleteQuery, duplicateQuery, selectedIds, selectedTags, setEditingQuery, setSelectedTags, toggleExpand, toggleFavorite, toggleSelect } = useApp();
  const isSelected = selectedIds.has(query.id);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const clickTimer = useRef(null);
  const confirmRef = useRef(null);

  // Arming the confirmation unmounts the button that was focused, which drops focus to
  // <body> and leaves a keyboard user with no indication that a destructive prompt just
  // appeared. Moving focus onto the confirm button makes it both announced and operable.
  useEffect(() => {
    if (confirmDelete) confirmRef.current?.focus();
  }, [confirmDelete]);

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
        {/* A button drawn as a tick box is a checkbox to everyone except assistive
            technology, which was told only "button" and never whether it was ticked. */}
        <button onClick={(e) => { e.stopPropagation(); toggleSelect(query.id); }}
          role="checkbox" aria-checked={isSelected}
          aria-label={`Select ${query.name}`}
          title={isSelected ? 'Deselect' : 'Select'}
          className={`mt-0.5 shrink-0 rounded ${FOCUS_RING}`}>
          {isSelected ? <CheckSquare size={16} style={{ color: '#00d4ff' }} aria-hidden="true" /> : <Square size={16} className="text-gray-600 hover:text-gray-400" aria-hidden="true" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {/* The heading was clickable but not focusable, so expanding a card was
                mouse-only (WCAG 2.1.1). The control is a real button now and the heading
                stays a heading. Double-click-to-copy is inherently a pointer gesture; the
                Copy button on the right is the keyboard route to the same thing. */}
            <h2 className="font-bold text-gray-200 truncate">
              <button onClick={handleNameClick}
                className={`text-left truncate max-w-full hover:underline decoration-gray-600 rounded ${FOCUS_RING}`}
                title="Click to expand, double-click to copy">
                {query.name}
              </button>
            </h2>
            <button onClick={() => toggleFavorite(query.id)}
              aria-pressed={query.favorite === true}
              aria-label={`Favorite ${query.name}`}
              title={query.favorite ? 'Remove from favorites' : 'Add to favorites'}
              className={`shrink-0 rounded ${FOCUS_RING}`}>
              <Star size={14} fill={query.favorite ? '#ffcc00' : 'none'} style={{ color: query.favorite ? '#ffcc00' : '#3a3a4e' }} aria-hidden="true" />
            </button>
          </div>
          {query.description && <QueryDescription description={query.description} />}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* Every one of these is an icon on its own and every card renders the same four,
              so the name has to carry the query as well as the verb — otherwise the list
              reads as "Copy, Edit, Duplicate, Delete" fifty times with nothing to tell the
              rows apart. */}
          <button onClick={() => copyToClipboard(query.query, query.id)} className={`p-1.5 rounded-md hover:bg-white/5 ${FOCUS_RING}`}
            aria-label={`Copy ${query.name}`} title="Copy"><Copy size={14} className="text-gray-500 hover:text-gray-300" aria-hidden="true" /></button>
          <button onClick={() => setEditingQuery(query)} className={`p-1.5 rounded-md hover:bg-white/5 ${FOCUS_RING}`}
            aria-label={`Edit ${query.name}`} title="Edit"><Pencil size={14} className="text-gray-500 hover:text-gray-300" aria-hidden="true" /></button>
          <button onClick={() => duplicateQuery(query)} className={`p-1.5 rounded-md hover:bg-white/5 ${FOCUS_RING}`}
            aria-label={`Duplicate ${query.name}`} title="Duplicate"><Layers size={14} className="text-gray-500 hover:text-gray-300" aria-hidden="true" /></button>
          {confirmDelete ? (
            <div className="flex items-center gap-1">
              <button ref={confirmRef} onClick={() => { deleteQuery(query.id); setConfirmDelete(false); }}
                aria-label={`Confirm deletion of ${query.name}`}
                className={`px-2 py-1 rounded text-xs font-mono ${FOCUS_RING}`} style={{ background: '#2a1010', color: '#ff4444', border: '1px solid #ff4444' }}>Delete</button>
              <button onClick={() => setConfirmDelete(false)}
                aria-label={`Keep ${query.name}`}
                className={`px-2 py-1 rounded text-xs font-mono text-gray-400 hover:text-gray-200 ${FOCUS_RING}`}>Cancel</button>
            </div>
          ) : (
            <button onClick={() => setConfirmDelete(true)} className={`p-1.5 rounded-md hover:bg-white/5 ${FOCUS_RING}`}
              aria-label={`Delete ${query.name}`} title="Delete"><Trash2 size={14} className="text-gray-500 hover:text-red-400" aria-hidden="true" /></button>
          )}
        </div>
      </div>
      <div className="px-4 pb-3"><CodeBlock query={query.query} queryId={query.id} /></div>
      <div className="px-4 pb-3 flex flex-wrap items-center gap-2 text-xs">
        {(query.tags || []).map((t) => (
          <button key={t} onClick={() => setSelectedTags((prev) => prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t])}
            aria-pressed={selectedTags.includes(t)}
            aria-label={`Filter by tag ${t}`}
            className={`px-2 py-0.5 rounded-full font-mono ${FOCUS_RING}`} style={{
              background: selectedTags.includes(t) ? '#00d4ff20' : '#1a1a2e',
              color: selectedTags.includes(t) ? '#00d4ff' : '#888',
              border: `1px solid ${selectedTags.includes(t) ? '#00d4ff' : '#2a2a3e'}`,
            }}>{t}</button>
        ))}
        {/* text-gray-600 measured at 2.46:1 on the card surface; the table, category,
            usage count and date in this row are all information, not decoration. */}
        <span className="ml-auto flex items-center gap-3 text-gray-400 flex-wrap">
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
          {/* An icon and a bare number reads as "4" with no clue what it counts; the
              screen-reader-only words supply the noun without adding visual clutter. */}
          {query.usageCount > 0 && (
            <span className="flex items-center gap-1">
              <Copy size={10} aria-hidden="true" />
              <span className="sr-only">Copied </span>{query.usageCount}<span className="sr-only"> times</span>
            </span>
          )}
          <span className="flex items-center gap-1">
            <Clock size={10} aria-hidden="true" />
            <span className="sr-only">Last updated </span>{new Date(query.updated || query.created).toLocaleDateString()}
          </span>
        </span>
      </div>
    </div>
  );
});

export { QueryCard };
