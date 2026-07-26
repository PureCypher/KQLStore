import { ChevronUp, ChevronDown } from 'lucide-react';
import React, { useState, useEffect, useMemo, useRef } from 'react';

const QueryDescription = React.memo(({ description, maxCollapsedLines = 3, className }) => {
  const [expanded, setExpanded] = useState(false);
  const [needsTruncation, setNeedsTruncation] = useState(false);
  const contentRef = useRef(null);
  const measuredRef = useRef(false);

  // Parse description into structured sections
  const parsed = useMemo(() => {
    if (!description || typeof description !== 'string') return null;
    const text = description.trim();
    if (!text) return null;

    // Split on "Use Case:" or "Use Cases:" (case-insensitive)
    const useCaseMatch = text.match(/\n\s*use\s+cases?\s*:\s*/i);
    let summary, useCases;

    if (useCaseMatch) {
      summary = text.slice(0, useCaseMatch.index).trim();
      const useCaseBlock = text.slice(useCaseMatch.index + useCaseMatch[0].length).trim();
      // Split on lines starting with - or * or numbered (1. 2. etc)
      useCases = useCaseBlock
        .split(/\n\s*[-*]\s*|\n\s*\d+\.\s*/)
        .map(s => s.replace(/^[-*]\s*/, '').replace(/^\d+\.\s*/, '').trim())
        .filter(Boolean);
    } else {
      // Check if the entire text is a bullet list
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const bulletLines = lines.filter(l => /^[-*]\s/.test(l) || /^\d+\.\s/.test(l));
      if (bulletLines.length > 1 && bulletLines.length === lines.length) {
        summary = '';
        useCases = lines.map(l => l.replace(/^[-*]\s*/, '').replace(/^\d+\.\s*/, '').trim());
      } else {
        summary = text;
        useCases = [];
      }
    }

    // Render inline code backticks within text
    const renderInlineCode = (str) => {
      if (!str.includes('`')) return str;
      const parts = str.split(/(`[^`]+`)/g);
      return parts.map((part, i) => {
        if (part.startsWith('`') && part.endsWith('`')) {
          return React.createElement('code', {
            key: i,
            className: 'px-1.5 py-0.5 rounded text-xs font-mono',
            style: { background: '#1a1a2e', color: '#7ec8e3', border: '1px solid #2a2a3e' },
          }, part.slice(1, -1));
        }
        return part;
      });
    };

    return { summary, useCases, renderInlineCode };
  }, [description]);

  // Measure content to detect if truncation is needed
  useEffect(() => {
    if (!contentRef.current || !parsed || measuredRef.current) return;
    const el = contentRef.current;
    // Approximate: compare scrollHeight vs a clamped height
    // lineHeight ~22px * maxCollapsedLines
    const clampedHeight = 22 * maxCollapsedLines;
    if (el.scrollHeight > clampedHeight + 8) {
      setNeedsTruncation(true);
    }
    measuredRef.current = true;
  }, [parsed, maxCollapsedLines]);

  if (!parsed) return null;

  const { summary, useCases, renderInlineCode } = parsed;

  return React.createElement('div', {
    className: `mt-2 ${className || ''}`.trim(),
  },
    // Container with expand/collapse
    React.createElement('div', {
      style: {
        position: 'relative',
        maxHeight: !expanded && needsTruncation ? `${22 * maxCollapsedLines + 4}px` : 'none',
        overflow: 'hidden',
        transition: 'max-height 0.3s ease',
      },
    },
      React.createElement('div', { ref: contentRef, style: { lineHeight: '1.6' } },
        // Summary paragraph
        summary && React.createElement('p', {
          className: 'text-sm',
          style: { color: '#c9d1d9', marginBottom: useCases.length > 0 ? '12px' : '0' },
        }, renderInlineCode(summary)),

        // Use Cases section
        useCases.length > 0 && React.createElement('div', null,
          React.createElement('div', {
            className: 'flex items-center gap-2 mb-2',
            style: { marginTop: summary ? '4px' : '0' },
          },
            React.createElement('span', {
              className: 'text-xs font-semibold tracking-wider uppercase',
              style: { color: '#8b949e', letterSpacing: '0.08em' },
            }, 'Use Cases'),
            React.createElement('div', {
              className: 'flex-1',
              style: { height: '1px', background: 'linear-gradient(to right, #2a2a3e, transparent)' },
            }),
          ),
          React.createElement('ul', {
            className: 'space-y-1.5',
            style: { paddingLeft: '4px', listStyle: 'none', margin: 0 },
          },
            useCases.map((item, i) =>
              React.createElement('li', {
                key: i,
                className: 'flex gap-2 text-sm',
                style: { color: '#b0b8c4', lineHeight: '1.6' },
              },
                React.createElement('span', {
                  className: 'shrink-0 mt-2',
                  style: { width: '5px', height: '5px', borderRadius: '50%', background: '#00d4ff40', border: '1px solid #00d4ff60', display: 'block' },
                }),
                React.createElement('span', null, renderInlineCode(item)),
              )
            )
          ),
        ),
      ),

      // Fade-out gradient overlay when collapsed and truncated
      !expanded && needsTruncation && React.createElement('div', {
        style: {
          position: 'absolute', bottom: 0, left: 0, right: 0, height: '32px',
          background: 'linear-gradient(transparent, #12121a)',
          pointerEvents: 'none',
        },
      }),
    ),

    // Expand/collapse toggle
    needsTruncation && React.createElement('button', {
      onClick: () => setExpanded(prev => !prev),
      'aria-expanded': expanded,
      className: 'flex items-center gap-1 text-xs mt-1 hover:underline',
      style: { color: '#00d4ff', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0' },
    },
      expanded
        ? React.createElement(React.Fragment, null, React.createElement(ChevronUp, { size: 12 }), 'Show less')
        : React.createElement(React.Fragment, null, React.createElement(ChevronDown, { size: 12 }), 'Show more'),
    ),
  );
});

export { QueryDescription };
