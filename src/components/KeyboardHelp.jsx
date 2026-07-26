import React from 'react';
import { X, Keyboard } from 'lucide-react';
import { useApp } from '../context/app.js';

const KeyboardHelp = () => {
  const { setShowKeyboardHelp, showKeyboardHelp } = useApp();
  if (!showKeyboardHelp) return null;
  const shortcuts = [
    ['Ctrl/Cmd + K', 'Focus search'],
    ['Ctrl/Cmd + N', 'New query'],
    ['Ctrl/Cmd + Shift + D', 'Storage inspector'],
    ['Escape', 'Close modal / clear search'],
    ['?', 'Toggle this help'],
  ];
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70" onClick={() => setShowKeyboardHelp(false)}>
      <div className="rounded-xl p-6 font-mono w-96" style={{ background: '#12121a', border: '1px solid #2a2a3e' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-bold" style={{ color: '#00ff88' }}>
            <Keyboard size={16} className="inline mr-2" />Keyboard Shortcuts
          </h3>
          <button onClick={() => setShowKeyboardHelp(false)} className="p-1 rounded hover:bg-white/10"><X size={16} className="text-gray-400" /></button>
        </div>
        <div className="space-y-3">
          {shortcuts.map(([key, desc]) => (
            <div key={key} className="flex justify-between items-center">
              <kbd className="px-2 py-1 rounded text-xs" style={{ background: '#1a1a2e', border: '1px solid #2a2a3e', color: '#00d4ff' }}>{key}</kbd>
              <span className="text-gray-400 text-sm">{desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export { KeyboardHelp };
