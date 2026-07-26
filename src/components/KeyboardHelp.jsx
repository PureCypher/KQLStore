import React, { useId } from 'react';
import { X, Keyboard } from 'lucide-react';
import { useApp } from '../context/app.js';
import { FOCUS_RING } from './a11y.jsx';
import { Modal } from './Modal.jsx';

const KeyboardHelp = () => {
  const { setShowKeyboardHelp, showKeyboardHelp } = useApp();
  // useId rather than a module constant: the id has to be unique in the document, and a
  // constant collides the moment anything renders two of these. Hooks also have to run
  // before the early return below — see QueryEditorModal for the same constraint.
  const titleId = useId();
  if (!showKeyboardHelp) return null;
  const shortcuts = [
    ['Ctrl/Cmd + K', 'Focus search'],
    ['Ctrl/Cmd + N', 'New query'],
    ['Ctrl/Cmd + Shift + D', 'Storage inspector'],
    ['Escape', 'Close modal / clear search'],
    ['?', 'Toggle this help'],
  ];
  return (
    <Modal
      labelledBy={titleId}
      onClose={() => setShowKeyboardHelp(false)}
      backdropClassName="z-[90] items-center justify-center"
      className="rounded-xl p-6 font-mono w-96"
      style={{ background: '#12121a', border: '1px solid #2a2a3e' }}
    >
      <div className="flex justify-between items-center mb-4">
        <h2 id={titleId} className="text-lg font-bold" style={{ color: '#00ff88' }}>
          <Keyboard size={16} className="inline mr-2" aria-hidden="true" />Keyboard Shortcuts
        </h2>
        <button onClick={() => setShowKeyboardHelp(false)} className={`p-1 rounded hover:bg-white/10 ${FOCUS_RING}`}
          aria-label="Close keyboard shortcuts" title="Close">
          <X size={16} className="text-gray-400" aria-hidden="true" />
        </button>
      </div>
      {/* A description list rather than a stack of divs: the pairing of a chord to what it
          does is the content, and dt/dd is what conveys it to anything not reading pixels. */}
      <dl className="space-y-3">
        {shortcuts.map(([key, desc]) => (
          <div key={key} className="flex justify-between items-center">
            <dt>
              <kbd className="px-2 py-1 rounded text-xs" style={{ background: '#1a1a2e', border: '1px solid #2a2a3e', color: '#00d4ff' }}>{key}</kbd>
            </dt>
            <dd className="text-gray-400 text-sm">{desc}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
};

export { KeyboardHelp };
