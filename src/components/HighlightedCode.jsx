import React, { useMemo } from 'react';
import { highlightKQL } from '../domain/highlight.js';

function HighlightedCode({ code, className = '', style }) {
  const html = useMemo(() => highlightKQL(code), [code]);
  return React.createElement('pre', {
    className, style,
    dangerouslySetInnerHTML: { __html: html },
  });
}

// ============================================================
// Storage Inspector Component

export { HighlightedCode };
