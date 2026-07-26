import React from 'react';
import { useApp } from '../context/app.js';

const ToastContainer = () => {
  const { toasts } = useApp();
  return (
  <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
    {toasts.map((t) => (
      <div key={t.id} className="pointer-events-auto flex items-center gap-2 px-4 py-2 rounded-lg font-mono text-sm shadow-lg"
        style={{
          background: t.type === 'error' ? '#2a1010' : t.type === 'info' ? '#101a2a' : '#102a10',
          border: `1px solid ${t.type === 'error' ? '#ff4444' : t.type === 'info' ? '#00d4ff' : '#00ff88'}`,
          color: t.type === 'error' ? '#ff4444' : t.type === 'info' ? '#00d4ff' : '#00ff88',
        }}>
        {t.message}
      </div>
    ))}
  </div>
);
};

export { ToastContainer };
