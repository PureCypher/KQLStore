// ---------------------------------------------------------------------------
// The AI conversation panel.
//
// This is a view of the shared draft, never a second copy of it: the panel receives
// `draft` and reports accepted proposals through `onProposal`; the form owns the state.
// Closing the panel discards the conversation — nothing here is persisted, and the AI
// service is stateless, so there is no transcript anywhere to retain.
//
// The redaction story: before EVERY send the draft is run through /api/ai/redact and
// the operator is shown exactly what would leave the cluster. On confirm, the chat
// call sends the ORIGINAL draft and the SERVER redacts it (and un-redacts the model's
// proposal) — so the markers in the preview and the markers on the wire are produced
// by the same code and always agree. The operator's typed messages are conversation
// prose and travel as typed; the operational detail that matters — the query — is
// redacted. A credential anywhere is refused by the server with no override.
// ---------------------------------------------------------------------------
import React, { useState } from 'react';
import { X, Send, Terminal } from 'lucide-react';
import { StorageAdapter } from '../storage/adapter.js';
import { reviewProposal } from '../domain/proposal.js';
import { RedactionPreview } from './RedactionPreview.jsx';
import { ProposalReview } from './ProposalReview.jsx';
import { FOCUS_RING } from './a11y.jsx';

const AIChatPanel = ({ draft, schemas, onProposal, onClose }) => {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [streamText, setStreamText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState(null);
  // The redaction gate for the pending send: {blocked, secrets} | {blocked:false, applied, verbatim}
  const [gate, setGate] = useState(null);
  // The pending proposal review: an array of reviewProposal changes, or null.
  const [review, setReview] = useState(null);
  // Incremented per proposal so ProposalReview remounts (its checkbox state resets).
  const [proposalSeq, setProposalSeq] = useState(0);

  const draftFields = () => ({
    name: draft?.name || '',
    description: draft?.description || '',
    query: draft?.query || '',
  });

  const canSend = Boolean(input.trim()) && !streaming && !gate;

  // Every send is gated on a fresh redaction preview — a conversation that started
  // benign can drift into pasting a watchlist name three turns later.
  const handleSend = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    try {
      const result = await StorageAdapter.aiRedact(draftFields());
      if (result.blocked) {
        setGate({ blocked: true, secrets: result.secrets, applied: [] });
        return;
      }
      setGate({ blocked: false, applied: result.applied, verbatim: false });
    } catch (e) {
      setError(`Redaction check failed: ${e.message}`);
    }
  };

  const doSend = async (verbatim) => {
    setGate(null);
    setError(null);
    setReview(null);
    const userMsg = { role: 'user', content: input.trim() };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput('');
    setStreamText('');
    setStreaming(true);

    try {
      // The ORIGINAL draft, not the redacted preview: the server redacts and holds the
      // marker mapping so it can restore the proposal on the way back.
      const res = await StorageAdapter.aiChat({
        messages: history,
        schemas,
        allowVerbatim: verbatim,
        draft: draftFields(),
      });

      if (!res.ok) {
        let msg = 'The model service failed.';
        try {
          const body = await res.json();
          if (typeof body?.error === 'string') msg = body.error;
        } catch {
          // Non-JSON body (proxy error page); the fixed message stands.
        }
        setError(msg);
        setStreaming(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assistant = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line); } catch { continue; }
          if (evt?.type === 'text' && typeof evt.value === 'string') {
            assistant += evt.value;
            setStreamText(assistant);
          } else if (evt?.type === 'proposal') {
            setReview(reviewProposal(draft, evt.fields));
            setProposalSeq((n) => n + 1);
          } else if (evt?.type === 'error') {
            setError(evt.value || 'The model service failed.');
          }
        }
      }
      if (assistant) setMessages((prev) => [...prev, { role: 'assistant', content: assistant }]);
    } catch (e) {
      setError(`Chat failed: ${e.message}`);
    }
    setStreaming(false);
    setStreamText('');
  };

  return (
    <div className="flex flex-col h-full min-w-0 rounded-lg overflow-hidden"
      style={{ background: '#12121a', border: '1px solid #2a2a3e' }}>
      <div className="flex items-center justify-between px-3 py-2 shrink-0"
        style={{ borderBottom: '1px solid #1e1e2e', background: '#0d0d14' }}>
        <span className="text-xs font-bold flex items-center gap-1.5" style={{ color: '#00ff88' }}>
          <Terminal size={12} aria-hidden="true" /> AI Assistant
        </span>
        <button onClick={onClose} aria-label="Close AI assistant" title="Close"
          className={`p-1 rounded hover:bg-white/10 ${FOCUS_RING}`}>
          <X size={14} className="text-gray-400" aria-hidden="true" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2 text-xs" aria-live="polite">
        {messages.length === 0 && !streamText && (
          <p className="text-gray-500">
            Ask the model to rewrite this query or its metadata. Proposals are reviewed before
            anything is applied.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'text-right' : ''}>
            <div className={`inline-block max-w-full text-left px-2.5 py-1.5 rounded-lg whitespace-pre-wrap`}
              style={m.role === 'user'
                ? { background: '#1a2a22', border: '1px solid #00ff8840', color: '#d8e6de' }
                : { background: '#0a0a0f', border: '1px solid #1e1e2e', color: '#c8cce0' }}>
              {m.content}
            </div>
          </div>
        ))}
        {streamText && (
          <div>
            <div className="inline-block max-w-full text-left px-2.5 py-1.5 rounded-lg whitespace-pre-wrap"
              style={{ background: '#0a0a0f', border: '1px solid #1e1e2e', color: '#c8cce0' }}>
              {streamText}
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="text-xs" style={{ color: '#ff6b6b' }}>{error}</p>
        )}
      </div>

      {/* The gate and the review render over the message area, not instead of it: the
          conversation stays visible behind the decision the operator is being asked to
          make. */}
      {gate && (
        <div className="px-3 pb-3">
          <RedactionPreview
            applied={gate.applied}
            blocked={gate.blocked}
            secrets={gate.secrets}
            onConfirm={() => doSend(false)}
            onOverride={() => doSend(true)}
            onDismiss={() => setGate(null)}
          />
        </div>
      )}
      {review && (
        <div className="px-3 pb-3">
          <ProposalReview
            key={proposalSeq}
            changes={review}
            onAccept={(accepted) => { onProposal(accepted); setReview(null); }}
            onReject={() => setReview(null)}
          />
        </div>
      )}

      <div className="shrink-0 p-3 pt-2" style={{ borderTop: '1px solid #1e1e2e' }}>
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
            }}
            rows={2}
            aria-label="Message the AI assistant"
            placeholder="Ask for a rewrite, a new detection angle, or metadata…"
            spellCheck={false}
            className={`flex-1 px-2.5 py-2 rounded-lg text-xs text-gray-200 outline-hidden focus:ring-1 focus:ring-[#00ff88] ${FOCUS_RING}`}
            style={{ background: '#0a0a0f', border: '1px solid #2a2a3e', resize: 'none' }}
          />
          <button onClick={handleSend} disabled={!canSend}
            aria-label="Send message"
            className={`p-2 rounded-lg disabled:opacity-40 ${FOCUS_RING}`}
            style={{ background: canSend ? '#00ff88' : '#222', color: canSend ? '#0a0a0f' : '#666' }}>
            <Send size={14} aria-hidden="true" />
          </button>
        </div>
        <p className="text-[10px] mt-1 text-gray-600">
          {streaming ? 'The model is responding…' : 'Enter to send. A redaction preview appears before anything leaves the cluster.'}
        </p>
      </div>
    </div>
  );
};

export { AIChatPanel };
