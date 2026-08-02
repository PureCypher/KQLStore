import React, { useId, useState, useRef } from 'react';
import { X, Sparkles } from 'lucide-react';
import { CATEGORIES, CATEGORY_COLORS } from '../constants.js';
import { HighlightedCode } from './HighlightedCode.jsx';
import { TableSelector } from './TableSelector.jsx';
import { useApp } from '../context/app.js';
import { LintPanel } from './LintPanel.jsx';
import { DetectionMetadataFields } from './DetectionMetadataFields.jsx';
import { metadataToForm, formToMetadata } from '../domain/metadataForm.js';
import { buildProvenanceRecord } from '../domain/proposal.js';
import { FOCUS_RING } from './a11y.jsx';
import { Modal } from './Modal.jsx';
import { AIChatPanel } from './AIChatPanel.jsx';

// Proposed detection-block fields, mapped onto the meta FORM shape the editor edits.
// Core fields (name, description, query, category, table, tags) write straight into
// `form`; these convert the schema shape the model returns into the text shape the
// DetectionMetadataFields component edits.
const META_WRITE = {
  queryType: (v) => ({ queryType: typeof v === 'string' ? v : '' }),
  severity: (v) => ({ severity: typeof v === 'string' ? v : '' }),
  confidence: (v) => ({ confidence: typeof v === 'string' ? v : '' }),
  platform: (v) => ({ platform: Array.isArray(v) ? v : [] }),
  attack: (v) => ({
    tactics: Array.isArray(v?.tactics) ? v.tactics : [],
    techniques: Array.isArray(v?.techniques) ? v.techniques.join(', ') : '',
  }),
  lookback: (v) => ({ lookback: typeof v === 'string' ? v : '' }),
  falsePositives: (v) => ({ falsePositives: Array.isArray(v) ? v.join('\n') : '' }),
  tuningNotes: (v) => ({ tuningNotes: typeof v === 'string' ? v : '' }),
  references: (v) => ({ references: Array.isArray(v) ? v.join('\n') : '' }),
  entityMappings: (v) => ({ entityMappings: Array.isArray(v) ? v : [] }),
};

