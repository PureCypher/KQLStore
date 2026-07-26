import React from 'react';
import { Check, AlertTriangle, Zap } from 'lucide-react';
import { useApp } from '../context/app.js';

const CONFIG = {
  saving: { color: '#ffcc00', text: 'saving...' },
  saved: { color: '#00ff88', text: 'saved' },
  error: { color: '#ff4444', text: 'save failed' },
};

// "save failed" was a coloured word in the status bar and nothing else. It is now a live
// region, so the state change is announced rather than only rendered.
//
// The element is rendered in every state, including idle, because a live region that is
// unmounted when empty is inserted rather than updated, and insertion is announced far
// less reliably. When idle it is sr-only rather than hidden — display:none would take it
// out of the accessibility tree and silence it again — and sr-only is out of flow, so it
// does not open a gap in the status bar's flex row.
const SavingIndicator = () => {
  const { savingState } = useApp();
  const isIdle = savingState === 'idle';
  const c = CONFIG[savingState] || CONFIG.saved;
  return (
    <span role="status" aria-live="polite"
      className={isIdle ? 'sr-only' : 'flex items-center gap-1.5 text-xs'}
      style={isIdle ? undefined : { color: c.color }}>
      {savingState === 'saving' && <Zap size={10} className="animate-pulse" aria-hidden="true" />}
      {savingState === 'saved' && <Check size={10} aria-hidden="true" />}
      {savingState === 'error' && <AlertTriangle size={10} aria-hidden="true" />}
      {isIdle ? '' : c.text}
    </span>
  );
};

export { SavingIndicator };
