import React from 'react';
import { Check, AlertTriangle, Zap } from 'lucide-react';
import { useApp } from '../context/app.js';

const SavingIndicator = () => {
  const { savingState } = useApp();
  if (savingState === 'idle') return null;
  const config = {
    saving: { color: '#ffcc00', text: 'saving...' },
    saved: { color: '#00ff88', text: 'saved' },
    error: { color: '#ff4444', text: 'save failed' },
  };
  const c = config[savingState] || config.saved;
  return (
    <span className="flex items-center gap-1.5 text-xs" style={{ color: c.color }}>
      {savingState === 'saving' && <Zap size={10} className="animate-pulse" />}
      {savingState === 'saved' && <Check size={10} />}
      {savingState === 'error' && <AlertTriangle size={10} />}
      {c.text}
    </span>
  );
};

export { SavingIndicator };