const QueryEditorModal = () => {
  const {
    editingQuery, saveQuery, setEditingQuery, aiAvailable = false, schemas = [], aiModel,
  } = useApp();
  // The parent mounts this only while the editor is open and keys it on the target query,
  // so the initial state below is derived once per open. The guard further down is a
  // belt-and-braces check; every hook still has to run before it, or React would see a
  // different hook count between renders and throw error #310.
  const [form, setForm] = useState(() => ({
    name: editingQuery?.name || '',
    description: editingQuery?.description || '',
    query: editingQuery?.query || '',
    category: editingQuery?.category || 'Utility',
    table: editingQuery?.table || 'Custom',
    tags: (editingQuery?.tags || []).join(', '),
  }));
  // The detection block is kept as its own form state: it is edited as text (comma and
  // newline separated lists) and only converted to the schema shape on save.
  const [meta, setMeta] = useState(() => metadataToForm(editingQuery));
  const [errors, setErrors] = useState({});
  // Whether Tab in the KQL box indents instead of moving focus. See handleQueryKeyDown.
  const [tabIndents, setTabIndents] = useState(true);
  // Whether the AI chat panel is open. It is a VIEW of the shared draft, never a copy —
  // closing it removes a view, not a source of truth, so accepted changes stay in the form.
  const [assistOpen, setAssistOpen] = useState(false);
  const taRef = useRef(null);
  // Accepted AI proposals and the redaction/instruction facts that go with them,
  // accumulated across the session and turned into ONE provenance record on save.
  const acceptedRef = useRef([]);
  const provenanceMetaRef = useRef({ redaction: 'applied', instruction: '' });

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
  /** Move the caret to the start of a line in the KQL box, so a lint finding is actionable. */
  const jumpToLine = (line) => {
    const ta = taRef.current;
    if (!ta) return;
    const lines = form.query.split('\n');
    const index = lines.slice(0, Math.max(0, line - 1)).reduce((n, l) => n + l.length + 1, 0);
    ta.focus();
    ta.setSelectionRange(index, index + (lines[line - 1]?.length ?? 0));
  };

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

    // One provenance record per save, appended to whatever the query already carried and
    // capped at 10 (the API enforces the same cap). It names only what was ACCEPTED —
    // a proposal the operator rejected leaves no trace here.
    const existingProvenance = Array.isArray(editingQuery?.aiProvenance) ? editingQuery.aiProvenance : [];
    const aiProvenance = acceptedRef.current.length > 0
      ? [...existingProvenance, buildProvenanceRecord(acceptedRef.current, {
          model: aiModel,
          generatedAt: new Date().toISOString(),
          redaction: provenanceMetaRef.current.redaction,
          instruction: provenanceMetaRef.current.instruction,
        })].slice(-10)
      : existingProvenance;
    acceptedRef.current = [];

    saveQuery({
      ...(isNew ? {} : editingQuery),
      name: form.name.trim(), description: form.description.trim(), query: form.query,
      category: form.category, table: form.table, tags,
      favorite: editingQuery.favorite || false, usageCount: editingQuery.usageCount || 0,
      ...formToMetadata(meta),
      aiProvenance,
    });
    setEditingQuery(null);
  };

  const isModified = editingQuery.query && form.query !== editingQuery.query;

  // The shared draft: everything the form currently holds, in the query-record shape the
  // panel's reviewProposal validates against. One draft, two views — the chat never holds
  // its own copy, it proposes changes back through the setters below.
  const sharedDraft = {
    ...(editingQuery || {}),
    name: form.name,
    description: form.description,
    query: form.query,
    category: form.category,
    table: form.table,
    tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
    ...formToMetadata(meta),
  };

  // Accepted changes write back through the form's own setters, field by field, so a
  // hand edit made after a proposal is never clobbered by a stale draft. The accepted
  // changes also accumulate for the save-time provenance record; the meta arg (redaction
  // state + the operator's instruction) travels with the last proposal of the session.
  const applyProposal = (accepted, meta) => {
    acceptedRef.current = [...acceptedRef.current, ...accepted];
    if (meta) provenanceMetaRef.current = {
      redaction: meta.redaction === 'overridden' ? 'overridden' : 'applied',
      instruction: typeof meta.instruction === 'string' ? meta.instruction : '',
    };
    let nextForm = null;
    let nextMeta = null;
    for (const change of accepted) {
      const to = change.to;
      if (change.field === 'tags') {
        nextForm = { ...(nextForm || form), tags: Array.isArray(to) ? to.join(', ') : '' };
      } else if (META_WRITE[change.field]) {
        nextMeta = { ...(nextMeta || meta), ...META_WRITE[change.field](to) };
      } else {
        nextForm = { ...(nextForm || form), [change.field]: to };
      }
    }
    if (nextForm) setForm(nextForm);
    if (nextMeta) setMeta(nextMeta);
  };

  const inputCls = `w-full px-3 py-2 rounded-lg font-mono text-sm text-gray-200 outline-hidden focus:ring-1 focus:ring-[#00ff88] ${FOCUS_RING}`;
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
      className={`rounded-xl p-6 font-mono w-full ${assistOpen ? 'max-w-6xl' : 'max-w-2xl'} mx-4`}
      style={{ background: '#12121a', border: '1px solid #2a2a3e' }}
    >
      <div className="flex justify-between items-center mb-5">
        <h2 id={ids.title} className="text-lg font-bold" style={{ color: '#00ff88' }}>
          {isNew ? '+ New Query' : 'Edit Query'}
          {isModified && <span className="ml-2 text-xs px-2 py-0.5 rounded" style={{ background: '#2a2010', color: '#ffcc00', border: '1px solid #ffcc00' }}>modified</span>}
        </h2>
        <div className="flex items-center gap-2">
          {/* Hidden, never disabled, when the AI service is unavailable: a scaled-to-zero
              pod must leave manual authoring untouched and this toggle invisible. */}
          {aiAvailable && (
            <button type="button" onClick={() => setAssistOpen((p) => !p)}
              aria-pressed={assistOpen}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold ${FOCUS_RING}`}
              style={assistOpen
                ? { background: '#00ff88', color: '#0a0a0f' }
                : { border: '1px solid #2a2a3e', color: '#00ff88' }}>
              <Sparkles size={12} aria-hidden="true" /> Assist with AI
            </button>
          )}
          <button onClick={() => setEditingQuery(null)} className={`p-1 rounded hover:bg-white/10 ${FOCUS_RING}`}
            aria-label={isNew ? 'Discard new query' : 'Close query editor'} title="Close">
            <X size={16} className="text-gray-400" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className={assistOpen ? 'flex gap-5' : 'space-y-4'}>
        <div className="space-y-4 flex-1 min-w-0">
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
          <LintPanel query={form.query} onJumpToLine={jumpToLine} />
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

          <DetectionMetadataFields value={meta} onChange={setMeta} />
        </div>
        {assistOpen && (
          <div className="w-[28rem] shrink-0 min-w-0" style={{ borderLeft: '1px solid #1e1e2e' }}>
            {/* The panel shares the draft; it reports accepted changes through onProposal
                and the form owns them. Unmounting it on close discards the conversation —
                the accepted fields are already in the form. */}
            <AIChatPanel
              draft={sharedDraft}
              schemas={schemas}
              onProposal={applyProposal}
              onClose={() => setAssistOpen(false)}
            />
          </div>
        )}
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
