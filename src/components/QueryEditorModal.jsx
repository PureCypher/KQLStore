import React, { useId, useState, useRef } from 'react';
import { X } from 'lucide-react';
import { CATEGORIES, CATEGORY_COLORS } from '../constants.js';
import { HighlightedCode } from './HighlightedCode.jsx';
import { TableSelector } from './TableSelector.jsx';
import { useApp } from '../context/app.js';
import { FOCUS_RING } from './a11y.jsx';
import { Modal } from './Modal.jsx';

const QueryEditorModal = () => {
  const { editingQuery, saveQuery, setEditingQuery } = useApp();
  // Every hook must run before the early return below, or React sees a different hook
  // count between the closed and open states and throws error #310. The parent keys this
  // component on the query id, so the initial state is re-derived when the target changes.
  const [form, setForm] = useState(() => ({
    name: editingQuery?.name || '',
    description: editingQuery?.description || '',
    query: editingQuery?.query || '',
    category: editingQuery?.category || 'Utility',
    table: editingQuery?.table || 'Custom',
    tags: (editingQuery?.tags || []).join(', '),
  }));
  const [errors, setErrors] = useState({});
  // Whether Tab in the KQL box indents instead of moving focus. See handleQueryKeyDown.
  const [tabIndents, setTabIndents] = useState(true);
  const taRef = useRef(null);

  const baseId = useId();
  const ids = {
    title: `${baseId}-title`,
    name: `${baseId}-name`,
    nameError: `${baseId}-name-error`,
    description: `${baseId}-description`,
    query: `${baseId}-query`,
    queryError: `${baseId}-query-error`,
    queryHint: `${baseId}-query-hint`,
    category: `${baseId}-category`,
    table: `${baseId}-table`,
    tags: `${baseId}-tags`,
  };

  if (!editingQuery) return null;
  const isNew = !editingQuery.id;

  // The KQL box captures Tab to indent, which on its own is a keyboard trap: once focus
  // is in the textarea there is no key left that moves it out, and WCAG 2.1.2 is a Level
  // A failure with no workaround. The conventional escape hatch is a mode toggle —
  // Escape releases the capture so the next Tab behaves normally, and the capture comes
  // back on re-entry or as soon as the user types, because someone who is still editing
  // wants the indent. The mode is stated next to the field and announced through
  // aria-describedby, since an invisible mode is its own accessibility problem.
  const handleQueryKeyDown = (e) => {
    if (e.key === 'Escape' && tabIndents) {
      // Swallowed only while the capture is on. Once released, Escape falls through to
      // the dialog and closes it, which is what a second press should do.
      e.preventDefault();
      e.stopPropagation();
      setTabIndents(false);
      return;
    }
    if (e.key !== 'Tab' || !tabIndents) return;
    e.preventDefault();
    // The dialog's focus trap also acts on Tab; without this it would move focus out
    // from under the indent that has just been inserted.
    e.stopPropagation();
    const s = e.target.selectionStart, end = e.target.selectionEnd;
    const val = form.query;
    setForm((p) => ({ ...p, query: val.substring(0, s) + '    ' + val.substring(end) }));
    requestAnimationFrame(() => { if (taRef.current) { taRef.current.selectionStart = taRef.current.selectionEnd = s + 4; } });
  };

  // Clearing on edit rather than only on the next save attempt: aria-invalid and the
  // message below the field would otherwise keep asserting an error the user has fixed.
  const updateField = (field, val) => {
    setForm((p) => ({ ...p, [field]: val }));
    setErrors((p) => (p[field] ? { ...p, [field]: undefined } : p));
  };

  const handleSave = () => {
    const errs = {};
    if (!form.name.trim()) errs.name = 'Name is required';
    if (!form.query.trim()) errs.query = 'A KQL query body is required';
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
  const inputCls = `w-full px-3 py-2 rounded-lg font-mono text-sm text-gray-200 outline-none focus:ring-1 focus:ring-[#00ff88] ${FOCUS_RING}`;
  const inputSty = { background: '#1a1a2e', border: '1px solid #2a2a3e' };
  // text-gray-500 (#6b7280) is 3.85:1 on this panel's #12121a and text-gray-400 is 7.0:1;
  // WCAG 1.4.3 wants 4.5:1 of a field label. Measured with axe in Chromium.
  const labelCls = 'text-xs text-gray-400 mb-1 block';
  const errorCls = 'text-xs mt-1';
  const errorSty = { color: '#ff6b6b' };

  return (
    <Modal
      labelledBy={ids.title}
      onClose={() => setEditingQuery(null)}
      backdropClassName="z-[80] items-start justify-center pt-8 pb-8 overflow-y-auto"
      className="rounded-xl p-6 font-mono w-full max-w-2xl mx-4"
      style={{ background: '#12121a', border: '1px solid #2a2a3e' }}
    >
      <div className="flex justify-between items-center mb-5">
        <h2 id={ids.title} className="text-lg font-bold" style={{ color: '#00ff88' }}>
          {isNew ? '+ New Query' : 'Edit Query'}
          {isModified && <span className="ml-2 text-xs px-2 py-0.5 rounded" style={{ background: '#2a2010', color: '#ffcc00', border: '1px solid #ffcc00' }}>modified</span>}
        </h2>
        <button onClick={() => setEditingQuery(null)} className={`p-1 rounded hover:bg-white/10 ${FOCUS_RING}`}
          aria-label={isNew ? 'Discard new query' : 'Close query editor'} title="Close">
          <X size={16} className="text-gray-400" aria-hidden="true" />
        </button>
      </div>
      <div className="space-y-4">
        <div>
          <label className={labelCls} htmlFor={ids.name}>Name <span aria-hidden="true">*</span></label>
          <input id={ids.name} className={inputCls} style={{ ...inputSty, borderColor: errors.name ? '#ff4444' : '#2a2a3e' }}
            aria-required="true"
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? ids.nameError : undefined}
            value={form.name} onChange={(e) => updateField('name', e.target.value)} placeholder="e.g. Suspicious PowerShell Execution" />
          {/* A red border is a colour-only error signal (WCAG 1.4.1) and says nothing to a
              screen reader; role=alert makes the message announce as it appears. */}
          {errors.name && <p id={ids.nameError} role="alert" className={errorCls} style={errorSty}>{errors.name}</p>}
        </div>
        <div>
          <label className={labelCls} htmlFor={ids.description}>Description</label>
          <textarea id={ids.description} className={inputCls} style={{ ...inputSty, resize: 'vertical' }} rows={6}
            value={form.description} onChange={(e) => updateField('description', e.target.value)} placeholder="Describe what this query does, its use cases, and any relevant context..." />
        </div>
        <div>
          <label className={labelCls} htmlFor={ids.query}>KQL Query <span aria-hidden="true">*</span></label>
          <textarea ref={taRef} id={ids.query} className={`${inputCls} leading-relaxed`}
            style={{ ...inputSty, minHeight: 160, borderColor: errors.query ? '#ff4444' : '#2a2a3e' }}
            aria-required="true"
            aria-invalid={errors.query ? true : undefined}
            aria-describedby={errors.query ? `${ids.queryHint} ${ids.queryError}` : ids.queryHint}
            value={form.query}
            onChange={(e) => { updateField('query', e.target.value); setTabIndents(true); }}
            onFocus={() => setTabIndents(true)}
            onKeyDown={handleQueryKeyDown} placeholder={"DeviceProcessEvents\n| where Timestamp > ago(7d)\n| ..."} spellCheck={false} />
          <p id={ids.queryHint} role="status" aria-live="polite" className="text-xs mt-1" style={{ color: '#8b8fa3' }}>
            {tabIndents
              ? 'Tab inserts four spaces. Press Escape to release Tab, then Tab moves to the next field.'
              : 'Tab now moves to the next field. Typing here, or leaving and coming back, restores Tab indentation.'}
          </p>
          {errors.query && <p id={ids.queryError} role="alert" className={errorCls} style={errorSty}>{errors.query}</p>}
        </div>
        {form.query && (
          <div>
            <span className={labelCls}>Preview</span>
            <HighlightedCode code={form.query} className="rounded-lg p-3 text-xs overflow-x-auto leading-relaxed max-h-40 overflow-y-auto"
              style={{ background: '#0a0a0f', border: '1px solid #1a1a2e' }} />
          </div>
        )}
        <div>
          {/* Not a <label>: these are seven buttons, not a form control, and a label with
              nothing to point at names nothing. */}
          <span className={labelCls} id={ids.category}>Category</span>
          <div className="flex flex-wrap gap-2" role="group" aria-labelledby={ids.category}>
            {CATEGORIES.map(c => {
              const colors = CATEGORY_COLORS[c];
              const isActive = form.category === c;
              return (
                <button key={c} type="button"
                  onClick={() => setForm(p => ({ ...p, category: c }))}
                  aria-pressed={isActive}
                  className={`px-3 py-1.5 rounded-lg text-xs font-mono transition-all ${FOCUS_RING}`}
                  style={{
                    background: isActive ? colors.bg : 'transparent',
                    // #666 was 3.24:1 against the panel; the selected state is still
                    // distinguished by its category colour and filled background.
                    color: isActive ? colors.text : '#9ca3af',
                    border: `1px solid ${isActive ? colors.border : '#2a2a3e'}`,
                  }}>{c}</button>
              );
            })}
          </div>
        </div>
        <div>
          <span className={labelCls} id={ids.table}>Table</span>
          <TableSelector value={form.table} labelId={ids.table} onChange={(t) => setForm(p => ({ ...p, table: t }))} />
        </div>
        <div>
          <label className={labelCls} htmlFor={ids.tags}>Tags (comma-separated)</label>
          <input id={ids.tags} className={inputCls} style={inputSty} value={form.tags}
            onChange={(e) => updateField('tags', e.target.value)} placeholder="powershell, lolbins, t1059" />
        </div>
      </div>
      <div className="flex justify-end gap-3 mt-6">
        <button onClick={() => setEditingQuery(null)}
          className={`px-4 py-2 rounded-lg text-sm font-mono text-gray-400 hover:text-gray-200 hover:bg-white/5 ${FOCUS_RING}`}
          style={{ border: '1px solid #2a2a3e' }}>Cancel</button>
        <button onClick={handleSave} className={`px-4 py-2 rounded-lg text-sm font-mono font-bold ${FOCUS_RING}`}
          style={{ background: '#00ff88', color: '#0a0a0f' }}>
          {isNew ? 'Save Query' : 'Update Query'}
        </button>
      </div>
    </Modal>
  );
};

export { QueryEditorModal };
