// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, cleanup } from '@testing-library/react';
import { h, renderWithApp } from './harness.js';
import { QueryEditorModal } from '../QueryEditorModal.jsx';
import { LintPanel } from '../LintPanel.jsx';

/**
 * Regression: the editor used to be rendered unconditionally and returned null internally
 * when closed, so it never unmounted and its form state survived close/reopen. A draft
 * leaked into the next new query, and — worse — opening an EXISTING query showed the
 * previous draft instead of that query's contents. The parent now mounts it only while
 * open and keys it on the target query; these assert the resulting behaviour.
 */
describe('query editor state isolation', () => {
  const openWith = (editingQuery, key) => renderWithApp(
    h(QueryEditorModal, { key }),
    { editingQuery, saveQuery: vi.fn(), setEditingQuery: vi.fn() },
  );

  it('derives its fields from the query it was opened with', () => {
    openWith({ id: 'a', name: 'Existing query', query: 'SigninLogs | take 5', tags: ['x'] }, 'a');
    expect(screen.getByDisplayValue('Existing query')).toBeTruthy();
    cleanup();
  });

  it('a fresh mount for a new query starts blank', () => {
    // First open: type into the name field, then unmount as closing does.
    openWith({}, 'new');
    const name = screen.getByLabelText(/^Name/);
    fireEvent.change(name, { target: { value: 'FIRST DRAFT' } });
    expect(screen.getByDisplayValue('FIRST DRAFT')).toBeTruthy();
    cleanup();

    // Second open with the same key but a fresh mount: nothing should carry over.
    openWith({}, 'new');
    expect(screen.queryByDisplayValue('FIRST DRAFT')).toBeNull();
    cleanup();
  });

  it('a different query id yields that query, not the previous draft', () => {
    openWith({ id: 'a', name: 'Query A', query: 'A | take 1' }, 'a');
    cleanup();
    openWith({ id: 'b', name: 'Query B', query: 'B | take 1' }, 'b');
    expect(screen.getByDisplayValue('Query B')).toBeTruthy();
    expect(screen.queryByDisplayValue('Query A')).toBeNull();
    cleanup();
  });
});

describe('lint panel', () => {
  it('says nothing for an empty query', () => {
    const { container } = renderWithApp(h(LintPanel, { query: '' }), {});
    expect(container.textContent.trim()).toBe('');
    cleanup();
  });

  it('reports a clean query as clean', () => {
    renderWithApp(h(LintPanel, {
      query: 'DeviceProcessEvents\n| where Timestamp > ago(7d)\n| where FileName in~ ("a.exe")\n| project Timestamp, DeviceName\n| order by Timestamp desc',
    }), {});
    expect(screen.getByText(/No lint findings/)).toBeTruthy();
    cleanup();
  });

  it('summarises findings and lists them with a line reference', () => {
    renderWithApp(h(LintPanel, {
      query: 'SecurityEvent\n| where Account contains "admin"\n| take 10',
    }), {});
    expect(screen.getByText(/Query lint —/)).toBeTruthy();
    expect(screen.getAllByText(/^line \d+$/).length).toBeGreaterThan(0);
    cleanup();
  });

  it('never blocks: it renders findings without any disabled or error control', () => {
    const { container } = renderWithApp(h(LintPanel, {
      query: 'SecurityEvent\n| where Account contains "admin"',
    }), {});
    expect(container.querySelector('[disabled]')).toBeNull();
    cleanup();
  });
});
