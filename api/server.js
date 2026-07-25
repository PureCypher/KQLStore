const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const db = require('./db');
const queriesRouter = require('./routes/queries');
const healthRouter = require('./routes/health');
const errorHandler = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
// In the shipped topology nginx proxies /api/ to this service, so the browser is
// always same-origin and CORS is not needed. Bare cors() reflected every origin,
// which let any page on the network read and write the whole query store.
// Opt in explicitly via CORS_ORIGIN (comma-separated) only for split-origin dev.
const corsOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
if (corsOrigins.length > 0) {
  console.warn(`CORS enabled for: ${corsOrigins.join(', ')}`);
  app.use(cors({ origin: corsOrigins, credentials: true }));
}

// ---------------------------------------------------------------------------
// Optional shared-secret auth. The API is ClusterIP-only, but that still leaves it
// reachable by every pod in the cluster; NetworkPolicy is the primary control and
// this is defence in depth for anyone fronting it differently.
//
// The token must be injected by the proxy in front of this service, NOT by the SPA
// — anything the browser holds is readable by anyone who can load the page, so a
// frontend-held token would not be a secret. Health is exempt so kubelet probes work.
//
// This runs BEFORE express.json() so an unauthenticated caller never gets a 10 MB
// body parsed on its behalf, and cannot distinguish endpoints via parser errors.
// ---------------------------------------------------------------------------
const API_TOKEN = process.env.API_TOKEN || '';
if (!API_TOKEN) {
  console.warn('API_TOKEN is not set — the API accepts any caller that can reach it. ' +
               'Rely on NetworkPolicy (k8s/api-networkpolicy.yaml) to restrict access.');
}
app.use('/api/queries', (req, res, next) => {
  if (!API_TOKEN) return next();
  const header = req.get('authorization') || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  // Length-independent compare avoids leaking the token length via timing.
  const ok = presented.length === API_TOKEN.length &&
    crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(API_TOKEN));
  if (!ok) return res.status(401).json({ error: 'Unauthorized' });
  return next();
});

app.use(express.json({ limit: '10mb' }));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/api/queries', queriesRouter);
app.use('/api/health', healthRouter);

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
app.use(errorHandler);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const server = app.listen(PORT, () => {
  console.log(`KQL Store API listening on port ${PORT}`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  server.close(() => {
    console.log('HTTP server closed.');
    db.close();
    console.log('Database connection closed.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
