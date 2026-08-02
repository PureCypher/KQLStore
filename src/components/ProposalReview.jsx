// ---------------------------------------------------------------------------
// Proposal review layer.
//
// The model output gate made visible. reviewProposal has already run every proposed
// field through validateQuery; this component renders the verdicts and lets the
// operator decide. Valid changes arrive PRE-CHECKED, invalid ones PRE-UNCHECKED with
// the validator's reason attached — accepting an invalid change requires an explicit
// tick, and onAccept is handed exactly the checked set. Nothing is applied without a
// deliberate action, and nothing an invalid proposal was trying to change is applied
// by accident of being bundled with a valid one.
// ---------------------------------------------------------------------------
import React, { useState } from 'react';
import { FOCUS_RING } from './a11y.jsx';

/** Render a from/to value safely: strings verbatim, everything else as JSON. */
function renderValue(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '(none)';
  return JSON.stringify(value);
}

const ProposalReview = ({ changes, onAccept, onReject }) => {
  const [checked, setChecked] = useState(() => new Set(
    changes.filter((c) => c.valid).map((c) => c.field),
  ));

  const toggle = (field) => {
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(field) ? next.delete(field) : next.add(field);
      return next;
    });
  };

  const accepted = changes.filter((c) => checked.has(c.field));

  return (
    <div role="dialog" aria-modal="true" aria-label="Review model proposals"
      className="rounded-lg p-4 space-y-3"
      style={{ background: '#14141f', border: '1px solid #2a2a3e' }}>
      <h3 className="text-sm font-bold" style={{ color: '#00d4ff' }}>Review model proposals</h3>
      <ul className="space-y-2">
        {changes.map((change) => (
          <li key={change.field} className="rounded-lg p-2 text-xs space-y-1"
            style={{ background: '#0a0a0f', border: '1px solid #1e1e2e' }}>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={checked.has(change.field)}
                onChange={() => toggle(change.field)}
                className="accent-[#00ff88]"
              />
              <span className="font-bold text-gray-200">{change.field}</span>
              {!change.valid && (
                <span className="px-1.5 py-0.5 rounded text-[10px] uppercase"
                  style={{ background: '#2a1010', color: '#ff6b6b', border: '1px solid #ff444440' }}>
                  invalid
                </span>
              )}
            </label>
            <div className="pl-6 text-gray-400">
              <span className="line-through opacity-60">{renderValue(change.from)}</span>
              <span className="mx-1 text-gray-600">→</span>
              <span style={{ color: change.valid ? '#00ff88' : '#ff6b6b' }}>{renderValue(change.to)}</span>
            </div>
            {!change.valid && change.reason && (
              // The validator's own words, not a paraphrase: the operator needs to know
              // exactly which rule the proposal broke to fix it or override it.
              <p className="pl-6" style={{ color: '#ff6b6b' }}>{change.reason}</p>
            )}
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-3 pt-1">
        <button type="button" onClick={onReject}
          className={`px-3 py-1.5 rounded-lg text-xs text-gray-400 hover:text-gray-200 hover:bg-white/5 ${FOCUS_RING}`}
          style={{ border: '1px solid #2a2a3e' }}>Discard</button>
        <button type="button" onClick={() => onAccept(accepted)}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold ${FOCUS_RING}`}
          style={{ background: '#00ff88', color: '#0a0a0f' }}>
          Apply{accepted.length > 0 ? ` ${accepted.length}` : ''}
        </button>
      </div>
    </div>
  );
};

export { ProposalReview };
