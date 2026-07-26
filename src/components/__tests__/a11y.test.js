// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// Automated accessibility audit.
//
// axe-core is run against every shell component in its interesting states. This is a
// regression gate, not a certificate: axe catches roughly the machine-checkable third
// of WCAG, and the keyboard behaviour it cannot see (focus traps, Escape routing, arrow
// navigation) is asserted separately in dialog.test.js.
//
// Two rule families are excluded, both because they describe the document rather than a
// component and neither is answerable from inside a mounted fragment:
//   - 'region' / 'landmark-one-main' / 'page-has-heading-one' / 'bypass' — these assert
//     that the *page* has landmarks and a single h1. App.jsx supplies <main>, <aside>,
//     <header> and the h1; a component rendered on its own to document.body can never
//     satisfy them, so leaving them on would report four permanent false failures and
//     make the gate meaningless.
//   - 'color-contrast' — jsdom performs no layout and computes no cascaded colours, so
//     axe cannot evaluate it here. It returns "incomplete", not a pass; contrast is
//     verified in a real browser, not by this file.
// ---------------------------------------------------------------------------
import { describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import axe from 'axe-core';

import { h, renderWithApp, SAMPLE_IMPORT_PREVIEW, SAMPLE_QUERY, SAMPLE_STORAGE } from './harness.js';
import { BulkActionBar } from '../BulkActionBar.jsx';
import { CodeBlock } from '../CodeBlock.jsx';
import { ImportPreviewModal } from '../ImportPreviewModal.jsx';
import { KeyboardHelp } from '../KeyboardHelp.jsx';
import { QueryCard } from '../QueryCard.jsx';
import { SidebarContent } from '../SidebarContent.jsx';
import { StorageInspector } from '../StorageInspector.jsx';
import { QueryEditorModal } from '../QueryEditorModal.jsx';
import { TableSelector } from '../TableSelector.jsx';
import { ToastContainer } from '../ToastContainer.jsx';

const DOCUMENT_LEVEL_RULES = ['region', 'landmark-one-main', 'page-has-heading-one', 'bypass'];

const AXE_OPTIONS = {
  rules: Object.fromEntries(
    [...DOCUMENT_LEVEL_RULES, 'color-contrast'].map((id) => [id, { enabled: false }]),
  ),
};

/** Run axe over `container` and return the violation list. */
async function audit(container) {
  const results = await axe.run(container, AXE_OPTIONS);
  return results.violations;
}

/** Render an element, run axe over it, and report each violation with its target. */
async function auditRender(element, overrides) {
  const { container, unmount } = renderWithApp(element, overrides);
  const violations = await audit(container);
  unmount();
  return violations;
}

const tally = [];

/** Register one audited state so the suite can print a single summary at the end. */
function record(name, violations) {
  tally.push({ name, count: violations.length });
  return violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.help}`);
}

describe('axe-core audit of the shell components', () => {
  it('KeyboardHelp, open', async () => {
    const v = await auditRender(h(KeyboardHelp), { showKeyboardHelp: true });
    expect(record('KeyboardHelp (open)', v)).toEqual([]);
  });

  it('QueryEditorModal, editing an existing query', async () => {
    const v = await auditRender(h(QueryEditorModal), { editingQuery: SAMPLE_QUERY });
    expect(record('QueryEditorModal (edit)', v)).toEqual([]);
  });

  it('ImportPreviewModal, open', async () => {
    const v = await auditRender(h(ImportPreviewModal), { importPreview: SAMPLE_IMPORT_PREVIEW });
    expect(record('ImportPreviewModal (open)', v)).toEqual([]);
  });

  it('TableSelector, collapsed', async () => {
    const v = await auditRender(h(TableSelector, { value: 'DeviceProcessEvents', onChange: () => {} }));
    expect(record('TableSelector (collapsed)', v)).toEqual([]);
  });

  it('TableSelector, expanded', async () => {
    const { container, getByRole, unmount } = renderWithApp(
      h(TableSelector, { value: 'DeviceProcessEvents', onChange: () => {} }),
    );
    fireEvent.click(getByRole('button', { name: /DeviceProcessEvents/ }));
    const v = await audit(container);
    unmount();
    expect(record('TableSelector (expanded)', v)).toEqual([]);
  });

  it('QueryCard', async () => {
    const v = await auditRender(h(QueryCard, { query: SAMPLE_QUERY }), { queries: [SAMPLE_QUERY] });
    expect(record('QueryCard', v)).toEqual([]);
  });

  it('CodeBlock, long enough to collapse', async () => {
    const v = await auditRender(h(CodeBlock, { query: SAMPLE_QUERY.query + '\n| take 1\n| take 2', queryId: 'q1' }));
    expect(record('CodeBlock', v)).toEqual([]);
  });

  it('BulkActionBar, with a selection', async () => {
    const v = await auditRender(h(BulkActionBar), { selectedIds: new Set(['q1', 'q2']) });
    expect(record('BulkActionBar', v)).toEqual([]);
  });

  it('SidebarContent', async () => {
    const v = await auditRender(h(SidebarContent), {
      queries: [SAMPLE_QUERY],
      allTags: [['powershell', 3], ['lolbins', 1]],
      categoryCounts: { 'Threat Hunting': 1 },
      searchTerm: 'powershell',
      hasActiveFilters: true,
      stats: { total: 1, byTable: { DeviceProcessEvents: 1 }, byTableGroup: { defender: 1, sentinel: 0, custom: 0 } },
    });
    expect(record('SidebarContent', v)).toEqual([]);
  });

  it('ToastContainer, with one of each severity', async () => {
    const v = await auditRender(h(ToastContainer), {
      toasts: [
        { id: 1, message: 'Query saved', type: 'success' },
        { id: 2, message: 'Failed to save query', type: 'error' },
        { id: 3, message: 'Query deleted', type: 'info' },
      ],
    });
    expect(record('ToastContainer', v)).toEqual([]);
  });

  it('StorageInspector, visible', async () => {
    const v = await auditRender(
      h(StorageInspector, {
        visible: true,
        onClose: () => {},
        storage: SAMPLE_STORAGE,
        onForceBackup: () => {},
        onHealthCheck: async () => ({ ok: true, details: [], writable: true, readable: true, dataValid: true, estimatedSizeKB: 1 }),
        onPurge: () => {},
      }),
    );
    expect(record('StorageInspector', v)).toEqual([]);
  });

  it('reports the total violation count', () => {
    const total = tally.reduce((sum, t) => sum + t.count, 0);
    console.log('axe violations by component:\n' + tally.map((t) => `  ${t.name}: ${t.count}`).join('\n'));
    console.log(`axe total violations: ${total}`);
    expect(total).toBe(0);
  });
});
