import React, { useState, useRef, useEffect } from 'react';
import { Download, ChevronDown, AlertTriangle } from 'lucide-react';
import { toJsonExport } from '../export/json.js';
import { toSentinelRuleSet } from '../export/sentinelYaml.js';
import { toNavigatorLayer, coverageSummary } from '../export/navigator.js';

/**
 * Export in the formats a detection library is actually asked for.
 *
 * The store previously emitted only a bare JSON array of its own internal records, so
 * queries went in and came back out into the same tool and nowhere else. Sentinel YAML and
 * an ATT&CK Navigator layer are what make the library legible to the rest of the SOC.
 *
 * Menu semantics follow the same pattern as TableSelector: a real button with
 * aria-haspopup/aria-expanded, a role="menu" popup, arrow-key navigation, and an Escape
 * that closes only the menu and does not propagate to the app's global key handler.
 */
function ExportMenu({ queries, onToast }) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [warnings, setWarnings] = useState(null);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const itemRefs = useRef([]);

  useEffect(() => {
    if (!open) return undefined;
    const onDocMouseDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  useEffect(() => {
    if (open) itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  const download = (contents, filename, mime) => {
    const blob = new Blob([contents], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoking in the same tick can cancel the download before it starts.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const stamp = new Date().toISOString().slice(0, 10);

  const formats = [
    {
      key: 'json',
      label: 'JSON (native)',
      hint: 'Re-importable here. Carries the schema version.',
      run: () => {
        download(toJsonExport(queries), `kqlstore-${stamp}.json`, 'application/json');
        onToast(`Exported ${queries.length} queries`, 'success');
      },
    },
    {
      key: 'sentinel',
      label: 'Sentinel analytics rules (YAML)',
      hint: 'One scheduled rule per query, ready for a content repo.',
      run: () => {
        const { yaml, warnings: w } = toSentinelRuleSet(queries);
        download(yaml, `kqlstore-sentinel-rules-${stamp}.yaml`, 'application/yaml');
        if (w.length) {
          setWarnings(w);
          onToast(`Exported ${queries.length} rules — ${w.length} need review`, 'info');
        } else {
          onToast(`Exported ${queries.length} rules`, 'success');
        }
      },
    },
    {
      key: 'navigator',
      label: 'ATT&CK Navigator layer',
      hint: 'Technique coverage, scored by how many queries cover each.',
      run: () => {
        const summary = coverageSummary(queries);
        download(
          JSON.stringify(toNavigatorLayer(queries), null, 2),
          `kqlstore-attack-layer-${stamp}.json`,
          'application/json',
        );
        onToast(
          `${summary.uniqueTechniques} techniques from ${summary.mappedQueries} mapped queries`
          + (summary.unmappedQueries ? ` — ${summary.unmappedQueries} unmapped` : ''),
          summary.unmappedQueries ? 'info' : 'success',
        );
      },
    },
  ];

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      // Only this menu closes. Without stopPropagation the app's window handler would
      // also fire and, if the editor were open behind it, discard the draft.
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((i) => (i + 1) % formats.length); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((i) => (i - 1 + formats.length) % formats.length); }
    if (e.key === 'Home') { e.preventDefault(); setActiveIndex(0); }
    if (e.key === 'End') { e.preventDefault(); setActiveIndex(formats.length - 1); }
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => { setActiveIndex(0); setOpen((o) => !o); }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Export queries"
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00d4ff]"
        style={{ border: '1px solid #2a2a3e', color: '#aaa' }}
      >
        <Download size={14} aria-hidden="true" />
        <span className="hidden sm:inline">Export</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Export format"
          onKeyDown={onKeyDown}
          className="absolute right-0 mt-1 w-72 rounded-lg shadow-2xl z-50 py-1"
          style={{ background: '#1a1a2e', border: '1px solid #2a2a3e' }}
        >
          {formats.map((f, i) => (
            <button
              key={f.key}
              type="button"
              role="menuitem"
              ref={(el) => { itemRefs.current[i] = el; }}
              tabIndex={i === activeIndex ? 0 : -1}
              onClick={() => { setOpen(false); f.run(); buttonRef.current?.focus(); }}
              className="w-full text-left px-3 py-2 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00d4ff]"
            >
              <div className="text-xs" style={{ color: '#e0e0e0' }}>{f.label}</div>
              <div className="text-[11px] text-gray-400 mt-0.5">{f.hint}</div>
            </button>
          ))}
        </div>
      )}

      {warnings && (
        <div
          role="status"
          className="absolute right-0 mt-1 w-96 max-h-72 overflow-y-auto rounded-lg shadow-2xl z-50 p-3 text-xs"
          style={{ background: '#1a1a2e', border: '1px solid #ffcc00' }}
        >
          <div className="flex items-center gap-2 mb-2" style={{ color: '#ffcc00' }}>
            <AlertTriangle size={13} aria-hidden="true" />
            <span>{warnings.length} rule(s) exported with defaulted fields</span>
          </div>
          <ul className="space-y-2">
            {warnings.map((w) => (
              <li key={w.id}>
                <div style={{ color: '#e0e0e0' }}>{w.name}</div>
                <ul className="text-gray-400 ml-3 list-disc">
                  {w.warnings.map((msg) => <li key={msg}>{msg}</li>)}
                </ul>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setWarnings(null)}
            className="mt-3 px-2 py-1 rounded text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00d4ff]"
            style={{ border: '1px solid #2a2a3e', color: '#aaa' }}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

export { ExportMenu };
