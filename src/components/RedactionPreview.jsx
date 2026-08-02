// ---------------------------------------------------------------------------
// Redaction gate shown before anything leaves the cluster.
//
// Two states. Normally it lists every disclosure value that will become a marker and
// offers the verbatim override — the operator decides, because some queries are benign
// and the override exists precisely for those. When the request is blocked (a
// credential), it names the RULES that fired and offers no way through: there is no
// override for a secret, and the matched value is never rendered, because showing it
// here would put the credential in a DOM that a screenshot or a cached page can keep.
// ---------------------------------------------------------------------------
import React from 'react';
import { FOCUS_RING } from './a11y.jsx';

const RedactionPreview = ({ applied, blocked, secrets, onConfirm, onOverride, onDismiss }) => (
  <div role="dialog" aria-modal="true" aria-label="Redaction preview"
    className="rounded-lg p-4 space-y-3"
    style={{ background: '#14141f', border: '1px solid #2a2a3e' }}>
    <h3 className="text-sm font-bold" style={{ color: blocked ? '#ff6b6b' : '#00d4ff' }}>
      {blocked ? 'Blocked: this request contains a credential' : 'What will leave the cluster'}
    </h3>

    {blocked ? (
      <>
        <p className="text-xs text-gray-300">
          The rules below matched. A credential is refused outright — there is no override
          for a secret. Remove it from the query and try again.
        </p>
        <ul className="space-y-1">
          {secrets.map((s, i) => (
            <li key={i} className="flex items-center gap-2 text-xs py-1 px-2 rounded"
              style={{ background: '#0a0a0f', border: '1px solid #1e1e2e' }}>
              <span className="font-bold" style={{ color: '#ff6b6b' }}>{s.rule}</span>
              <span className="text-gray-500">in {s.field}</span>
            </li>
          ))}
        </ul>
      </>
    ) : applied.length === 0 ? (
      <p className="text-xs text-gray-400">Nothing will be redacted.</p>
    ) : (
      <>
        <p className="text-xs text-gray-300">
          These values will be replaced with placeholders before the query is sent:
        </p>
        <ul className="space-y-1">
          {applied.map((a, i) => (
            <li key={i} className="flex items-center gap-2 text-xs py-1 px-2 rounded"
              style={{ background: '#0a0a0f', border: '1px solid #1e1e2e' }}>
              <span className="text-gray-300 flex-1 truncate" title={a.value}>{a.value}</span>
              <span className="text-gray-600">→</span>
              <code className="text-[#00d4ff]">{a.marker}</code>
            </li>
          ))}
        </ul>
      </>
    )}

    <div className="flex justify-end gap-3 pt-1">
      {blocked ? (
        // No way through — only a way back, to edit the query and try again.
        onDismiss && (
          <button type="button" onClick={onDismiss}
            className={`px-3 py-1.5 rounded-lg text-xs text-gray-400 hover:text-gray-200 hover:bg-white/5 ${FOCUS_RING}`}
            style={{ border: '1px solid #2a2a3e' }}>Back</button>
        )
      ) : (
        <>
          {/* The override is the escape hatch the design grants for benign queries, named
              for exactly what it does — it is never the default path. */}
          <button type="button" onClick={onOverride}
            className={`px-3 py-1.5 rounded-lg text-xs text-gray-300 hover:text-gray-100 hover:bg-white/5 ${FOCUS_RING}`}
            style={{ border: '1px solid #2a2a3e' }}>Send verbatim</button>
          <button type="button" onClick={onConfirm}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold ${FOCUS_RING}`}
            style={{ background: '#00ff88', color: '#0a0a0f' }}>
            {applied.length === 0 ? 'Send' : 'Redact and send'}
          </button>
        </>
      )}
    </div>
  </div>
);

export { RedactionPreview };
