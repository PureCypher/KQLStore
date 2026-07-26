import React, { useState } from 'react';
import { Copy, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { HighlightedCode } from './HighlightedCode.jsx';
import { useApp } from '../context/app.js';

const CodeBlock = React.memo(({ query, queryId }) => {
  const { copyToClipboard } = useApp();
  const lines = query.split('\n');
  const isLong = lines.length > 6;
  const [expanded, setExpanded] = useState(false);
  const displayCode = isLong && !expanded ? lines.slice(0, 6).join('\n') : query;
  const displayLineCount = isLong && !expanded ? 6 : lines.length;
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e) => {
    e.stopPropagation();
    await copyToClipboard(query, queryId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="relative group rounded-lg overflow-hidden" style={{ background: '#0a0a0f', border: '1px solid #1a1a2e' }}>
      <button onClick={handleCopy}
        className="absolute top-2 right-2 p-1.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity z-10"
        style={{ background: '#1a1a2e', border: '1px solid #2a2a3e' }} title="Copy query">
        {copied ? <Check size={14} style={{ color: '#00ff88' }} /> : <Copy size={14} className="text-gray-400" />}
      </button>
      <div className="flex text-xs overflow-x-auto">
        <div className="select-none text-right pr-3 pl-3 py-3 leading-relaxed shrink-0" style={{ color: '#3a3a4e', minWidth: 36 }}>
          {Array.from({ length: displayLineCount }, (_, i) => <div key={i}>{i + 1}</div>)}
        </div>
        <HighlightedCode code={displayCode} className="py-3 pr-4 leading-relaxed flex-1 min-w-0 overflow-x-auto" />
      </div>
      {isLong && (
        <button onClick={(e) => { e.stopPropagation(); setExpanded((p) => !p); }}
          className="w-full py-1.5 text-xs font-mono flex items-center justify-center gap-1 hover:bg-white/5 transition-colors"
          style={{ color: '#00d4ff', borderTop: '1px solid #1a1a2e' }}>
          {expanded ? <><ChevronUp size={12} />Show less</> : <><ChevronDown size={12} />Show more ({lines.length - 6} lines)</>}
        </button>
      )}
    </div>
  );
});

export { CodeBlock };
