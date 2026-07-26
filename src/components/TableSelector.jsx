// ---------------------------------------------------------------------------
// Table picker: a listbox popup behind a disclosure button.
//
// This was a div of unlabelled buttons with no roles and no key handling at all, which
// produced two separate failures:
//
//   Nothing announced it as a chooser, so a screen reader user got "button" followed by
//   a wall of unrelated buttons appearing somewhere in the page, with no indication that
//   one of them was the current value (WCAG 4.1.2).
//
//   Escape inside the open dropdown bubbled to the window-level shortcut handler in App,
//   which closes the query editor — so dismissing the dropdown destroyed the draft behind
//   it. The Escape branch below stops propagation, and that is the whole fix: the
//   dropdown owns Escape while it is open, and only once it is closed does the key mean
//   "close the dialog".
//
// Focus stays on the filter input while the arrow keys move a virtual cursor, published
// through aria-activedescendant. That is the pattern for a listbox with a filter — moving
// real DOM focus onto the options would take it away from the box being typed into.
// ---------------------------------------------------------------------------
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { SENTINEL_TABLES, DEFENDER_TABLES } from '../constants.js';
import { getTableDisplayName } from '../domain/tables.js';
import { FOCUS_RING } from './a11y.jsx';

const GROUPS = [
  { key: 'sentinel', label: 'Sentinel', color: '#e5c07b' },
  { key: 'defender', label: 'Defender', color: '#61afef' },
  { key: 'custom', label: 'Custom', color: '#8b8fa3' },
];

