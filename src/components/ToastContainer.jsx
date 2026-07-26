import React from 'react';
import { useApp } from '../context/app.js';

// The toast is the only confirmation the app gives that a save, delete, import or copy
// happened, and it was silent to anyone not watching the top-right corner of the screen.
// The container is now always mounted, empty or not, because a live region has to exist
// before content is inserted into it for the insertion to be announced.
//
// Successes and information are polite, so they queue behind whatever is being read.
// Errors carry role="alert", which is assertive: "failed to save query" is worth
// interrupting for, and it is the one class of toast that reports something lost.
const ToastContainer = () => {
  const { toasts } = useApp();
  return (
    <div role="status" aria-live="polite" aria-atomic="false"
      className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} role={t.type === 'error' ? 'alert' : undefined}
          className="pointer-events-auto flex items-center gap-2 px-4 py-2 rounded-lg font-mono text-sm shadow-lg"
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
