const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const queriesRouter = require('./routes/queries');
const schemasRouter = require('./routes/schemas');
const healthRouter = require('./routes/health');
const errorHandler = require('./middleware/errorHandler');

// ---------------------------------------------------------------------------
// The wired-up express app, separated from the listener in server.js so the test suite
// can bind it to an ephemeral port without inheriting the process-level signal handlers
// and the shutdown path.
// ---------------------------------------------------------------------------
const app = express();

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
app.use(['/api/queries', '/api/schemas'], (req, res, next) => {
  if (!API_TOKEN) return next();
  const header = req.get('authorization') || '';
  const presented = /^bearer /i.test(header) ? header.slice(7) : '';
  // Compare BYTE length, not character length: two strings of equal .length can produce
  // buffers of different byte length once multi-byte UTF-8 is involved, and
  // timingSafeEqual throws RangeError on a length mismatch — turning a 401 into a 500
  // and handing the caller a token-length oracle.
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(API_TOKEN, 'utf8');
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ error: 'Unauthorized' });
  return next();
});

app.use(express.json({ limit: '2mb' }));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/api/queries', queriesRouter);
app.use('/api/schemas', schemasRouter);
app.use('/api/health', healthRouter);

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
app.use(errorHandler);

module.exports = app;
