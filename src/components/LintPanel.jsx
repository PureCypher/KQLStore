import React, { useMemo, useState } from 'react';
import { AlertTriangle, Info, ChevronDown, ChevronUp, Check } from 'lucide-react';
import { lint } from '../domain/lint.js';

/**
 * Surfaces the KQL linter's findings while a query is being written.
 *
 * Advisory, never blocking. These are performance and correctness smells, not schema
 * errors, and a query that trips a rule can still be exactly what the author intended —
 * a linter that refuses to let you save is a linter people route around. Findings carry
 * a line number and a hint so they can be acted on rather than merely acknowledged.
 */

const SEVERITY_STYLE = {
  error: { colour: '#ff6b6b', Icon: AlertTriangle, label: 'error' },
  warning: { colour: '#ffcc00', Icon: AlertTriangle, label: 'warning' },
  info: { colour: '#00d4ff', Icon: Info, label: 'info' },
};

const ORDER = { error: 0, warning: 1, info: 2 };

function LintPanel({ query, onJumpToLine }) {
  const [collapsed, setCollapsed] = useState(false);

  // The linter is a pure function over the text, so memoising on the text is enough to
  // keep it off the keystroke path for anything but a genuine change.
  const findings = useMemo(() => lint(query), [query]);

  const counts = useMemo(() => {
    const c = { error: 0, warning: 0, info: 0 };
    for (const f of findings) c[f.severity] = (c[f.severity] ?? 0) + 1;
    return c;
  }, [findings]);

  if (!query || !query.trim()) return null;

  if (findings.length === 0) {
    return (
      <div className="flex items-center gap-2 mt-2 text-xs" style={{ color: '#00ff88' }} role="status">
        <Check size={12} aria-hidden="true" />
        <span>No lint findings</span>
      </div>
    );
  }

  const sorted = [...findings].sort(
    (a, b) => ORDER[a.severity] - ORDER[b.severity] || a.line - b.line,
  );

  const summary = ['error', 'warning', 'info']
    .filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${SEVERITY_STYLE[s].label}${counts[s] === 1 ? '' : 's'}`)
    .join(', ');

  return (
    <div className="mt-2 rounded-lg" style={{ background: '#12121a', border: '1px solid #2a2a3e' }}>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="w-full flex items-center justify-between px-3 py-2 text-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00d4ff] rounded-lg"
      >
        <span className="flex items-center gap-2" style={{ color: '#9ca3af' }}>
          <AlertTriangle size={12} aria-hidden="true" style={{ color: counts.error ? '#ff6b6b' : '#ffcc00' }} />
          Query lint — {summary}
        </span>
        {collapsed
          ? <ChevronDown size={12} aria-hidden="true" style={{ color: '#9ca3af' }} />
          : <ChevronUp size={12} aria-hidden="true" style={{ color: '#9ca3af' }} />}
      </button>

      {!collapsed && (
        <ul className="px-3 pb-2 space-y-2">
          {sorted.map((f) => {
            const { colour, Icon } = SEVERITY_STYLE[f.severity] ?? SEVERITY_STYLE.info;
            return (
              <li key={`${f.rule}:${f.line}:${f.column}`} className="text-xs">
                <div className="flex items-start gap-2">
                  <Icon size={11} aria-hidden="true" style={{ color: colour, marginTop: 2, flexShrink: 0 }} />
                  <div className="min-w-0">
                    <div style={{ color: '#e0e0e0' }}>
                      {onJumpToLine ? (
                        <button
                          type="button"
                          onClick={() => onJumpToLine(f.line)}
                          className="underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00d4ff] rounded"
                          style={{ color: '#00d4ff' }}
                        >
                          line {f.line}
                        </button>
                      ) : (
                        <span style={{ color: '#00d4ff' }}>line {f.line}</span>
                      )}
                      {' — '}
                      {f.message}
                    </div>
                    {f.hint && <div className="text-gray-400 mt-0.5">{f.hint}</div>}
                    <div className="text-[10px] mt-0.5" style={{ color: '#6b7280' }}>{f.rule}</div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export { LintPanel };
