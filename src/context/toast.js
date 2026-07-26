import { createContext, useContext } from 'react';

// ============================================================
// Toast Context
// ============================================================
const ToastContext = createContext();
const useToast = () => useContext(ToastContext);

// ============================================================
// Sanitized HTML renderer
// Safe because highlightKQL escapes all HTML entities before
// inserting styled spans with hardcoded color values only.

export { ToastContext, useToast };
