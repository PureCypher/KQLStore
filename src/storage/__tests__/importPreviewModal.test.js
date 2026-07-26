// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// ImportPreviewModal — the two commit paths and what the user is shown before choosing.
//
// This suite lives next to the storage tests rather than in src/components/__tests__
// because it is about the import contract, not the dialog chrome: the classification, the
// field-level diff and which mode each button dispatches. The keyboard and axe coverage
// for this dialog stays where it is.
//
// The context value is built here rather than borrowed from the component harness so the
// suite states exactly which four values the dialog reads, and does not fail for reasons
// belonging to some other component's contract.
// ---------------------------------------------------------------------------
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import axe from 'axe-core';

import { AppContext } from '../../context/app.js';
import { ImportPreviewModal } from '../../components/ImportPreviewModal.jsx';

const h = React.createElement;
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

afterEach(cleanup);

function query(overrides = {}) {
  return {
    id: ID_A,
    name: 'Encoded PowerShell',
    query: 'DeviceProcessEvents | where ProcessCommandLine has "-enc"',
    description: 'Finds encoded command lines',
    category: 'Detection',
    table: 'DeviceProcessEvents',
    tags: ['powershell'],
    favorite: false,
    usageCount: 7,
    severity: 'Medium',
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Mount the dialog over a file and a store. `items` is the preview App computed when the
 * file was opened — the dialog has to work from that, not replace it.
 */
function open({ incoming, stored = [query()], items, willAdd = 0, willSkip = 0 }) {
  const confirmImport = vi.fn();
  const setImportPreview = vi.fn();
  const value = {
    queries: stored,
    confirmImport,
    setImportPreview,
    importPreview: {
      text: typeof incoming === 'string' ? incoming : JSON.stringify(incoming),
      preview: { items, willAdd, willSkip, willDuplicate: 0, willError: 0, total: items.length },
    },
  };
  return { confirmImport, setImportPreview, ...render(h(AppContext.Provider, { value }, h(ImportPreviewModal))) };
}

const collisionRow = { index: 0, name: 'Encoded PowerShell', status: 'skip', reason: 'Duplicate ID' };

describe('an id collision is no longer just "Duplicate ID"', () => {
  it('labels a newer incoming copy Update and lists the fields that move', () => {
    const { getAllByRole, getByText, container } = open({
      incoming: [query({ name: 'Encoded PowerShell v2', severity: 'High', tags: ['powershell', 'lolbin'], updated: '2026-06-01T00:00:00.000Z' })],
      items: [collisionRow],
      willSkip: 1,
    });

    expect(getAllByRole('listitem')[0].textContent).toContain('Update');
    expect(getByText('name, tags, severity')).toBeTruthy();
    expect(container.textContent).toContain('1 newer, can update');
    expect(container.textContent).not.toContain('Duplicate ID');
  });

  it('labels the stored copy winning as Older and offers no overwrite', () => {
    const { getByText, queryByRole, container } = open({
      incoming: [query({ name: 'Stale rename', updated: '2025-01-01T00:00:00.000Z' })],
      items: [collisionRow],
      willSkip: 1,
    });

    expect(getByText('Older')).toBeTruthy();
    expect(container.textContent).toContain('1 older than stored');
    expect(queryByRole('button', { name: /update/i })).toBeNull();
  });

  it('labels a no-op resend as Same', () => {
    const { getByText, queryByRole } = open({
      incoming: [query({ updated: '2030-01-01T00:00:00.000Z' })],
      items: [collisionRow],
      willSkip: 1,
    });

    expect(getByText('Same')).toBeTruthy();
    expect(queryByRole('button', { name: /update/i })).toBeNull();
  });

  it('puts the full field list in the title when it is too long for the row', () => {
    const { getByText } = open({
      incoming: [query({
        name: 'v2', description: 'new', category: 'Hunting', tags: ['a'], favorite: true,
        severity: 'High', updated: '2026-06-01T00:00:00.000Z',
      })],
      items: [collisionRow],
      willSkip: 1,
    });

    const cell = getByText(/^name, description, category, tags \+2 more$/);
    expect(cell.getAttribute('title')).toBe('Changes: name, description, category, tags, favorite, severity');
  });
});

describe('the two commit paths', () => {
  it('keeps the default button insert-only', () => {
    const { confirmImport, getByRole } = open({
      incoming: [query({ name: 'v2', updated: '2026-06-01T00:00:00.000Z' }), query({ id: ID_B, name: 'New Rule', query: 'SigninLogs | take 1' })],
      items: [collisionRow, { index: 1, name: 'New Rule', status: 'add', reason: null }],
      willAdd: 1,
      willSkip: 1,
    });

    fireEvent.click(getByRole('button', { name: 'Import 1 Query' }));

    expect(confirmImport).toHaveBeenCalledWith({ mode: 'insert' });
  });

  it('asks for an upsert only from the separate, explicitly labelled button', () => {
    const { confirmImport, getByRole } = open({
      incoming: [query({ name: 'v2', updated: '2026-06-01T00:00:00.000Z' }), query({ id: ID_B, name: 'New Rule', query: 'SigninLogs | take 1' })],
      items: [collisionRow, { index: 1, name: 'New Rule', status: 'add', reason: null }],
      willAdd: 1,
      willSkip: 1,
    });

    fireEvent.click(getByRole('button', { name: 'Import 1 + update 1' }));

    expect(confirmImport).toHaveBeenCalledWith({ mode: 'upsert' });
  });

  it('names the update on its own when the file brings nothing new', () => {
    const { getByRole } = open({
      incoming: [query({ name: 'v2', updated: '2026-06-01T00:00:00.000Z' })],
      items: [collisionRow],
      willSkip: 1,
    });

    expect(getByRole('button', { name: 'Update 1 existing' })).toBeTruthy();
    // The insert button is still there and still disabled — nothing to insert.
    expect(getByRole('button', { name: 'Import 0 Queries' }).disabled).toBe(true);
  });
});

describe('accessibility of the states axe cannot otherwise reach', () => {
  // The audit in src/components/__tests__/a11y.test.js renders this dialog over an empty
  // file, so none of the collision UI exists in it. Same rule exclusions as that suite:
  // the document-level landmark rules cannot be satisfied by a mounted fragment, and jsdom
  // performs no layout so contrast is not evaluable here.
  const AXE_OPTIONS = {
    rules: Object.fromEntries(
      ['region', 'landmark-one-main', 'page-has-heading-one', 'bypass', 'color-contrast']
        .map((id) => [id, { enabled: false }]),
    ),
  };

  it('reports no violations with updates listed and both commit buttons present', async () => {
    const { container } = open({
      incoming: [query({ name: 'v2', severity: 'High', updated: '2026-06-01T00:00:00.000Z' }), query({ id: ID_B, name: 'New Rule', query: 'SigninLogs | take 1' })],
      items: [collisionRow, { index: 1, name: 'New Rule', status: 'add', reason: null }],
      willAdd: 1,
      willSkip: 1,
    });

    const { violations } = await axe.run(container, AXE_OPTIONS);

    expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});

describe('degrading safely', () => {
  it('falls back to the preview it was given when the file cannot be re-read', () => {
    // A file from a newer build, which readImportFile refuses. The dialog must still
    // render App's verdict rather than blanking or throwing.
    const { getByText, queryByRole, container } = open({
      incoming: JSON.stringify({ schemaVersion: 99, queries: [query()] }),
      items: [collisionRow],
      willSkip: 1,
    });

    expect(getByText('Skip')).toBeTruthy();
    expect(getByText('Duplicate ID')).toBeTruthy();
    expect(container.textContent).not.toContain('can update');
    expect(queryByRole('button', { name: /update/i })).toBeNull();
  });

  it('leaves rows that were never collisions exactly as App classified them', () => {
    const { getByText } = open({
      incoming: [query({ id: ID_B, name: 'Broken', query: '' })],
      items: [{ index: 0, name: 'Broken', status: 'error', reason: 'query must be a string of 1-50000 characters' }],
    });

    expect(getByText('Invalid')).toBeTruthy();
    expect(getByText('query must be a string of 1-50000 characters')).toBeTruthy();
  });

  it('shows nothing to do when the store already holds everything', () => {
    const { container, queryByRole } = open({
      incoming: [query()],
      items: [collisionRow],
      willSkip: 1,
    });

    expect(container.textContent).toContain('No new queries to import.');
    expect(queryByRole('button', { name: /update/i })).toBeNull();
  });
});
