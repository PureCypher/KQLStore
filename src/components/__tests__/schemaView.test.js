// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// SchemaView against a stubbed fetch — no network, no database.
//
// Unlike the query shell components, SchemaView owns its own state and talks to
// StorageAdapter directly rather than reading from AppContext, so these tests stub
// `fetch` (fetchStub.js, the same double the adapter suite uses) and wrap the
// component in ToastContext only — the slice of context it actually consumes.
//
// nameInput/pasteText/notesInput are no longer SchemaView's own state (App owns them now,
// so a tab switch does not unmount-and-lose an in-progress paste — see the "form field
// persistence" describe block below). SchemaView takes them as controlled props instead,
// so every mount here goes through SchemaViewHost, a tiny stand-in for the slice of App
// that owns that state, rather than App itself — App also owns useKQLStorage, which talks
// to a different set of endpoints (/api/queries, /api/health) this suite has no reason to
// stub.
// ---------------------------------------------------------------------------
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { h } from './harness.js';
import { ToastContext } from '../../context/toast.js';
import { SchemaView } from '../SchemaView.jsx';
import { parseGetSchema } from '../../domain/getschema.js';
import { response, stubFetch, callsTo } from '../../storage/__tests__/fetchStub.js';

const SIGNIN_LOGS = {
  name: 'SigninLogs',
  columns: [{ name: 'TimeGenerated', type: 'datetime' }, { name: 'UserPrincipalName', type: 'string' }],
  notes: 'Entra sign-in events',
  source: 'getschema',
  updated: '2026-01-01T00:00:00.000Z',
};

const DEVICE_INFO = { ...SIGNIN_LOGS, name: 'DeviceInfo' };

const GETSCHEMA_PASTE = 'ColumnName\tColumnType\nTimeGenerated\tSystem.DateTime\nAccount\tSystem.String';

/** Stand-in for the slice of App that now owns the three form fields. */
function SchemaViewHost({ initialName = '', initialPaste = '', initialNotes = '' } = {}) {
  const [nameInput, setNameInput] = useState(initialName);
  const [pasteText, setPasteText] = useState(initialPaste);
  const [notesInput, setNotesInput] = useState(initialNotes);
  return h(SchemaView, { nameInput, setNameInput, pasteText, setPasteText, notesInput, setNotesInput });
}

/** Route by path/method; anything not overridden gets a bland empty-list success. */
function routes({ list = [], onPut, onDelete } = {}) {
  return (call) => {
    if (call.url.startsWith('/api/schemas') && call.method === 'GET') return response(list);
    if (call.url.startsWith('/api/schemas') && call.method === 'PUT') {
      return onPut ? onPut(call) : response({ name: decodeURIComponent(call.url.split('/').pop()), ...call.body, updated: 'now' });
    }
    if (call.url.startsWith('/api/schemas') && call.method === 'DELETE') {
      return onDelete ? onDelete(call) : response({ deleted: decodeURIComponent(call.url.split('/').pop()) });
    }
    return response({ ok: true });
  };
}

