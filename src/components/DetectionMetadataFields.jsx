import React, { useId, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react';
import {
  ATTACK_TACTICS, TECHNIQUE_REGEX, SEVERITIES, CONFIDENCES, QUERY_TYPES, PLATFORMS,
  ENTITY_TYPES, TIMESPAN_REGEX,
} from '../constants.js';

/**
 * The schema v4 detection block, as an editable form.
 *
 * Without this the metadata could only be set by importing a file or calling the API, so in
 * practice nothing typed into the UI was ever mapped to ATT&CK. Collapsed by default: the
 * common case is jotting down a query, and burying that under seventeen optional fields
 * would make the tool worse at the thing it is already good at.
 */

const FOCUS = 'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00d4ff]';
const labelCls = 'text-xs text-gray-400 mb-1 block';
const inputSty = { background: '#1a1a2e', border: '1px solid #2a2a3e' };
const inputCls = `w-full px-3 py-2 rounded-lg font-mono text-sm text-gray-200 outline-hidden ${FOCUS}`;

/** A row of mutually exclusive choices, rendered as a radio group so it announces correctly. */
function ChoiceRow({ legend, options, value, onChange, allowNone = true }) {
  const name = useId();
  return (
    <fieldset>
      <legend className={labelCls}>{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {(allowNone ? ['', ...options] : options).map((opt) => {
          const selected = (value || '') === opt;
          return (
            <label
              key={opt || '__none'}
              className={`px-2.5 py-1 rounded-md text-xs cursor-pointer ${FOCUS}`}
              style={{
                background: selected ? 'rgba(0, 212, 255, 0.12)' : '#1a1a2e',
                border: `1px solid ${selected ? '#00d4ff' : '#2a2a3e'}`,
                color: selected ? '#00d4ff' : '#9ca3af',
              }}
            >
              <input
                type="radio"
                name={name}
                className="sr-only"
                checked={selected}
                onChange={() => onChange(opt)}
              />
              {opt || 'Not set'}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Multi-select chips backed by real checkboxes. */
function ChipMultiSelect({ legend, options, values, onChange }) {
  const selected = new Set(values || []);
  return (
    <fieldset>
      <legend className={labelCls}>{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const on = selected.has(opt);
          return (
            <label
              key={opt}
              className={`px-2.5 py-1 rounded-md text-xs cursor-pointer ${FOCUS}`}
              style={{
                background: on ? 'rgba(0, 255, 136, 0.1)' : '#1a1a2e',
                border: `1px solid ${on ? '#00ff88' : '#2a2a3e'}`,
                color: on ? '#00ff88' : '#9ca3af',
              }}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={on}
                onChange={() => {
                  const next = new Set(selected);
                  if (next.has(opt)) next.delete(opt); else next.add(opt);
                  onChange([...next]);
                }}
              />
              {opt}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Free-text list, one entry per line. Used for false positives and references. */
function LineList({ label, hint, value, onChange, placeholder, invalidLine }) {
  const id = useId();
  return (
    <div>
      <label className={labelCls} htmlFor={id}>{label}</label>
      <textarea
        id={id}
        rows={3}
        className={inputCls}
        style={{ ...inputSty, resize: 'vertical' }}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={`${id}-hint`}
      />
      <div id={`${id}-hint`} className="text-[11px] text-gray-400 mt-1">{hint}</div>
      {invalidLine && <div className="text-xs mt-1" style={{ color: '#ff6b6b' }}>{invalidLine}</div>}
    </div>
  );
}

function DetectionMetadataFields({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const ids = useId();
  const set = (patch) => onChange({ ...value, ...patch });

  const techniques = value.techniques || '';
  const badTechniques = techniques
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !TECHNIQUE_REGEX.test(t));

  const lookbackInvalid = value.lookback && !TIMESPAN_REGEX.test(value.lookback);

  const badReferences = (value.references || '')
    .split('\n')
    .map((r) => r.trim())
    .filter(Boolean)
    .filter((r) => !/^https?:\/\//i.test(r));

  const filled = [
    value.queryType, value.severity, value.confidence, value.lookback,
    (value.tactics || []).length, (value.platform || []).length,
    techniques.trim(), (value.falsePositives || '').trim(),
    (value.tuningNotes || '').trim(), (value.references || '').trim(),
    (value.entityMappings || []).length,
  ].filter(Boolean).length;

  return (
    <div className="rounded-lg" style={{ border: '1px solid #2a2a3e' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={`${ids}-body`}
        className={`w-full flex items-center justify-between px-3 py-2 text-xs rounded-lg ${FOCUS}`}
      >
        <span className="flex items-center gap-2" style={{ color: '#e0e0e0' }}>
          {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
          Detection metadata
        </span>
        <span className="text-gray-400">
          {filled === 0 ? 'none set' : `${filled} field${filled === 1 ? '' : 's'} set`}
        </span>
      </button>

      {open && (
        <div id={`${ids}-body`} className="px-3 pb-3 space-y-4">
          <p className="text-[11px] text-gray-400">
            Optional, but it is what makes the library answerable: what is my ATT&CK coverage,
            and is this rule still valid. Also what the Sentinel and Navigator exports read.
          </p>

          <ChoiceRow legend="Query type" options={QUERY_TYPES}
            value={value.queryType} onChange={(v) => set({ queryType: v })} />
          <ChoiceRow legend="Severity" options={SEVERITIES}
            value={value.severity} onChange={(v) => set({ severity: v })} />
          <ChoiceRow legend="Confidence" options={CONFIDENCES}
            value={value.confidence} onChange={(v) => set({ confidence: v })} />

          <ChipMultiSelect legend="ATT&CK tactics" options={ATTACK_TACTICS}
            values={value.tactics} onChange={(v) => set({ tactics: v })} />

          <div>
            <label className={labelCls} htmlFor={`${ids}-tech`}>ATT&CK techniques</label>
            <input
              id={`${ids}-tech`}
              className={inputCls}
              style={{ ...inputSty, borderColor: badTechniques.length ? '#ff4444' : '#2a2a3e' }}
              placeholder="T1059.001, T1027"
              value={techniques}
              onChange={(e) => set({ techniques: e.target.value })}
              aria-describedby={`${ids}-tech-hint`}
              aria-invalid={badTechniques.length > 0}
            />
            <div id={`${ids}-tech-hint`} className="text-[11px] text-gray-400 mt-1">
              Comma separated, Txxxx or Txxxx.yyy. Validated on save — a typo like T1059.01 is
              rejected rather than stored.
            </div>
            {badTechniques.length > 0 && (
              <div className="text-xs mt-1" style={{ color: '#ff6b6b' }}>
                Not valid technique IDs: {badTechniques.join(', ')}
              </div>
            )}
          </div>

          <ChipMultiSelect legend="Platforms" options={PLATFORMS}
            values={value.platform} onChange={(v) => set({ platform: v })} />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} htmlFor={`${ids}-lookback`}>Lookback</label>
              <input
                id={`${ids}-lookback`}
                className={inputCls}
                style={{ ...inputSty, borderColor: lookbackInvalid ? '#ff4444' : '#2a2a3e' }}
                placeholder="7d"
                value={value.lookback || ''}
                onChange={(e) => set({ lookback: e.target.value })}
                aria-invalid={Boolean(lookbackInvalid)}
              />
              {lookbackInvalid && (
                <div className="text-xs mt-1" style={{ color: '#ff6b6b' }}>
                  Must be a KQL timespan, e.g. 7d, 90m, 1h
                </div>
              )}
            </div>
            <div>
              <label className={labelCls} htmlFor={`${ids}-validated`}>Last validated</label>
              <input
                id={`${ids}-validated`}
                type="date"
                className={inputCls}
                style={inputSty}
                value={value.lastValidated || ''}
                onChange={(e) => set({ lastValidated: e.target.value })}
              />
            </div>
          </div>

          <LineList
            label="False positives"
            hint="One per line. What a tier-1 analyst needs to know before they action this."
            placeholder={'Configuration management uses -enc for quoting\nVendor installers wrap PowerShell'}
            value={value.falsePositives || ''}
            onChange={(v) => set({ falsePositives: v })}
          />

          <div>
            <label className={labelCls} htmlFor={`${ids}-tuning`}>Tuning notes</label>
            <textarea
              id={`${ids}-tuning`}
              rows={2}
              className={inputCls}
              style={{ ...inputSty, resize: 'vertical' }}
              placeholder="Baseline InitiatingProcessFileName for two weeks before enabling as a rule."
              value={value.tuningNotes || ''}
              onChange={(e) => set({ tuningNotes: e.target.value })}
            />
          </div>

          <LineList
            label="References"
            hint="One URL per line. http(s) only."
            placeholder="https://attack.mitre.org/techniques/T1059/001/"
            value={value.references || ''}
            onChange={(v) => set({ references: v })}
            invalidLine={badReferences.length ? `Not http(s) URLs: ${badReferences.join(', ')}` : null}
          />

          <EntityMappingRows
            value={value.entityMappings || []}
            onChange={(v) => set({ entityMappings: v })}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Entity mappings drive incident correlation in Sentinel. Without them an exported rule
 * produces incidents whose entities do not join to anything else.
 */
function EntityMappingRows({ value, onChange }) {
  const ids = useId();
  const update = (i, patch) => onChange(value.map((m, j) => (j === i ? { ...m, ...patch } : m)));

  return (
    <fieldset>
      <legend className={labelCls}>Entity mappings</legend>
      <div className="space-y-2">
        {value.map((m, i) => (
          <div key={`${ids}-${i}`} className="flex gap-2 items-start">
            <select
              className={`${inputCls} flex-1`}
              style={inputSty}
              value={m.entityType || ''}
              onChange={(e) => update(i, { entityType: e.target.value })}
              aria-label={`Entity type for mapping ${i + 1}`}
            >
              <option value="">Type…</option>
              {ENTITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input
              className={`${inputCls} flex-1`}
              style={inputSty}
              placeholder="identifier (HostName)"
              value={m.identifier || ''}
              onChange={(e) => update(i, { identifier: e.target.value })}
              aria-label={`Identifier for mapping ${i + 1}`}
            />
            <input
              className={`${inputCls} flex-1`}
              style={inputSty}
              placeholder="column (DeviceName)"
              value={m.columnName || ''}
              onChange={(e) => update(i, { columnName: e.target.value })}
              aria-label={`Column name for mapping ${i + 1}`}
            />
            <button
              type="button"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              aria-label={`Remove mapping ${i + 1}`}
              className={`p-2 rounded-md hover:bg-white/5 ${FOCUS}`}
            >
              <X size={12} aria-hidden="true" style={{ color: '#9ca3af' }} />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => onChange([...value, { entityType: '', identifier: '', columnName: '' }])}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs ${FOCUS}`}
          style={{ border: '1px solid #2a2a3e', color: '#9ca3af' }}
        >
          <Plus size={11} aria-hidden="true" /> Add mapping
        </button>
      </div>
    </fieldset>
  );
}

export { DetectionMetadataFields };
