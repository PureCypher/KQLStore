// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, cleanup } from '@testing-library/react';
import { h, renderWithApp } from './harness.js';
import { ProposalReview } from '../ProposalReview.jsx';
import { RedactionPreview } from '../RedactionPreview.jsx';

// These two are leaf components — ordinary props, no shell responsibilities — so the
// AppContext provider in renderWithApp is harmless even though nothing here reads it.
// The chat panel itself is covered at its boundary in editorState.test.js, where it is
// stubbed; its own streaming behaviour is the wire's business (Task 5's suite).

describe('ProposalReview', () => {
  const changes = [
    { field: 'name', from: 'Old', to: 'New', valid: true, reason: '' },
    {
      field: 'severity', from: 'Low', to: 'Catastrophic', valid: false,
      reason: 'severity must be one of: Informational, Low, Medium, High, Critical',
    },
  ];
  const open = (props = {}) => renderWithApp(
    h(ProposalReview, { changes, onAccept: () => {}, onReject: () => {}, ...props }), {},
  );

  it('shows the old and new value for each change', () => {
    open();
    expect(screen.getByText('Old')).toBeTruthy();
    expect(screen.getByText('New')).toBeTruthy();
    cleanup();
  });

  it('shows the validator reason on an invalid change', () => {
    open();
    expect(screen.getByText(/severity must be one of/)).toBeTruthy();
    cleanup();
  });

  it('pre-selects valid changes and pre-rejects invalid ones', () => {
    open();
    expect(screen.getByRole('checkbox', { name: /name/i }).checked).toBe(true);
    expect(screen.getByRole('checkbox', { name: /severity/i }).checked).toBe(false);
    cleanup();
  });

  it('accepts only what is checked', () => {
    const onAccept = vi.fn();
    open({ onAccept });
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(onAccept).toHaveBeenCalledWith([changes[0]]);
    cleanup();
  });

  it('lets an invalid change be accepted only after an explicit tick', () => {
    const onAccept = vi.fn();
    open({ onAccept });
    fireEvent.click(screen.getByRole('checkbox', { name: /severity/i }));
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(onAccept.mock.calls[0][0]).toHaveLength(2);
    cleanup();
  });

  it('applies nothing when every change is unticked', () => {
    const onAccept = vi.fn();
    open({ onAccept });
    fireEvent.click(screen.getByRole('checkbox', { name: /name/i }));
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(onAccept).toHaveBeenCalledWith([]);
    cleanup();
  });
});

describe('RedactionPreview', () => {
  const applied = [
    { rule: 'Private IPv4', value: '10.1.2.3', marker: '<PRIVATE_IPV4_1>' },
    { rule: 'Watchlist name', value: 'HoneyTokens', marker: '<WATCHLIST_NAME_2>' },
  ];
  const open = (props = {}) => renderWithApp(
    h(RedactionPreview, {
      applied, blocked: false, secrets: [], onConfirm: () => {}, onOverride: () => {}, ...props,
    }), {},
  );

  it('lists what will be replaced', () => {
    open();
    expect(screen.getByText('10.1.2.3')).toBeTruthy();
    expect(screen.getByText('HoneyTokens')).toBeTruthy();
    cleanup();
  });

  it('shows the marker each value becomes', () => {
    open();
    expect(screen.getByText('<PRIVATE_IPV4_1>')).toBeTruthy();
    cleanup();
  });

  it('says nothing will be redacted when the list is empty', () => {
    open({ applied: [] });
    expect(screen.getByText(/nothing will be redacted/i)).toBeTruthy();
    cleanup();
  });

  it('offers an override that names the consequence', () => {
    const onOverride = vi.fn();
    open({ onOverride });
    fireEvent.click(screen.getByRole('button', { name: /send verbatim/i }));
    expect(onOverride).toHaveBeenCalled();
    cleanup();
  });

  it('offers no override when there is nothing to redact', () => {
    // Both buttons would send an identical payload, but the override additionally marks
    // the session's provenance as "overridden" — an audit trail claiming a bypass that
    // never happened.
    open({ applied: [] });
    expect(screen.queryByRole('button', { name: /send verbatim/i })).toBeNull();
    expect(screen.getByRole('button', { name: /^send$/i })).toBeTruthy();
    cleanup();
  });

  it('offers no override at all when the request is blocked for a secret', () => {
    open({ applied: [], blocked: true, secrets: [{ rule: 'AWS access key id', field: 'query' }] });
    expect(screen.queryByRole('button', { name: /send verbatim/i })).toBeNull();
    expect(screen.getByText(/AWS access key id/)).toBeTruthy();
    cleanup();
  });

  it('does not render the matched secret value, only its rule', () => {
    open({ applied: [], blocked: true, secrets: [{ rule: 'AWS access key id', field: 'query' }] });
    expect(document.body.textContent).not.toMatch(/AKIA/);
    cleanup();
  });
});
