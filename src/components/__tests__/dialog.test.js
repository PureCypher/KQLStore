// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// Keyboard and focus behaviour of the dialogs and the table dropdown.
//
// This is the half of accessibility axe cannot see. axe reads a static tree and reports
// on attributes; it has nothing to say about whether Tab escapes a dialog, whether Escape
// destroys a draft, or whether Tab is captured with no way out. Those are the failures
// that actually locked a keyboard user out of this app, so they are asserted here against
// the real components rather than a stand-in.
//
// A window-level keydown spy appears throughout. App.jsx installs exactly such a listener
// and closes the editor from it, so "the spy did not fire" is the direct test of the
// stopPropagation contract that keeps a draft alive.
// ---------------------------------------------------------------------------
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

import { AppContext } from '../../context/app.js';
import { h, makeAppValue, renderWithApp, SAMPLE_IMPORT_PREVIEW, SAMPLE_QUERY, SAMPLE_STORAGE } from './harness.js';
import { getFocusable } from '../a11y.jsx';
import { BulkActionBar } from '../BulkActionBar.jsx';
import { CodeBlock } from '../CodeBlock.jsx';
import { ImportPreviewModal } from '../ImportPreviewModal.jsx';
import { KeyboardHelp } from '../KeyboardHelp.jsx';
import { Modal } from '../Modal.jsx';
import { QueryCard } from '../QueryCard.jsx';
import { QueryEditorModal } from '../QueryEditorModal.jsx';
import { SidebarContent } from '../SidebarContent.jsx';
import { StorageInspector } from '../StorageInspector.jsx';
import { TableSelector } from '../TableSelector.jsx';
import { ToastContainer } from '../ToastContainer.jsx';

/** Install a window-level Escape listener standing in for the one App.jsx registers. */
function spyOnWindowKeydown() {
  const spy = vi.fn();
  window.addEventListener('keydown', spy);
  return { spy, remove: () => window.removeEventListener('keydown', spy) };
}

/** The name a screen reader would compute, in the order the accname spec resolves it. */
function accessibleName(el) {
  const label = el.getAttribute('aria-label');
  if (label && label.trim()) return label.trim();
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || '')
      .join(' ')
      .trim();
    if (text) return text;
  }
  if (el.textContent && el.textContent.trim()) return el.textContent.trim();
  const title = el.getAttribute('title');
  return title && title.trim() ? title.trim() : '';
}

const openEditor = (overrides = {}) =>
  renderWithApp(h(QueryEditorModal), { editingQuery: SAMPLE_QUERY, ...overrides });

// vitest runs without injected globals, so Testing Library's own auto-cleanup never
// registers itself and every render would otherwise pile up in the same document.
// The second line clears the stand-in "opener" nodes some cases append directly to the
// body, which cleanup() does not own and which would otherwise be found by later queries.
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('Modal semantics', () => {
  it('exposes a dialog named by its own heading', () => {
    const { getByRole } = renderWithApp(h(KeyboardHelp), { showKeyboardHelp: true });
    const dialog = getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const titleId = dialog.getAttribute('aria-labelledby');
    expect(titleId).toBeTruthy();
    expect(document.getElementById(titleId).textContent).toContain('Keyboard Shortcuts');
  });

  it('moves focus into the dialog on open', () => {
    const { getByRole } = renderWithApp(h(KeyboardHelp), { showKeyboardHelp: true });
    const dialog = getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(getFocusable(dialog)[0]);
  });

  it('returns focus to the element that opened it', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { rerender } = render(
      h(AppContext.Provider, { value: makeAppValue({ showKeyboardHelp: true }) }, h(KeyboardHelp)),
    );
    expect(document.activeElement).not.toBe(opener);

    // Closing is unmounting for these modals — the parent stops rendering them.
    rerender(h(AppContext.Provider, { value: makeAppValue({ showKeyboardHelp: false }) }, h(KeyboardHelp)));
    expect(document.activeElement).toBe(opener);
  });
});

