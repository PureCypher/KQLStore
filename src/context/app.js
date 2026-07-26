import { createContext, useContext } from 'react';

/**
 * Shared state for the components that make up the app shell.
 *
 * These components were previously declared inside the App() function body. React reconciles
 * by element-type identity, so a component redefined on every render is a new type every
 * render, and React unmounted and remounted its entire subtree each time the parent
 * re-rendered. That silently wiped in-progress query edits, dropped focus from the search box
 * on every keystroke, cancelled armed delete confirmations, and made the React.memo wrappers
 * on QueryCard and CodeBlock inert.
 *
 * They now live at module scope with stable identities and read shared state from here rather
 * than from a closure. Context re-renders consumers when the value changes, which is ordinary
 * React behaviour — the point is that they are no longer remounted.
 */
const AppContext = createContext(null);

function useApp() {
  const ctx = useContext(AppContext);
  if (ctx === null) {
    throw new Error('useApp must be used inside <AppContext.Provider>');
  }
  return ctx;
}

export { AppContext, useApp };
