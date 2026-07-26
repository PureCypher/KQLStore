import React from 'react';
import { Search, Star, ChevronDown, ChevronUp, X } from 'lucide-react';
import { CATEGORIES, CATEGORY_COLORS, DEFENDER_TABLES, SENTINEL_TABLES, SORT_OPTIONS, TABLE_STYLES } from '../constants.js';
import { getTableDisplayName, getTableGroup } from '../domain/tables.js';
import { useApp } from '../context/app.js';

const SidebarContent = () => {
  const { allTags, categoryCounts, clearFilters, hasActiveFilters, queries, searchRef, searchTerm, selectedCategory, selectedTable, selectedTags, setSearchTerm, setSelectedCategory, setSelectedTable, setSelectedTags, setShowFavoritesOnly, setSortBy, setSortDir, setTableFilterExpanded, showFavoritesOnly, sortBy, sortDir, stats, tableFilterExpanded } = useApp();
  return (
  <div className="flex flex-col h-full overflow-y-auto p-4 space-y-5 font-mono text-sm" style={{ background: '#0d0d14' }}>
    <div className="relative">
      <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
      <input ref={searchRef} type="text" placeholder="Search queries..."
        className="w-full pl-9 pr-8 py-2 rounded-lg text-sm text-gray-200 outline-none focus:ring-1 focus:ring-[#00ff88]"
        style={{ background: '#1a1a2e', border: '1px solid #2a2a3e' }}
        value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
      {searchTerm && <button onClick={() => setSearchTerm('')} className="absolute right-2 top-1/2 -translate-y-1/2"><X size={14} className="text-gray-500 hover:text-gray-300" /></button>}
    </div>

    <div>
      <h4 className="text-xs text-gray-600 uppercase tracking-wider mb-2">Categories</h4>
      <div className="space-y-0.5">
        {CATEGORIES.map((c) => {
          const colors = CATEGORY_COLORS[c];
          return (
            <button key={c} onClick={() => setSelectedCategory(selectedCategory === c ? null : c)}
              className={`w-full flex justify-between items-center px-3 py-1.5 rounded-md text-left text-xs transition-colors ${selectedCategory === c ? '' : 'hover:bg-white/5'}`}
              style={selectedCategory === c ? { background: colors.bg, color: colors.text } : { color: '#aaa' }}>
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full" style={{ background: colors.text }} />
                {c}
              </span>
              <span className="text-gray-600">{categoryCounts[c] || 0}</span>
            </button>
          );
        })}
      </div>
    </div>

    <div>
      <h4 className="text-xs text-gray-600 uppercase tracking-wider mb-2">Tables</h4>
      {['sentinel', 'defender', 'custom'].map(group => {
        const groupStyle = TABLE_STYLES[group];
        const groupLabel = group.charAt(0).toUpperCase() + group.slice(1);
        const tables = group === 'sentinel' ? SENTINEL_TABLES : group === 'defender' ? DEFENDER_TABLES : [];
        const customTables = group === 'custom'
          ? [...new Set(queries.filter(q => getTableGroup(q.table) === 'custom').map(q => q.table))]
          : [];
        const tablesToShow = group === 'custom' ? customTables : tables;
        const groupCount = stats.byTableGroup[group] || 0;
        if (groupCount === 0 && group === 'custom') return null;

        return (
          <div key={group} className="mb-2">
            <button onClick={() => setTableFilterExpanded(p => ({ ...p, [group]: !p[group] }))}
              className="w-full flex items-center justify-between px-2 py-1 text-xs rounded hover:bg-white/5"
              style={{ color: groupStyle.text }}>
              <span className="flex items-center gap-1.5">
                {tableFilterExpanded[group] ? <ChevronDown size={10} /> : <ChevronUp size={10} />}
                {groupLabel}
              </span>
              <span className="text-gray-600">{groupCount}</span>
            </button>
            {tableFilterExpanded[group] && tablesToShow.length > 0 && (
              <div className="ml-2 space-y-0.5 mt-0.5">
                {tablesToShow.map(t => {
                  const displayName = getTableDisplayName(t);
                  const count = stats.byTable[displayName] || 0;
                  if (count === 0) return null;
                  return (
                    <button key={t} onClick={() => setSelectedTable(selectedTable === t ? null : t)}
                      className="w-full flex justify-between items-center px-2 py-1 rounded text-xs hover:bg-white/5"
                      style={selectedTable === t ? { background: groupStyle.bg, color: groupStyle.text } : { color: '#888' }}>
                      <span className="truncate">{displayName}</span>
                      <span className="text-gray-600 shrink-0 ml-2">{count}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>

    {allTags.length > 0 && (
      <div>
        <h4 className="text-xs text-gray-600 uppercase tracking-wider mb-2">Tags</h4>
        <div className="flex flex-wrap gap-1.5">
          {allTags.map(([tag]) => (
            <button key={tag} onClick={() => setSelectedTags((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag])}
              className="px-2 py-0.5 rounded-full text-xs transition-colors"
              style={selectedTags.includes(tag)
                ? { background: '#00d4ff20', color: '#00d4ff', border: '1px solid #00d4ff' }
                : { background: '#1a1a2e', color: '#777', border: '1px solid #2a2a3e' }}>{tag}</button>
          ))}
        </div>
      </div>
    )}

    <button onClick={() => setShowFavoritesOnly((p) => !p)}
      className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs w-full transition-colors"
      style={showFavoritesOnly
        ? { background: '#ffcc0015', color: '#ffcc00', border: '1px solid #ffcc00' }
        : { background: '#1a1a2e', color: '#888', border: '1px solid #2a2a3e' }}>
      <Star size={12} fill={showFavoritesOnly ? '#ffcc00' : 'none'} style={{ color: showFavoritesOnly ? '#ffcc00' : '#888' }} />Favorites only
    </button>

    <div>
      <h4 className="text-xs text-gray-600 uppercase tracking-wider mb-2">Sort by</h4>
      <div className="space-y-0.5">
        {SORT_OPTIONS.map((opt) => (
          <button key={opt.value} onClick={() => {
            if (sortBy === opt.value) setSortDir((p) => p === 'asc' ? 'desc' : 'asc');
            else { setSortBy(opt.value); setSortDir('desc'); }
          }}
            className="w-full flex justify-between items-center px-3 py-1.5 rounded-md text-xs text-left transition-colors"
            style={sortBy === opt.value ? { background: '#1a1a2e', color: '#00ff88' } : { color: '#888' }}>
            <span>{opt.label}</span>
            {sortBy === opt.value && <span className="text-gray-500">{sortDir === 'asc' ? '\u2191' : '\u2193'}</span>}
          </button>
        ))}
      </div>
    </div>

    {hasActiveFilters && (
      <button onClick={clearFilters} className="px-3 py-2 rounded-lg text-xs w-full" style={{ background: '#1a1a2e', color: '#ff4444', border: '1px solid #2a2a3e' }}>
        Clear all filters
      </button>
    )}
  </div>
);
};

export { SidebarContent };
