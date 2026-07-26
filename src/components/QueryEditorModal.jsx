import React, { useState, useRef } from 'react';
import { X } from 'lucide-react';
import { CATEGORIES, CATEGORY_COLORS } from '../constants.js';
import { HighlightedCode } from './HighlightedCode.jsx';
import { TableSelector } from './TableSelector.jsx';
import { useApp } from '../context/app.js';

const QueryEditorModal = () => {
  const { editingQuery, saveQuery, setEditingQuery } = useApp();
  if (!editingQuery) return null;
  const isNew = !editingQuery.id;
  const [form, setForm] = useState({
    name: editingQuery.name || '',
    description: editingQuery.description || '',
    query: editingQuery.query || '',
    category: editingQuery.category || 'Utility',
    table: editingQuery.table || 'Custom',
    tags: (editingQuery.tags || []).join(', '),
  });
  const [errors, setErrors] = useState({});
  const taRef = useRef(null);

  const handleTabKey = (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = e.target.selectionStart, end = e.target.selectionEnd;
      const val = form.query;
      setForm((p) => ({ ...p, query: val.substring(0, s) + '    ' + val.substring(end) }));
      requestAnimationFrame(() => { if (taRef.current) { taRef.current.selectionStart = taRef.current.selectionEnd = s + 4; } });
    }
  };

  const handleSave = () => {
    const errs = {};
    if (!form.name.trim()) errs.name = 'Required';
    if (!form.query.trim()) errs.query = 'Required';
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
    const tags = form.tags.split(',').map((t) => t.trim()).filter(Boolean);
    saveQuery({
      ...(isNew ? {} : editingQuery),
      name: form.name.trim(), description: form.description.trim(), query: form.query,
      category: form.category, table: form.table, tags,
      favorite: editingQuery.favorite || false, usageCount: editingQuery.usageCount || 0,
    });
    setEditingQuery(null);
  };

  const isModified = editingQuery.query && form.query !== editingQuery.query;
  const inputCls = "w-full px-3 py-2 rounded-lg font-mono text-sm text-gray-200 outline-none focus:ring-1 focus:ring-[#00ff88]";
  const inputSty = { background: '#1a1a2e', border: '1px solid #2a2a3e' };

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center pt-8 pb-8 overflow-y-auto bg-black/70" onClick={() => setEditingQuery(null)}>
      <div className="rounded-xl p-6 font-mono w-full max-w-2xl mx-4" style={{ background: '#12121a', border: '1px solid #2a2a3e' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-5">
          <h3 className="text-lg font-bold" style={{ color: '#00ff88' }}>
            {isNew ? '+ New Query' : 'Edit Query'}
            {isModified && <span className="ml-2 text-xs px-2 py-0.5 rounded" style={{ background: '#2a2010', color: '#ffcc00', border: '1px solid #ffcc00' }}>modified</span>}
          </h3>
          <button onClick={() => setEditingQuery(null)} className="p-1 rounded hover:bg-white/10"><X size={16} className="text-gray-400" /></button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Name *</label>
            <input className={inputCls} style={{ ...inputSty, borderColor: errors.name ? '#ff4444' : '#2a2a3e' }}
              value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="e.g. Suspicious PowerShell Execution" />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Description</label>
            <textarea className={inputCls} style={{ ...inputSty, resize: 'vertical' }} rows={6}
              value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))} placeholder="Describe what this query does, its use cases, and any relevant context..." />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">KQL Query *</label>
            <textarea ref={taRef} className={`${inputCls} leading-relaxed`}
              style={{ ...inputSty, minHeight: 160, borderColor: errors.query ? '#ff4444' : '#2a2a3e' }}
              value={form.query} onChange={(e) => setForm((p) => ({ ...p, query: e.target.value }))}
              onKeyDown={handleTabKey} placeholder={"DeviceProcessEvents\n| where Timestamp > ago(7d)\n| ..."} spellCheck={false} />
          </div>
          {form.query && (
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Preview</label>
              <HighlightedCode code={form.query} className="rounded-lg p-3 text-xs overflow-x-auto leading-relaxed max-h-40 overflow-y-auto"
                style={{ background: '#0a0a0f', border: '1px solid #1a1a2e' }} />
            </div>
          )}
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Category</label>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map(c => {
                const colors = CATEGORY_COLORS[c];
                const isActive = form.category === c;
                return (
                  <button key={c} type="button"
                    onClick={() => setForm(p => ({ ...p, category: c }))}
                    className="px-3 py-1.5 rounded-lg text-xs font-mono transition-all"
                    style={{
                      background: isActive ? colors.bg : 'transparent',
                      color: isActive ? colors.text : '#666',
                      border: `1px solid ${isActive ? colors.border : '#2a2a3e'}`,
                    }}>{c}</button>
                );
              })}
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Table</label>
            <TableSelector value={form.table} onChange={(t) => setForm(p => ({ ...p, table: t }))} />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Tags (comma-separated)</label>
            <input className={inputCls} style={inputSty} value={form.tags}
              onChange={(e) => setForm((p) => ({ ...p, tags: e.target.value }))} placeholder="powershell, lolbins, t1059" />
          </div>
        </div>
        <div className="flex justify-end gap-3 mt-6">
          <button onClick={() => setEditingQuery(null)}
            className="px-4 py-2 rounded-lg text-sm font-mono text-gray-400 hover:text-gray-200 hover:bg-white/5"
            style={{ border: '1px solid #2a2a3e' }}>Cancel</button>
          <button onClick={handleSave} className="px-4 py-2 rounded-lg text-sm font-mono font-bold"
            style={{ background: '#00ff88', color: '#0a0a0f' }}>
            {isNew ? 'Save Query' : 'Update Query'}
          </button>
        </div>
      </div>
    </div>
  );
};

export { QueryEditorModal };
