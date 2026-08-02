// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, cleanup } from '@testing-library/react';
import { h, renderWithApp } from './harness.js';
import { QueryCard } from '../QueryCard.jsx';

// The parent's live name deliberately differs from the fork's parentName snapshot — that
// mismatch is the real case the snapshot exists for (a parent renamed after the fork was
// taken), and it makes the resolvable and orphan branches render visibly different text
// instead of colluding on the same substring.
const fork = {
  id: 'f1', name: 'Okta variant', query: 'OktaLogs | take 1', description: '',
  category: 'Hunting', table: 'Custom', tags: [], favorite: false, usageCount: 0,
  parentId: 'p1', parentName: 'Entra risky sign-in',
  created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z',
};
const parent = { ...fork, id: 'p1', name: 'Entra risky sign-in (renamed)', parentId: null, parentName: '' };

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
    // Distinguishing assertions: the resolvable branch must (a) show the parent's *live*
    // name, not the fork's stale parentName snapshot, (b) carry no "(deleted)" wording, and
    // (c) render the name as an interactive control (a button), not plain text — that is
    // the actual structural difference from the orphan branch, and a `getByText` substring
    // match alone cannot tell the two branches apart.
    const badge = screen.getByText(/forked from/i);
    expect(badge.textContent).toMatch(/Entra risky sign-in \(renamed\)/);
    expect(badge.textContent).not.toMatch(/deleted/i);
    expect(screen.getByRole('button', { name: 'Entra risky sign-in (renamed)' })).toBeTruthy();
    cleanup();
  });

  it('marks an orphan using the snapshot name', () => {
    renderWithApp(h(QueryCard, { query: fork }), { lineage: lineageFor([fork]) });
    const badge = screen.getByText(/forked from/i);
    // The orphan branch falls back to the fork's own parentName snapshot ("Entra risky
    // sign-in"), not the (absent) parent's live name, and renders it as plain text rather
    // than a button — there is nothing to navigate to.
    expect(badge.textContent).toMatch(/Entra risky sign-in/);
    expect(badge.textContent).not.toMatch(/\(renamed\)/);
    expect(badge.textContent).toMatch(/deleted/i);
    expect(screen.queryByRole('button', { name: /Entra risky sign-in/i })).toBeNull();
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
