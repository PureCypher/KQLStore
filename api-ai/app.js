// ---------------------------------------------------------------------------
// The kqlstore-ai app: a stateless Express service that proxies chat to Ollama
// Cloud. It holds no database, no volume, no session state — conversation
// history is replayed by the client each turn, so there is nothing here to back
// up and nothing to leak. The isolation decision and the statelessness decision
// reinforce each other (see docs/ai-assist.md).
//
// OLLAMA_API_KEY is read from process.env at REQUEST time (never captured at
// require time), so the code has no opinion about the key until a request needs
// it. The value itself is injected at container start from the Secret, so
// rotating the key requires a rollout restart — see docs/maintenance/ai-service.md.
// The deployment mounts the Secret as optional: true, so a pod that starts before
// the key exists reports configured:false instead of failing to start.
// ---------------------------------------------------------------------------
const express = require('express');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const MODEL = () => process.env.OLLAMA_MODEL || 'deepseek-v4-flash:cloud';

app.get('/api/ai/health', (_req, res) => {
  res.json({
    status: 'ok',
    model: MODEL(),
    // Whether a key exists, never what it is. A health probe must not be able to
    // leak the credential; a boolean is all the frontend needs to hide the toggle.
    configured: Boolean(process.env.OLLAMA_API_KEY),
  });
});

// Errors are reported without their stack and without any upstream body: an Ollama
// error response can echo the request, and the request contains query text. The
// status line is enough for the operator, and a 500 collapses to a fixed string.
app.use((err, _req, res, _next) => {
  const status = err.statusCode || 500;
  res.status(status).json({ error: status === 500 ? 'Internal error' : err.message });
});

module.exports = app;
