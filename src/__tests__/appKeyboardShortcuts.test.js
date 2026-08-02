// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// App's window-level keyboard shortcut handler, against a stubbed fetch.
//
// The handler was written before the Schemas tab existed and never learned about `view`
// (it was missing from the handler's own dependency array, so even a fix inside the
// handler body would have closed over a stale value). On the Schemas tab this meant
// Ctrl/Cmd+N opened the query editor on top of the schema form, and Ctrl/Cmd+K silently
// did nothing (searchRef belongs to SidebarContent, unmounted while view !== 'queries').
//
// This mounts the real App — not a shell component against AppContext, the way the other
// component suites do — because the bug is specifically about which view is active, which
// only exists as App's own `view` state. `/api/queries` and `/api/schemas` are stubbed
// empty; nothing else App talks to (health, import/export) is exercised here.
// ---------------------------------------------------------------------------
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from '../App.jsx';
import { response, stubFetch } from '../storage/__tests__/fetchStub.js';

function routes({ queries = [], schemas = [] } = {}) {
  return (call) => {
    if (call.url.includes('/api/queries') && call.method === 'GET') return response(queries);
    if (call.url.includes('/api/schemas') && call.method === 'GET') return response(schemas);
    return response({ ok: true });
  };
}

/** jsdom hands this environment an inert localStorage with no methods on it, and
 *  useKQLStorage reads/writes a cache on every load whether or not the test cares. */
function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
    clear: () => { data.clear(); },
    key: (i) => [...data.keys()][i] ?? null,
    get length() { return data.size; },
  };
}

async function mountApp() {
  stubFetch(routes());
  render(React.createElement(App));
  await screen.findByText('kql_store');
}

/** The handler is a raw window.addEventListener('keydown', ...), not a React synthetic
 *  handler, so a fireEvent dispatched on window reaches it the same way a real keypress
 *  would. */
function pressGlobal(key, opts = {}) {
  fireEvent.keyDown(window, { key, ...opts });
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('query shortcuts are scoped to the Queries tab', () => {
  it('Ctrl+N opens the query editor while on the Queries tab', async () => {
    await mountApp();
    pressGlobal('n', { ctrlKey: true });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('Ctrl+N does nothing on the Schemas tab, instead of opening the query editor over the schema form', async () => {
    await mountApp();
    fireEvent.click(screen.getByRole('tab', { name: 'Schemas' }));
    await screen.findByText(/No schemas stored yet/);

    pressGlobal('n', { ctrlKey: true });

    expect(screen.queryByRole('dialog')).toBeNull();
    // The schema form is still there, undisturbed.
    expect(screen.getByLabelText(/Table name/)).toBeTruthy();
  });

  it('Ctrl+K focuses the query search box while on the Queries tab', async () => {
    await mountApp();
    const search = screen.getByPlaceholderText(/Search queries/i);

    pressGlobal('k', { ctrlKey: true });

    expect(document.activeElement).toBe(search);
  });

  it('Ctrl+K does nothing on the Schemas tab (the query search box is unmounted there)', async () => {
    await mountApp();
    fireEvent.click(screen.getByRole('tab', { name: 'Schemas' }));
    await screen.findByText(/No schemas stored yet/);

    // Must not throw despite SidebarContent — and its search box — being unmounted.
    expect(() => pressGlobal('k', { ctrlKey: true })).not.toThrow();
    expect(screen.queryByPlaceholderText(/Search queries/i)).toBeNull();
  });
});

describe('Escape stays global', () => {
  it('closes the query editor even when it was opened while still on the Queries tab', async () => {
    await mountApp();
    pressGlobal('n', { ctrlKey: true });
    expect(screen.getByRole('dialog')).toBeTruthy();

    pressGlobal('Escape');

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
