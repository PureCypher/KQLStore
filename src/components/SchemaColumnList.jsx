// ---------------------------------------------------------------------------
// The stored columns of one schema, which until now the app could not show at all.
//
// The store's whole point is answering "does this table have that column, and what type
// is it" without opening the portal — but the view only ever displayed a count, so the
// 264 scraped schemas were reference data nobody could read. This renders them.
//
// Filtering is local and seeded from the list search, so searching a column name and
// clicking the table that matched lands you on that column instead of on 95 of them.
// ---------------------------------------------------------------------------
import React, { useId, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { FOCUS_RING } from './a11y.jsx';

const SchemaColumnList = ({ columns, initialFilter = '' }) => {
  const [filter, setFilter] = useState(initialFilter);
  const baseId = useId();
  const filterId = `${baseId}-column-filter`;

  const shown = useMemo(() => {
    const term = filter.trim().toLowerCase();
    if (!term) return columns;
    return columns.filter((c) => c.name.toLowerCase().includes(term));
  }, [columns, filter]);

  return (
    <div className="rounded-lg" style={{ background: '#0a0a0f', border: '1px solid #1e1e2e' }}>
      <div className="flex items-center gap-2 px-2 py-1.5" style={{ borderBottom: '1px solid #1e1e2e' }}>
        <label htmlFor={filterId} className="sr-only">Filter columns</label>
        <div className="relative flex-1">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-600" aria-hidden="true" />
          <input id={filterId} value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter columns…" spellCheck={false}
            className={`w-full pl-6 pr-2 py-1 rounded text-xs text-gray-200 outline-hidden ${FOCUS_RING}`}
            style={{ background: '#12121a', border: '1px solid #2a2a3e' }} />
        </div>
        <span className="text-xs text-gray-500 shrink-0" role="status">
          {filter.trim() ? `${shown.length} of ${columns.length}` : `${columns.length} columns`}
        </span>
      </div>

      {shown.length === 0 ? (
        <p className="text-xs text-gray-500 px-3 py-3">No column matches that filter.</p>
      ) : (
        <ul className="max-h-56 overflow-y-auto py-1">
          {shown.map((c) => (
            <li key={c.name} className="flex items-baseline gap-2 px-3 py-0.5 text-xs">
              <span className="text-gray-200 font-mono truncate" title={c.name}>{c.name}</span>
              <span className="text-gray-600 font-mono ml-auto shrink-0">{c.type}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export { SchemaColumnList };
