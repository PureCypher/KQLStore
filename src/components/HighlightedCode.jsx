import React, { useMemo } from 'react';
import { highlightKQL } from '../domain/highlight.js';

// `id` is forwarded so a control elsewhere can point aria-controls at the block it
// expands — see the show more/less toggle in CodeBlock.
function HighlightedCode({ code, className = '', style, id }) {
  const html = useMemo(() => highlightKQL(code), [code]);
  return React.createElement('pre', {
    id, className, style,
    dangerouslySetInnerHTML: { __html: html },
  });
}

export { HighlightedCode };