/** Mount SchemaView (via its host) wired to a toast spy, and let fetchSchemas() settle. */
async function mount(handler, hostProps) {
  const stub = stubFetch(handler);
  const addToast = vi.fn();
  const view = render(h(ToastContext.Provider, { value: { addToast } }, h(SchemaViewHost, hostProps)));
  await act(async () => {});
  return { ...stub, ...view, addToast };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('loading the schema list', () => {
  it('renders every stored schema with its column count and source', async () => {
    await mount(routes({ list: [SIGNIN_LOGS] }));
    const row = (await screen.findByText('SigninLogs')).closest('li');
    expect(within(row).getByText(/2 columns/)).toBeTruthy();
    expect(within(row).getByText(/getschema/)).toBeTruthy();
  });

  it('says so when nothing is stored', async () => {
    await mount(routes({ list: [] }));
    expect(await screen.findByText(/No schemas stored yet/)).toBeTruthy();
  });

  it('surfaces the server message and offers a retry when the list fails to load', async () => {
    const { calls } = await mount(() => response({ error: 'DB unavailable' }, { status: 500, statusText: 'Internal Server Error' }));
    expect(await screen.findByText(/DB unavailable/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await act(async () => {});
    expect(callsTo(calls, '/api/schemas', 'GET').length).toBeGreaterThan(1);
  });
});

describe('search', () => {
  it('filters the list to schemas whose name matches', async () => {
    await mount(routes({ list: [SIGNIN_LOGS, { ...SIGNIN_LOGS, name: 'DeviceInfo' }] }));
    await screen.findByText('SigninLogs');
    fireEvent.change(screen.getByLabelText('Search schemas'), { target: { value: 'device' } });
    expect(screen.queryByText('SigninLogs')).toBeNull();
    expect(screen.getByText('DeviceInfo')).toBeTruthy();
  });
});

describe('the paste box', () => {
  it('shows the parsed column count for valid getschema output', async () => {
    await mount(routes({ list: [] }));
    await screen.findByText(/No schemas stored yet/);
    fireEvent.change(screen.getByLabelText(/Paste `\| getschema`/), { target: { value: GETSCHEMA_PASTE } });
    expect(screen.getByText('2 columns parsed.')).toBeTruthy();
  });

  it("shows the parser's error verbatim for a paste that is not getschema output", async () => {
    await mount(routes({ list: [] }));
    await screen.findByText(/No schemas stored yet/);
    const garbage = 'this has no valid column identifiers';
    fireEvent.change(screen.getByLabelText(/Paste `\| getschema`/), { target: { value: garbage } });
    const expected = parseGetSchema(garbage).error;
    expect(screen.getByText(expected)).toBeTruthy();
  });
});

describe('saving', () => {
  it('disables Save until a name and parsed columns are both present', async () => {
    await mount(routes({ list: [] }));
    await screen.findByText(/No schemas stored yet/);
    const save = screen.getByRole('button', { name: 'Save Schema' });
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Table name/), { target: { value: 'NewTable' } });
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/Paste `\| getschema`/), { target: { value: GETSCHEMA_PASTE } });
    expect(save.disabled).toBe(false);
  });

  it('PUTs the parsed columns under the typed name with source getschema', async () => {
    const { calls } = await mount(routes({ list: [] }));
    await screen.findByText(/No schemas stored yet/);
    fireEvent.change(screen.getByLabelText(/Table name/), { target: { value: 'NewTable' } });
    fireEvent.change(screen.getByLabelText(/Paste `\| getschema`/), { target: { value: GETSCHEMA_PASTE } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'from a hunt' } });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Schema' })); });

    const [put] = callsTo(calls, '/api/schemas/NewTable', 'PUT');
    expect(put.body).toEqual({
      columns: parseGetSchema(GETSCHEMA_PASTE).columns,
      notes: 'from a hunt',
      source: 'getschema',
    });
  });

  it('keeps the stored columns when the paste box is left empty on an edit', async () => {
    const { calls } = await mount(routes({ list: [SIGNIN_LOGS] }));
    fireEvent.click(await screen.findByText('SigninLogs'));

    const nameField = screen.getByLabelText(/Table name/);
    expect(nameField.value).toBe('SigninLogs');
    expect(nameField.disabled).toBe(true);
    // Two nodes carry this text at rest — the visible hint and its debounced, sr-only
    // announcer (see "paste hint accessibility" below) — so this checks there are exactly
    // the two expected matches rather than asserting on a single ambiguous one.
    expect(screen.getAllByText(/Keeping the stored 2 columns/)).toHaveLength(2);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update Schema' })); });

    const [put] = callsTo(calls, '/api/schemas/SigninLogs', 'PUT');
    expect(put.body).toEqual({ columns: SIGNIN_LOGS.columns, notes: SIGNIN_LOGS.notes, source: SIGNIN_LOGS.source });
  });

  it('reports the server message on a failed save', async () => {
    const { addToast } = await mount(routes({
      list: [],
      onPut: () => response({ error: '"columns" exceeds 500 entries' }, { status: 400, statusText: 'Bad Request' }),
    }));
    await screen.findByText(/No schemas stored yet/);
    fireEvent.change(screen.getByLabelText(/Table name/), { target: { value: 'NewTable' } });
    fireEvent.change(screen.getByLabelText(/Paste `\| getschema`/), { target: { value: GETSCHEMA_PASTE } });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Schema' })); });

    expect(addToast).toHaveBeenCalledWith(expect.stringContaining('"columns" exceeds 500 entries'), 'error');
  });
});

