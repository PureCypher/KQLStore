// ---------------------------------------------------------------------------
// POST /api/ai/redact — the preview the SPA shows before anything leaves the
// cluster. It answers "what will be replaced, with which marker, and is this
// blocked because it carries a credential?"
//
// The two classes are handled differently, and the difference is the point:
//
//   SECRET      — refused outright. A credential does not get a placeholder and a
//                 warning; it gets a rejection, because there is no version of
//                 "send it anyway" that is correct, and because the operator's
//                 next move is to remove it from the query.
//   DISCLOSURE  — replaced with a typed marker; the request proceeds.
//
// The response's `secrets` array carries RULES ONLY — never the matched value.
// Echoing the credential into a response body (which a browser caches, and a
// screenshot can capture) would put it in more places, not fewer.
// ---------------------------------------------------------------------------
const { Router } = require('express');
const { collectSecrets, redactFields } = require('../lib/fields');

const router = Router();

const allowlist = () => new Set(
  (process.env.SCAN_ALLOWLIST || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
);

router.post('/', (req, res, next) => {
  try {
    const fields = req.body && req.body.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      const err = new Error('request body must contain a "fields" object');
      err.statusCode = 400;
      throw err;
    }

    const secrets = collectSecrets(fields);
    if (secrets.length > 0) {
      return res.status(422).json({
        blocked: true,
        secrets,
        error: 'This query appears to contain a credential. Remove it before using AI assistance.',
      });
    }

    res.json({ ...redactFields(fields, allowlist()), blocked: false });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
