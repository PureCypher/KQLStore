// ---------------------------------------------------------------------------
// Shared rendering harness for the component suites.
//
// The shell components read everything they need from AppContext rather than from
// props, so mounting one in isolation means standing up a provider with the whole
// contract present. A missing key does not throw — it renders `undefined` into the
// tree and the assertion fails somewhere unrelated — so the default value below is
// deliberately exhaustive and each suite overrides only the slice it exercises.
//
// JSX is avoided on purpose. vitest.config.js collects `src/**/__tests__/**/*.test.js`
// and Vite's default esbuild loader does not parse JSX out of a .js file, so these
// files build their trees with React.createElement.
// ---------------------------------------------------------------------------
import React from 'react';
import { render } from '@testing-library/react';
import { AppContext } from '../../context/app.js';

const h = React.createElement;

const noop = () => {};

/** Every field any hoisted shell component reads, with inert defaults. */
function makeAppValue(overrides = {}) {
  return {
    toasts: [],
    showKeyboardHelp: false,
    setShowKeyboardHelp: noop,
    editingQuery: null,
    setEditingQuery: noop,
    saveQuery: noop,
    copyToClipboard: noop,
    deleteQuery: noop,
    duplicateQuery: noop,
    toggleFavorite: noop,
    toggleExpand: noop,
    toggleSelect: noop,
    selectedIds: new Set(),
    setSelectedIds: noop,
    selectedTags: [],
    setSelectedTags: noop,
    queries: [],
    stats: { total: 0, byTable: {}, byTableGroup: {} },
    allTags: [],
    categoryCounts: {},
    searchRef: { current: null },
    searchTerm: '',
    setSearchTerm: noop,
    selectedCategory: null,
    setSelectedCategory: noop,
    selectedTable: null,
    setSelectedTable: noop,
    showFavoritesOnly: false,
    setShowFavoritesOnly: noop,
    sortBy: 'updated',
    setSortBy: noop,
    sortDir: 'desc',
    setSortDir: noop,
    tableFilterExpanded: { sentinel: true, defender: true, custom: true },
    setTableFilterExpanded: noop,
    hasActiveFilters: false,
    clearFilters: noop,
    importPreview: null,
    setImportPreview: noop,
    confirmImport: noop,
    handleBulkDelete: noop,
    handleBulkExport: noop,
    handleBulkCategory: noop,
    handleBulkTable: noop,
    savingState: 'idle',
    expandedIds: new Set(),
    ...overrides,
  };
}

/** Mount `element` inside a provider carrying `overrides` merged over the defaults. */
function renderWithApp(element, overrides = {}) {
  return render(h(AppContext.Provider, { value: makeAppValue(overrides) }, element));
}

const SAMPLE_QUERY = {
  id: 'q1',
  name: 'Suspicious PowerShell Execution',
  description: 'Finds encoded PowerShell.\n\nUse Cases:\n- Threat hunting\n- Incident triage',
  query: 'DeviceProcessEvents\n| where Timestamp > ago(7d)\n| where FileName =~ "powershell.exe"\n| project Timestamp, DeviceName\n| take 100',
  category: 'Threat Hunting',
  table: 'DeviceProcessEvents',
  tags: ['powershell', 'lolbins'],
  favorite: true,
  usageCount: 4,
  created: '2026-01-01T00:00:00.000Z',
  updated: '2026-02-01T00:00:00.000Z',
};

const SAMPLE_IMPORT_PREVIEW = {
  text: '[]',
  preview: {
    items: [
      { index: 0, name: 'New Query', status: 'add', reason: null },
      { index: 1, name: 'Old Query', status: 'skip', reason: 'Duplicate ID' },
      { index: 2, name: 'Bad Query', status: 'error', reason: 'name: Required' },
    ],
    willAdd: 1,
    willSkip: 1,
    willDuplicate: 0,
    willError: 1,
    total: 3,
  },
};

const SAMPLE_STORAGE = {
  error: null,
  isLoading: false,
  stats: { total: 3 },
  lastSavedTimestamp: 1767225600000,
  backupTimestamp: null,
};

export { h, makeAppValue, renderWithApp, SAMPLE_QUERY, SAMPLE_IMPORT_PREVIEW, SAMPLE_STORAGE };
