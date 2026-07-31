// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, cleanup } from '@testing-library/react';
import { h, renderWithApp } from './harness.js';
import { QueryCard } from '../QueryCard.jsx';

const fork = {
  id: 'f1', name: 'Okta variant', query: 'OktaLogs | take 1', description: '',
  category: 'Hunting', table: 'Custom', tags: [], favorite: false, usageCount: 0,
  parentId: 'p1', parentName: 'Entra risky sign-in',
  created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z',
};
const parent = { ...fork, id: 'p1', name: 'Entra risky sign-in', parentId: null, parentName: '' };

/** Context slice for a store containing `queries`, with lineage derived as App does it. */
const lineageFor = (queries) => ({
  byId: new Map(queries.map((q) => [q.id, q])),
  forkIndex: queries.reduce((m, q) => {
    if (q.parentId) m.set(q.parentId, [...(m.get(q.parentId) || []), q.id]);
    return m;
  }, new Map()),
});

describe('QueryCard lineage', () => {
  it('names the parent when one is resolvable', () => {
    renderWithApp(h(QueryCard, { query: fork }), { lineage: lineageFor([parent, fork]) });
    expect(screen.getByText(/forked from/i).textContent).toMatch(/Entra risky sign-in/);
    cleanup();
  });

  it('marks an orphan using the snapshot name', () => {
    renderWithApp(h(QueryCard, { query: fork }), { lineage: lineageFor([fork]) });
    const badge = screen.getByText(/forked from/i);
    expect(badge.textContent).toMatch(/Entra risky sign-in/);
    expect(badge.textContent).toMatch(/deleted/i);
    cleanup();
  });

  it('shows no lineage badge for a query that is not a fork', () => {
    renderWithApp(h(QueryCard, { query: parent }), { lineage: lineageFor([parent]) });
    expect(screen.queryByText(/forked from/i)).toBeNull();
    cleanup();
  });

  it('reports how many forks a parent has', () => {
    renderWithApp(h(QueryCard, { query: parent }), { lineage: lineageFor([parent, fork]) });
    expect(screen.getByText(/1 fork\b/i)).toBeTruthy();
    cleanup();
  });

  it('pluralises the fork count', () => {
    const second = { ...fork, id: 'f2', name: 'Another' };
    renderWithApp(h(QueryCard, { query: parent }), { lineage: lineageFor([parent, fork, second]) });
    expect(screen.getByText(/2 forks/i)).toBeTruthy();
    cleanup();
  });

  it('calls forkQuery with the query', () => {
    const forkQuery = vi.fn();
    renderWithApp(h(QueryCard, { query: fork }), { lineage: lineageFor([parent, fork]), forkQuery });
    fireEvent.click(screen.getByRole('button', { name: /^fork /i }));
    expect(forkQuery).toHaveBeenCalledWith(fork);
    cleanup();
  });
});
