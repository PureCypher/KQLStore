// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, cleanup } from '@testing-library/react';
import { h, renderWithApp } from './harness.js';
import { SidebarContent } from '../SidebarContent.jsx';

const parent = { id: 'p1', name: 'Parent query', parentId: null, tags: [] };
const fork = { id: 'f1', name: 'Fork query', parentId: 'p1', tags: [] };
const orphan = { id: 'o1', name: 'Orphan query', parentId: 'gone', tags: [] };

/** Context slice for a store containing `queries`, with lineage derived as App does it. */
const lineageFor = (queries) => ({
  byId: new Map(queries.map((q) => [q.id, q])),
  forkIndex: queries.reduce((m, q) => {
    if (q.parentId) m.set(q.parentId, [...(m.get(q.parentId) || []), q.id]);
    return m;
  }, new Map()),
});

describe('SidebarContent lineage filter', () => {
  it('renders no Lineage section when the store has no forks', () => {
    const queries = [parent];
    renderWithApp(h(SidebarContent), { queries, lineage: lineageFor(queries) });
    expect(screen.queryByText('Lineage')).toBeNull();
    cleanup();
  });

  it('renders Forks, Parents and Orphans toggles once a fork exists, each unpressed by default', () => {
    const queries = [parent, fork, orphan];
    renderWithApp(h(SidebarContent), { queries, lineage: lineageFor(queries) });
    const forksBtn = screen.getByRole('button', { name: /Forks, 2 queries/i });
    const parentsBtn = screen.getByRole('button', { name: /Parents, 1 query/i });
    const orphansBtn = screen.getByRole('button', { name: /Orphans, 1 query/i });
    expect(forksBtn.getAttribute('aria-pressed')).toBe('false');
    expect(parentsBtn.getAttribute('aria-pressed')).toBe('false');
    expect(orphansBtn.getAttribute('aria-pressed')).toBe('false');
    cleanup();
  });

  it('reflects the active filter via aria-pressed', () => {
    const queries = [parent, fork, orphan];
    renderWithApp(h(SidebarContent), { queries, lineage: lineageFor(queries), lineageFilter: 'orphans' });
    expect(screen.getByRole('button', { name: /Orphans/i }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /Forks/i }).getAttribute('aria-pressed')).toBe('false');
    cleanup();
  });

  it('clicking an inactive toggle selects it', () => {
    const queries = [parent, fork, orphan];
    const setLineageFilter = vi.fn();
    renderWithApp(h(SidebarContent), { queries, lineage: lineageFor(queries), setLineageFilter });
    fireEvent.click(screen.getByRole('button', { name: /Forks/i }));
    expect(setLineageFilter).toHaveBeenCalledWith('forks');
    cleanup();
  });

  it('clicking the active toggle clears it', () => {
    const queries = [parent, fork, orphan];
    const setLineageFilter = vi.fn();
    renderWithApp(h(SidebarContent), {
      queries, lineage: lineageFor(queries), lineageFilter: 'forks', setLineageFilter,
    });
    fireEvent.click(screen.getByRole('button', { name: /Forks/i }));
    expect(setLineageFilter).toHaveBeenCalledWith(null);
    cleanup();
  });
});