describe('overwrite guard on a direct (typed-name) save', () => {
  // Store holds SigninLogs (2 columns, notes). Typing "SigninLogs" into the free-text name
  // field — instead of clicking the existing row — is indistinguishable from a brand new
  // table name until the moment Save is clicked: PUT is an upsert, so it would silently
  // replace the stored columns and blank the notes to '' with a plain "saved" toast. This
  // is the only destructive action in the component that had no confirmation.
  it('blocks the PUT and asks for confirmation instead of overwriting silently', async () => {
    const { calls } = await mount(routes({ list: [SIGNIN_LOGS] }));
    await screen.findByText('SigninLogs');

    fireEvent.change(screen.getByLabelText(/Table name/), { target: { value: 'SigninLogs' } });
    fireEvent.change(screen.getByLabelText(/Paste `\| getschema`/), { target: { value: GETSCHEMA_PASTE } });
    // Notes left empty, as in the failure scenario.

    fireEvent.click(screen.getByRole('button', { name: 'Save Schema' }));

    expect(callsTo(calls, '/api/schemas/SigninLogs', 'PUT')).toHaveLength(0);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('SigninLogs')).toBeTruthy();
  });

  it('cancelling sends no request and leaves the stored schema untouched', async () => {
    const { calls } = await mount(routes({ list: [SIGNIN_LOGS] }));
    await screen.findByText('SigninLogs');
    fireEvent.change(screen.getByLabelText(/Table name/), { target: { value: 'SigninLogs' } });
    fireEvent.change(screen.getByLabelText(/Paste `\| getschema`/), { target: { value: GETSCHEMA_PASTE } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Schema' }));

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(callsTo(calls, '/api/schemas/SigninLogs', 'PUT')).toHaveLength(0);
  });

  it('confirming proceeds with the same PUT the unguarded save would have sent', async () => {
    const { calls } = await mount(routes({ list: [SIGNIN_LOGS] }));
    await screen.findByText('SigninLogs');
    fireEvent.change(screen.getByLabelText(/Table name/), { target: { value: 'SigninLogs' } });
    fireEvent.change(screen.getByLabelText(/Paste `\| getschema`/), { target: { value: GETSCHEMA_PASTE } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Schema' }));

    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Overwrite' }));
    });

    const [put] = callsTo(calls, '/api/schemas/SigninLogs', 'PUT');
    expect(put.body).toEqual({ columns: parseGetSchema(GETSCHEMA_PASTE).columns, notes: '', source: 'getschema' });
  });

  it('does not prompt when the row was reached by selecting it from the list', async () => {
    const { calls } = await mount(routes({ list: [SIGNIN_LOGS] }));
    fireEvent.click(await screen.findByText('SigninLogs'));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update Schema' })); });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(callsTo(calls, '/api/schemas/SigninLogs', 'PUT')).toHaveLength(1);
  });

  it('does not prompt for a name that is genuinely new', async () => {
    const { calls } = await mount(routes({ list: [SIGNIN_LOGS] }));
    await screen.findByText('SigninLogs');
    fireEvent.change(screen.getByLabelText(/Table name/), { target: { value: 'DeviceInfo' } });
    fireEvent.change(screen.getByLabelText(/Paste `\| getschema`/), { target: { value: GETSCHEMA_PASTE } });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Schema' })); });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(callsTo(calls, '/api/schemas/DeviceInfo', 'PUT')).toHaveLength(1);
  });
});

describe('paste hint accessibility', () => {
  // The visible hint under the paste box updates on every keystroke (parseGetSchema is
  // cheap to re-run live) — that part is fine and expected. The bug was that it also sat
  // on the aria-live="polite" node, so a screen-reader user typing a long paste heard a new
  // announcement interrupt the last one on every character. The fix moves the live
  // announcement to a separate, debounced node: settled outcomes only.
  it('does not update the live region on every keystroke, only once typing settles', async () => {
    vi.useFakeTimers();
    try {
      stubFetch(routes({ list: [] }));
      render(h(ToastContext.Provider, { value: { addToast: vi.fn() } }, h(SchemaViewHost)));
      // findByText's polling wait is timer-based, which never advances under fake timers —
      // the initial fetchSchemas() promise (no timers involved) has already settled by the
      // time act() returns, so a synchronous query is used instead.
      await act(async () => {});
      expect(screen.getByText(/No schemas stored yet/)).toBeTruthy();

      const live = screen.getByRole('status');
      expect(live.textContent).toBe('Paste getschema output to add columns.');

      const paste = screen.getByLabelText(/Paste `\| getschema`/);
      const visibleHint = document.getElementById(paste.getAttribute('aria-describedby'));

      fireEvent.change(paste, { target: { value: 'Col' } });
      // The visible (non-live) hint reacts immediately to a keystroke...
      expect(visibleHint.textContent).toBe('1 column parsed.');
      // ...but the live region — the one a screen reader actually hears — does not.
      expect(live.textContent).toBe('Paste getschema output to add columns.');

      fireEvent.change(paste, { target: { value: GETSCHEMA_PASTE } });
      await act(async () => { vi.advanceTimersByTime(499); });
      expect(live.textContent).toBe('Paste getschema output to add columns.');

      await act(async () => { vi.advanceTimersByTime(2); });
      expect(live.textContent).toBe('2 columns parsed.');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('form field persistence across an unmount/remount (App owns the fields now)', () => {
  /** Stands in for App: switches SchemaView in and out of the DOM, owning the form state
   *  the way App now does, so unmounting SchemaView does not discard it. */
  function TabHost() {
    const [tab, setTab] = useState('schemas');
    const [nameInput, setNameInput] = useState('');
    const [pasteText, setPasteText] = useState('');
    const [notesInput, setNotesInput] = useState('');
    return h(
      'div',
      null,
      h('button', { onClick: () => setTab('other') }, 'Other tab'),
      h('button', { onClick: () => setTab('schemas') }, 'Schemas tab'),
      tab === 'schemas' && h(SchemaView, { nameInput, setNameInput, pasteText, setPasteText, notesInput, setNotesInput }),
    );
  }

  it('keeps a pasted dump and hand-typed notes after the panel unmounts and remounts', async () => {
    stubFetch(routes({ list: [] }));
    render(h(ToastContext.Provider, { value: { addToast: vi.fn() } }, h(TabHost)));
    await act(async () => {});
    await screen.findByText(/No schemas stored yet/);

    fireEvent.change(screen.getByLabelText(/Paste `\| getschema`/), { target: { value: GETSCHEMA_PASTE } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'from a hunt' } });

    fireEvent.click(screen.getByRole('button', { name: 'Other tab' }));
    expect(screen.queryByLabelText(/Paste `\| getschema`/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Schemas tab' }));
    await act(async () => {});

    expect(screen.getByLabelText(/Paste `\| getschema`/).value).toBe(GETSCHEMA_PASTE);
    expect(screen.getByLabelText('Notes').value).toBe('from a hunt');
  });
});

describe('deleting', () => {
  // Two rows, and the confirmed deletion targets the second one. A fixture with only one
  // row would pass this even if the handler deleted schemas[0].name instead of the
  // confirmed target — asserting the request URL names DeviceInfo, and that SigninLogs
  // survives, is what actually pins the handler to the row the user confirmed.
  it('DELETEs the confirmed row by name and leaves the other one alone', async () => {
    const { calls, addToast } = await mount(routes({ list: [SIGNIN_LOGS, DEVICE_INFO] }));
    await screen.findByText('SigninLogs');
    await screen.findByText('DeviceInfo');

    fireEvent.click(screen.getByRole('button', { name: 'Delete schema DeviceInfo' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('DeviceInfo')).toBeTruthy();

    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' })); });

    expect(callsTo(calls, '/api/schemas/DeviceInfo', 'DELETE')).toHaveLength(1);
    expect(callsTo(calls, '/api/schemas/SigninLogs', 'DELETE')).toHaveLength(0);
    expect(screen.queryByText('DeviceInfo')).toBeNull();
    expect(screen.getByText('SigninLogs')).toBeTruthy();
    expect(addToast).toHaveBeenCalledWith(expect.stringContaining('deleted'), 'info');
  });

  it('closes without deleting on Cancel', async () => {
    const { calls } = await mount(routes({ list: [SIGNIN_LOGS, DEVICE_INFO] }));
    await screen.findByText('SigninLogs');
    fireEvent.click(screen.getByRole('button', { name: 'Delete schema SigninLogs' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(callsTo(calls, '/api/schemas/SigninLogs', 'DELETE')).toHaveLength(0);
    expect(screen.getByText('SigninLogs')).toBeTruthy();
  });
});

describe('JSON import', () => {
  it('previews add/update/error rows and PUTs only the accepted ones with source import', async () => {
    const { calls, addToast } = await mount(routes({ list: [SIGNIN_LOGS] }));
    await screen.findByText('SigninLogs');

    const file = new File(
      [JSON.stringify({
        schemas: [
          { name: 'SigninLogs', columns: [{ name: 'X', type: 'string' }] }, // update
          { name: 'DeviceInfo', columns: [{ name: 'Y', type: 'string' }] }, // add
          { name: '', columns: [] }, // error: no name
        ],
      })],
      'schemas.json',
      { type: 'application/json' },
    );
    const fileInput = document.querySelector('input[type="file"]');
    await act(async () => { fireEvent.change(fileInput, { target: { files: [file] } }); });

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('1 new')).toBeTruthy();
    expect(within(dialog).getByText('1 updated')).toBeTruthy();
    expect(within(dialog).getByText('1 invalid')).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /^Import 2 Schemas$/ }));
    });

    const puts = callsTo(calls, '/api/schemas', 'PUT');
    expect(puts.map((p) => p.url).sort()).toEqual(['/api/schemas/DeviceInfo', '/api/schemas/SigninLogs']);
    expect(puts.every((p) => p.body.source === 'import')).toBe(true);
    expect(addToast).toHaveBeenCalledWith(expect.stringContaining('2 imported'), 'error');
  });
});

describe('export', () => {
  it('re-fetches the schema list and offers it as a download', async () => {
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() });
    const { calls } = await mount(routes({ list: [SIGNIN_LOGS] }));
    await screen.findByText('SigninLogs');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Export all schemas to a JSON file' })); });

    expect(callsTo(calls, '/api/schemas', 'GET').length).toBeGreaterThanOrEqual(2);
    expect(URL.createObjectURL).toHaveBeenCalled();
  });
});
