// ---------------------------------------------------------------------------
// Shared presentational shell for import previews.
//
// Two modals — ImportPreviewModal (queries) and SchemaImportModal (table schemas) —
// render the same chrome: the dark panel, the title row with a close button, and a
// scrollable list of { index, name, status, reason } rows. They cannot be merged into
// one component: the query modal is hard-wired to query records via useApp() and
// re-plans collisions against the store, while the schema modal is a leaf. What they
// share is this shell — the parts that have nothing to do with either domain. The
// domain differences (the summary counts, the footer buttons) arrive as `summary` and
// `footer` children, so each modal keeps its own decision logic and only the chrome is
// de-duplicated.
//
// Items may carry an optional `title` for a tooltip on the reason column (the query
// modal uses it to show which fields an update would move without widening the row).
// ---------------------------------------------------------------------------
import React, { useId } from 'react';
import { X } from 'lucide-react';
import { FOCUS_RING } from './a11y.jsx';
import { Modal } from './Modal.jsx';

const ImportPreviewShell = ({
  title,
  items,
  statusColors,
  statusLabels,
  summary,
  footer,
  onClose,
  listAriaLabel,
  className = 'max-w-xl',
}) => {
  const titleId = useId();
  const listId = useId();
  return (
    <Modal
      labelledBy={titleId}
      onClose={onClose}
      backdropClassName="z-[80] items-start justify-center pt-8 pb-8 overflow-y-auto"
      className={`rounded-xl p-6 font-mono w-full ${className} mx-4`}
      style={{ background: '#12121a', border: '1px solid #2a2a3e' }}
    >
      <div className="flex justify-between items-center mb-4">
        <h2 id={titleId} className="text-lg font-bold" style={{ color: '#00ff88' }}>{title}</h2>
        <button onClick={onClose} className={`p-1 rounded hover:bg-white/10 ${FOCUS_RING}`}
          aria-label="Close import preview" title="Close">
          <X size={16} className="text-gray-400" aria-hidden="true" />
        </button>
      </div>
      {summary}
      {/* The counts are the decision the user is being asked to make, so they are attached
          to the confirm button as its description (the footer wires aria-describedby to
          summaryId) rather than left as coloured numbers floating above it. */}
      <ul id={listId} aria-label={listAriaLabel}
        className="max-h-64 overflow-y-auto space-y-1 mb-4"
        style={{ background: '#0a0a0f', borderRadius: 8, padding: 8, border: '1px solid #1a1a2e' }}>
        {items.map((item, i) => (
          <li key={item.index ?? i} className="flex items-center gap-2 text-xs py-1 px-2 rounded"
            style={{ background: i % 2 === 0 ? 'transparent' : '#12121a' }}>
            <span className="w-14 shrink-0 text-right" style={{ color: statusColors[item.status] }}>
              {statusLabels[item.status]}
            </span>
            <span className="truncate text-gray-300 flex-1">{item.name}</span>
            {item.reason && (
              <span className="text-gray-600 shrink-0 text-right truncate max-w-56"
                title={item.title}>
                {item.reason}
              </span>
            )}
          </li>
        ))}
      </ul>
      {footer}
    </Modal>
  );
};

export { ImportPreviewShell };
