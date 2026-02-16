const { Router } = require('express');
const db = require('../db');

const router = Router();

router.get('/', (_req, res, next) => {
  try {
    const row = db.prepare('SELECT COUNT(*) AS count FROM queries').get();
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      queriesCount: row.count,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