describe('focus trap', () => {
  // The import dialog is the one with no field that claims Tab for itself, so it shows
  // the trap's plain behaviour. The editor's KQL box deliberately swallows Tab, which is
  // covered by its own suite below.
  it('cycles Tab through the dialog and never leaves it', () => {
    const { getByRole } = renderWithApp(h(ImportPreviewModal), { importPreview: SAMPLE_IMPORT_PREVIEW });
    const dialog = getByRole('dialog');
    const focusable = getFocusable(dialog);
    // A dialog with one focusable element cannot demonstrate a cycle.
    expect(focusable.length).toBeGreaterThan(2);

    // Two full laps, so wrapping past the last element is exercised rather than assumed.
    const visited = [];
    for (let i = 0; i < focusable.length * 2; i++) {
      fireEvent.keyDown(document.activeElement, { key: 'Tab' });
      expect(dialog.contains(document.activeElement)).toBe(true);
      visited.push(document.activeElement);
    }
    expect(visited[focusable.length]).toBe(visited[0]);
    expect(new Set(visited).size).toBe(focusable.length);
  });

  it('wraps from the last control back to the first in the editor', () => {
    const { getByRole } = openEditor();
    const dialog = getByRole('dialog');
    const focusable = getFocusable(dialog);

    focusable[focusable.length - 1].focus();
    fireEvent.keyDown(document.activeElement, { key: 'Tab' });
    expect(document.activeElement).toBe(focusable[0]);
  });

  it('cycles backwards on Shift+Tab and wraps to the last element', () => {
    const { getByRole } = openEditor();
    const dialog = getByRole('dialog');
    const focusable = getFocusable(dialog);

    expect(document.activeElement).toBe(focusable[0]);
    fireEvent.keyDown(document.activeElement, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(focusable[focusable.length - 1]);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('holds focus on the panel when the dialog contains nothing focusable', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    // Modal is exercised directly here because none of the three real dialogs can reach
    // this state — they all render a close button — but the branch exists and a dialog
    // whose only content is text must still not leak focus to the page behind it.
    const { getByRole } = renderWithApp(h(Modal, { onClose: () => {} }, h('p', null, 'nothing to focus')));
    const dialog = getByRole('dialog');
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(dialog);
  });

  it('keeps Tab away from anything outside the dialog', () => {
    const outside = document.createElement('button');
    outside.textContent = 'outside';
    document.body.appendChild(outside);

    const { getByRole } = renderWithApp(h(ImportPreviewModal), { importPreview: SAMPLE_IMPORT_PREVIEW });
    const dialog = getByRole('dialog');
    for (let i = 0; i < 10; i++) {
      fireEvent.keyDown(document.activeElement, { key: 'Tab' });
      expect(document.activeElement).not.toBe(outside);
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });
});

describe('dismissal', () => {
  it('closes on Escape without letting the key reach the window handler', () => {
    const onClose = vi.fn();
    const { spy, remove } = spyOnWindowKeydown();
    renderWithApp(h(KeyboardHelp), { showKeyboardHelp: true, setShowKeyboardHelp: onClose });

    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledWith(false);
    // App.jsx's global handler would close a second modal off the same keypress.
    expect(spy).not.toHaveBeenCalled();
    remove();
  });

  it('closes on a backdrop click but not on a click inside the dialog', () => {
    const onClose = vi.fn();
    const { getByRole } = renderWithApp(h(KeyboardHelp), { showKeyboardHelp: true, setShowKeyboardHelp: onClose });
    const dialog = getByRole('dialog');
    const backdrop = dialog.parentElement;

    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores a release on the backdrop that began inside the dialog', () => {
    const onClose = vi.fn();
    const { getByRole } = renderWithApp(h(KeyboardHelp), { showKeyboardHelp: true, setShowKeyboardHelp: onClose });
    const dialog = getByRole('dialog');
    const backdrop = dialog.parentElement;

    // Selecting text in the dialog and releasing outside it must not discard the dialog.
    fireEvent.mouseDown(dialog);
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('KQL editor Tab capture (WCAG 2.1.2)', () => {
  const getTextarea = (getByLabelText) => getByLabelText(/KQL Query/);

  it('indents with Tab while capture is on', () => {
    const { getByLabelText } = openEditor();
    const ta = getTextarea(getByLabelText);
    ta.focus();
    ta.setSelectionRange(0, 0);
    fireEvent.keyDown(ta, { key: 'Tab' });
    expect(ta.value).toBe('    ' + SAMPLE_QUERY.query);
    expect(document.activeElement).toBe(ta);
  });

  it('releases capture on Escape instead of closing the dialog', () => {
    const setEditingQuery = vi.fn();
    const { spy, remove } = spyOnWindowKeydown();
    const { getByLabelText, getByRole } = openEditor({ setEditingQuery });
    const ta = getTextarea(getByLabelText);
    ta.focus();

    fireEvent.keyDown(ta, { key: 'Escape' });
    // The draft survives: neither the dialog's own handler nor App's global one ran.
    expect(setEditingQuery).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(getByRole('dialog')).toBeTruthy();
    remove();
  });

  it('lets the next Tab move focus once capture is released', () => {
    const { getByLabelText, getByRole } = openEditor();
    const ta = getTextarea(getByLabelText);
    ta.focus();
    const before = ta.value;

    fireEvent.keyDown(ta, { key: 'Escape' });
    fireEvent.keyDown(ta, { key: 'Tab' });

    expect(ta.value).toBe(before);
    expect(document.activeElement).not.toBe(ta);
    expect(getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('states the current mode and points the field at it', () => {
    const { getByLabelText } = openEditor();
    const ta = getTextarea(getByLabelText);
    const hint = document.getElementById(ta.getAttribute('aria-describedby').split(' ')[0]);
    expect(hint.getAttribute('aria-live')).toBe('polite');
    expect(hint.textContent).toMatch(/Tab inserts four spaces/);

    ta.focus();
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(hint.textContent).toMatch(/Tab now moves to the next field/);
  });

  it('restores capture when the field is typed in again', () => {
    const { getByLabelText } = openEditor();
    const ta = getTextarea(getByLabelText);
    ta.focus();
    fireEvent.keyDown(ta, { key: 'Escape' });
    fireEvent.change(ta, { target: { value: 'DeviceInfo' } });

    ta.setSelectionRange(10, 10);
    fireEvent.keyDown(ta, { key: 'Tab' });
    expect(ta.value).toBe('DeviceInfo    ');
  });

  // The hint promises two ways back into indent mode — "typing here, OR leaving and
  // coming back". The typing half is covered above; this is the re-entry half, which is
  // the one a user hits by accident after tabbing out to fix the name and returning.
  // act() is required because a bare .focus() is not a Testing Library event and its
  // state update would otherwise still be queued when the assertion runs.
  it('restores capture when the field is left and focused again', () => {
    const { getByLabelText } = openEditor();
    const ta = getTextarea(getByLabelText);
    const hint = document.getElementById(ta.getAttribute('aria-describedby').split(' ')[0]);
    ta.focus();
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(hint.textContent).toMatch(/Tab now moves to the next field/);

    act(() => getByLabelText(/Name/).focus());
    act(() => ta.focus());

    expect(hint.textContent).toMatch(/Tab inserts four spaces/);
    ta.setSelectionRange(0, 0);
    fireEvent.keyDown(ta, { key: 'Tab' });
    expect(ta.value).toBe('    ' + SAMPLE_QUERY.query);
  });

  it('escapes the dialog on a second Escape, once capture is already released', () => {
    const setEditingQuery = vi.fn();
    const { getByLabelText } = openEditor({ setEditingQuery });
    const ta = getTextarea(getByLabelText);
    ta.focus();

    fireEvent.keyDown(ta, { key: 'Escape' });
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(setEditingQuery).toHaveBeenCalledWith(null);
  });
});

describe('TableSelector', () => {
  const openDropdown = (getByRole) => {
    fireEvent.click(getByRole('button', { name: /Table/ }));
    return getByRole('listbox');
  };

  it('describes itself as a collapsed listbox trigger', () => {
    const { getByRole } = renderWithApp(h(TableSelector, { value: 'DeviceInfo', onChange: () => {} }));
    const trigger = getByRole('button');
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(getByRole('listbox')).toBeTruthy();
  });

  it('marks the current value as the selected option', () => {
    const { getByRole, getAllByRole } = renderWithApp(h(TableSelector, { value: 'DeviceInfo', onChange: () => {} }));
    fireEvent.click(getByRole('button'));
    const selected = getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toBe('DeviceInfo');
  });

  it('navigates with the arrow keys, Home and End, and selects with Enter', () => {
    const onChange = vi.fn();
    const { getByRole, getAllByRole, getByLabelText } = renderWithApp(h(TableSelector, { value: 'SigninLogs', onChange }));
    fireEvent.click(getByRole('button'));
    const search = getByLabelText('Search tables');
    const options = getAllByRole('option');

    fireEvent.keyDown(search, { key: 'Home' });
    expect(search.getAttribute('aria-activedescendant')).toBe(options[0].id);

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(search.getAttribute('aria-activedescendant')).toBe(options[1].id);

    fireEvent.keyDown(search, { key: 'ArrowUp' });
    expect(search.getAttribute('aria-activedescendant')).toBe(options[0].id);

    fireEvent.keyDown(search, { key: 'End' });
    expect(search.getAttribute('aria-activedescendant')).toBe(options[options.length - 1].id);

    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('Custom');
  });

  it('filters to the typed term and keeps the virtual cursor on a real option', () => {
    const { getByRole, getAllByRole, getByLabelText } = renderWithApp(h(TableSelector, { value: 'SigninLogs', onChange: () => {} }));
    fireEvent.click(getByRole('button'));
    const search = getByLabelText('Search tables');
    fireEvent.change(search, { target: { value: 'Email' } });

    const options = getAllByRole('option');
    expect(options.every((o) => /Email|Custom/.test(o.textContent))).toBe(true);
    // A stale activedescendant would point at an id that no longer exists.
    expect(document.getElementById(search.getAttribute('aria-activedescendant'))).toBe(options[0]);
  });

  it('closes only itself on Escape, leaving the editor and its draft intact', () => {
    const setEditingQuery = vi.fn();
    const { spy, remove } = spyOnWindowKeydown();
    const { getByRole, queryByRole } = openEditor({ setEditingQuery });

    const listbox = openDropdown(getByRole);
    expect(listbox).toBeTruthy();

    fireEvent.keyDown(document.activeElement, { key: 'Escape' });

    expect(queryByRole('listbox')).toBeNull();
    // The three ways the editor could have died: its own handler, App's window handler,
    // or the Modal's Escape branch. None of them may have run.
    expect(setEditingQuery).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(getByRole('dialog')).toBeTruthy();
    remove();
  });

  it('returns focus to its trigger when it closes', () => {
    const { getByRole } = renderWithApp(h(TableSelector, { value: 'DeviceInfo', onChange: () => {} }));
    const trigger = getByRole('button');
    fireEvent.click(trigger);
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
  });
});

// Every state that renders an interactive control, so the sweeps below cover the app
// rather than a sample of it.
function renderEverything() {
  const cases = [
    ['KeyboardHelp', h(KeyboardHelp), { showKeyboardHelp: true }],
    ['QueryEditorModal', h(QueryEditorModal), { editingQuery: SAMPLE_QUERY }],
    ['ImportPreviewModal', h(ImportPreviewModal), { importPreview: SAMPLE_IMPORT_PREVIEW }],
    ['QueryCard', h(QueryCard, { query: SAMPLE_QUERY }), { queries: [SAMPLE_QUERY], selectedTags: ['powershell'] }],
    ['CodeBlock', h(CodeBlock, { query: SAMPLE_QUERY.query + '\n| take 1\n| take 2', queryId: 'q1' }), {}],
    ['BulkActionBar', h(BulkActionBar), { selectedIds: new Set(['q1']) }],
    ['SidebarContent', h(SidebarContent), {
      queries: [SAMPLE_QUERY],
      allTags: [['powershell', 3]],
      categoryCounts: { Hunting: 1 },
      searchTerm: 'powershell',
      hasActiveFilters: true,
      stats: { total: 1, byTable: { DeviceProcessEvents: 1 }, byTableGroup: { defender: 1 } },
    }],
    ['StorageInspector', h(StorageInspector, {
      visible: true,
      onClose: () => {},
      storage: SAMPLE_STORAGE,
      onForceBackup: () => {},
      onHealthCheck: async () => ({ ok: true, details: [], writable: true, readable: true, dataValid: true, estimatedSizeKB: 1 }),
      onPurge: () => {},
    }), {}],
    ['TableSelector', h(TableSelector, { value: 'DeviceInfo', onChange: () => {} }), {}],
  ];
  return cases.map(([name, element, overrides]) => ({ name, ...renderWithApp(element, overrides) }));
}

describe('control labelling and focus visibility', () => {
  it('gives every button an accessible name', () => {
    const unnamed = [];
    for (const { name, container, unmount } of renderEverything()) {
      for (const button of container.querySelectorAll('button')) {
        if (!accessibleName(button)) unnamed.push(`${name}: ${button.outerHTML.slice(0, 90)}`);
      }
      unmount();
    }
    expect(unnamed).toEqual([]);
  });

  it('gives every icon-only button a name that is not just its icon', () => {
    const iconOnly = [];
    for (const { name, container, unmount } of renderEverything()) {
      for (const button of container.querySelectorAll('button')) {
        const hasSvg = button.querySelector('svg') !== null;
        const hasText = button.textContent.trim().length > 0;
        if (hasSvg && !hasText) iconOnly.push([name, button.getAttribute('aria-label')]);
      }
      unmount();
    }
    // The audit is worthless if it found no icon buttons to check.
    expect(iconOnly.length).toBeGreaterThan(8);
    expect(iconOnly.filter(([, label]) => !label || !label.trim())).toEqual([]);
  });

  it('names every form field without relying on its placeholder', () => {
    const unnamed = [];
    for (const { name, container, unmount } of renderEverything()) {
      for (const field of container.querySelectorAll('input, textarea, select')) {
        const labelled = field.labels?.length > 0 || accessibleName(field);
        if (!labelled) unnamed.push(`${name}: ${field.outerHTML.slice(0, 90)}`);
      }
      unmount();
    }
    expect(unnamed).toEqual([]);
  });

  it('gives every tabbable control a visible focus indicator', () => {
    const bare = [];
    for (const { name, container, unmount } of renderEverything()) {
      for (const el of getFocusable(container)) {
        // Either the shared ring, or the pre-existing focus:ring the text inputs carry.
        if (!/focus-visible:ring-2|focus:ring-1/.test(el.className)) {
          bare.push(`${name}: ${el.outerHTML.slice(0, 90)}`);
        }
      }
      unmount();
    }
    expect(bare).toEqual([]);
  });
});

describe('status announcements', () => {
  it('renders the toast stack as a polite live region and errors as alerts', () => {
    const { getByRole, getAllByRole } = renderWithApp(
      h(ToastContainer),
      {
        toasts: [
          { id: 1, message: 'Query saved', type: 'success' },
          { id: 2, message: 'Failed to save query', type: 'error' },
        ],
      },
    );
    const region = getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(getAllByRole('alert').map((a) => a.textContent)).toEqual(['Failed to save query']);
  });
});
