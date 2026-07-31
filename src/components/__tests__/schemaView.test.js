// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// SchemaView against a stubbed fetch — no network, no database.
//
// Unlike the query shell components, SchemaView owns its own state and talks to
// StorageAdapter directly rather than reading from AppContext, so these tests stub
// `fetch` (fetchStub.js, the same double the adapter suite uses) and wrap the
// component in ToastContext only — the slice of context it actually consumes.
// ---------------------------------------------------------------------------
import { afterEach, describe, expect, it, vi } from 'vitest';
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

const GETSCHEMA_PASTE = 'ColumnName\tColumnType\nTimeGenerated\tSystem.DateTime\nAccount\tSystem.String';

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

/** Mount SchemaView wired to a toast spy, and let the initial fetchSchemas() settle. */
async function mount(handler) {
  const stub = stubFetch(handler);
  const addToast = vi.fn();
  const view = render(h(ToastContext.Provider, { value: { addToast } }, h(SchemaView)));
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
    expect(screen.getByText(/Keeping the stored 2 columns/)).toBeTruthy();

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

describe('deleting', () => {
  it('asks for confirmation, then DELETEs and removes the row', async () => {
    const { calls, addToast } = await mount(routes({ list: [SIGNIN_LOGS] }));
    await screen.findByText('SigninLogs');

    fireEvent.click(screen.getByRole('button', { name: 'Delete schema SigninLogs' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('SigninLogs')).toBeTruthy();

    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' })); });

    expect(callsTo(calls, '/api/schemas/SigninLogs', 'DELETE')).toHaveLength(1);
    expect(screen.queryByText('SigninLogs')).toBeNull();
    expect(addToast).toHaveBeenCalledWith(expect.stringContaining('deleted'), 'info');
  });

  it('closes without deleting on Cancel', async () => {
    const { calls } = await mount(routes({ list: [SIGNIN_LOGS] }));
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