function TableSelector({ value, onChange, labelId }) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  // The virtually focused option. -1 means "no cursor yet", which the first ArrowDown
  // resolves to one end or the other.
  const [activeIndex, setActiveIndex] = useState(-1);
  const ref = useRef(null);
  const buttonRef = useRef(null);

  const baseId = useId();
  const buttonId = `${baseId}-button`;
  const listboxId = `${baseId}-listbox`;
  const optionId = useCallback((i) => `${baseId}-option-${i}`, [baseId]);

  // One flat list drives both the rendering and the arrow-key arithmetic; the grouping is
  // a presentation of it rather than a second source of truth that can fall out of step.
  const options = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matches = (t) => !term || t.toLowerCase().includes(term);
    return [
      ...SENTINEL_TABLES.filter(matches).map((t) => ({ value: t, group: 'sentinel' })),
      ...DEFENDER_TABLES.filter(matches).map((t) => ({ value: t, group: 'defender' })),
      // Custom is offered whatever the filter says — it is the escape hatch for a table
      // this build has never heard of, so filtering it away would strand the user.
      { value: 'Custom', group: 'custom' },
    ];
  }, [search]);

  const closeDropdown = useCallback((restoreFocus = true) => {
    setOpen(false);
    setSearch('');
    setActiveIndex(-1);
    // Focus has to come back to the trigger or it falls to <body> and the user loses
    // their place in the form. The outside-click path passes false, because there the
    // user has already chosen where focus should go.
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  const openDropdown = useCallback(() => {
    setOpen(true);
    // search is always '' while the dropdown is closed, so `options` here is the
    // unfiltered list and this index is the current value's real position in it.
    setActiveIndex(options.findIndex((o) => o.value === value));
  }, [options, value]);

  const selectAt = useCallback((index) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    closeDropdown();
  }, [options, onChange, closeDropdown]);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) closeDropdown(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [closeDropdown]);

  // Keep the virtual cursor on screen. jsdom implements no layout and therefore no
  // scrollIntoView, so this is guarded rather than assumed.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const el = document.getElementById(optionId(activeIndex));
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, optionId]);

  const moveActive = useCallback((delta) => {
    setActiveIndex((prev) => {
      if (options.length === 0) return -1;
      if (prev === -1) return delta > 0 ? 0 : options.length - 1;
      // Clamped rather than wrapped: a list that jumps from the last entry back to the
      // first gives no signal that it has ended.
      return Math.min(options.length - 1, Math.max(0, prev + delta));
    });
  }, [options.length]);

  const handleKeyDown = (e) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        openDropdown();
      }
      return;
    }
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        closeDropdown();
        return;
      case 'ArrowDown':
        e.preventDefault();
        moveActive(1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        moveActive(-1);
        return;
      case 'Home':
        e.preventDefault();
        setActiveIndex(0);
        return;
      case 'End':
        e.preventDefault();
        setActiveIndex(options.length - 1);
        return;
      case 'Enter':
        e.preventDefault();
        if (activeIndex >= 0) selectAt(activeIndex);
        return;
      case ' ':
        // Space is a printable character in the filter box, so it only selects when the
        // press came from somewhere that is not a text field.
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        e.preventDefault();
        if (activeIndex >= 0) selectAt(activeIndex);
        return;
      case 'Tab':
        // Let the key through so the surrounding dialog's focus trap moves on, but do not
        // leave an orphaned popup open behind it.
        closeDropdown(false);
        return;
      default:
    }
  };

  const displayValue = value ? getTableDisplayName(value) : 'Select table...';
  const activeId = activeIndex >= 0 && activeIndex < options.length ? optionId(activeIndex) : undefined;

  return (
    <div ref={ref} className="relative" onKeyDown={handleKeyDown}>
      <button ref={buttonRef} id={buttonId} type="button"
        onClick={() => (open ? closeDropdown() : openDropdown())}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        // The field label plus the current value, so this announces as "Table,
        // DeviceProcessEvents" rather than reading its own contents with no context.
        aria-labelledby={labelId ? `${labelId} ${buttonId}` : undefined}
        className={`w-full px-3 py-2 rounded-lg font-mono text-sm text-left flex items-center justify-between ${FOCUS_RING}`}
        style={{ background: '#1a1a2e', border: '1px solid #2a2a3e', color: value ? '#e0e0e0' : '#666' }}>
        <span className="truncate">{displayValue}</span>
        <ChevronDown size={14} className="text-gray-500 shrink-0" aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 rounded-lg overflow-hidden z-10 shadow-xl"
          style={{ background: '#1a1a2e', border: '1px solid #2a2a3e', maxHeight: 280, overflowY: 'auto' }}>
          <div className="p-2 sticky top-0" style={{ background: '#1a1a2e' }}>
            <input type="text" placeholder="Search tables..." value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                // Point the cursor at the best remaining match so Enter means something
                // immediately, and so the published activedescendant is never stale.
                setActiveIndex(0);
              }}
              aria-label="Search tables"
              aria-controls={listboxId}
              aria-activedescendant={activeId}
              className={`w-full px-2 py-1.5 rounded text-xs font-mono outline-none ${FOCUS_RING}`}
              style={{ background: '#12121a', border: '1px solid #2a2a3e', color: '#e0e0e0' }}
              autoFocus />
          </div>
          <div id={listboxId} role="listbox" aria-label="Table">
            {GROUPS.map((group) => {
              const entries = options
                .map((option, index) => ({ ...option, index }))
                .filter((option) => option.group === group.key);
              if (entries.length === 0) return null;
              const headingId = `${baseId}-group-${group.key}`;
              return (
                <div key={group.key} role="group" aria-labelledby={headingId}>
                  {/* Hidden from the accessibility tree because the group already carries
                      this text as its name; leaving it exposed announces it twice. */}
                  <div id={headingId} aria-hidden="true" className="px-3 py-1 text-xs font-bold" style={{ color: group.color }}>{group.label}</div>
                  {entries.map((option) => (
                    <div key={option.value} id={optionId(option.index)} role="option"
                      aria-selected={value === option.value}
                      onClick={() => selectAt(option.index)}
                      onMouseEnter={() => setActiveIndex(option.index)}
                      className="px-3 py-1.5 text-xs text-left cursor-pointer"
                      style={{
                        color: value === option.value ? group.color : '#aaa',
                        background: activeIndex === option.index ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
                      }}>{option.value}</div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export { TableSelector };
