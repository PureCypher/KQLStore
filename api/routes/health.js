const { Router } = require('express');
const db = require('../db');

const router = Router();

// ---------------------------------------------------------------------------
// Health.
//
// The endpoint is unauthenticated by design — kubelet probes it and kubelet cannot be
// given a credential — so it discloses nothing about the store. It used to return
// queriesCount, which handed anyone who could reach the port the size of the estate's
// detection library for free. The SELECT stays: reading a row is the point of the
// check, it proves the database file is open and legible, only the number is dropped.
//
// Writability is checked separately because a full or read-only PVC leaves the database
// perfectly readable while every write fails with a 500. The check is a one-row write,
// rate-limited by HEALTH_WRITE_TTL_MS, so a 10-second probe interval costs one tiny WAL
// frame every 30 seconds rather than one per probe.
// ---------------------------------------------------------------------------

const WRITE_CHECK_TTL_MS = Number(process.env.HEALTH_WRITE_TTL_MS ?? 30000);

// A dedicated single-row table: it can be rewritten forever without growing the file and
// without touching anything the application reads.
try {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS health_probe (
      id      INTEGER PRIMARY KEY CHECK (id = 1),
      checked TEXT NOT NULL
    )
  `).run();
} catch (err) {
  // Already read-only at boot. Not fatal here — the probe below will report it.
  console.error('Could not create health_probe table:', err.message);
}

const WRITE_PROBE_SQL =
  'INSERT INTO health_probe (id, checked) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET checked = excluded.checked';

// Prepared on first use, not at import: if the CREATE above failed the table is absent
// and preparing here would throw at require() time, taking down the process that is
// meant to be reporting the problem.
let writeProbe = null;

let cachedWritable = null;
let cachedAt = 0;

function checkWritable() {
  const now = Date.now();
  if (cachedWritable !== null && now - cachedAt < WRITE_CHECK_TTL_MS) return cachedWritable;

  try {
    if (!writeProbe) writeProbe = db.prepare(WRITE_PROBE_SQL);
    writeProbe.run(new Date(now).toISOString());
    cachedWritable = true;
  } catch (err) {
    // SQLITE_READONLY, SQLITE_FULL, SQLITE_IOERR — all mean the same thing to a caller:
    // reads work, writes do not. Log the specific cause; it is what tells the operator
    // whether to grow the PVC or fix the mount.
    console.error(`Health write check failed: ${err.message}`);
    cachedWritable = false;
  }
  cachedAt = now;
  return cachedWritable;
}

function readable() {
  // LIMIT 1 rather than COUNT(*): it proves the same thing without a full table scan.
  db.prepare('SELECT id FROM queries LIMIT 1').get();
}

// ---------------------------------------------------------------------------
// GET /api/health — liveness.
//
// Never fails on a read-only database: restarting the pod cannot remount a PVC, so a
// non-200 here would only convert a degraded-but-serving API into a crash loop. The
// writable flag carries the bad news instead.
// ---------------------------------------------------------------------------
router.get('/', (_req, res, next) => {
  try {
    readable();
    const writable = checkWritable();
    res.json({
      status: writable ? 'ok' : 'degraded',
      writable,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/health/ready — readiness.
//
// Same check, but a non-writable database returns 503 so the endpoints are taken out of
// the Service rather than accepting saves that will 500. Point readinessProbe here to
// get that behaviour; livenessProbe must stay on /api/health.
// ---------------------------------------------------------------------------
router.get('/ready', (_req, res, next) => {
  try {
    readable();
    const writable = checkWritable();
    res.status(writable ? 200 : 503).json({
      status: writable ? 'ok' : 'degraded',
      writable,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
