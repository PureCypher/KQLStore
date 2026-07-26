const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { SCHEMA_VERSION } = require('../validate');

// The API's export envelope has to advertise the same schema version the SPA writes, or
// the API is describing a contract it does not honour. This drifted once already: the
// export route hardcoded 3 while emitting v4 records, and it went unnoticed because the
// v3->v4 migration happens to be idempotent, so re-imports still worked by luck.
//
// Asserting against the SPA's constant rather than a literal means bumping one side alone
// fails here, which is the only way this stays true.
test('SCHEMA_VERSION matches the SPA CURRENT_SCHEMA_VERSION', () => {
  const constantsPath = path.join(__dirname, '..', '..', 'src', 'constants.js');
  const source = fs.readFileSync(constantsPath, 'utf8');
  const match = source.match(/const CURRENT_SCHEMA_VERSION\s*=\s*(\d+)/);
  assert.ok(match, 'could not read CURRENT_SCHEMA_VERSION from src/constants.js');
  assert.strictEqual(
    SCHEMA_VERSION,
    Number(match[1]),
    `api/validate.js SCHEMA_VERSION (${SCHEMA_VERSION}) must track src/constants.js `
    + `CURRENT_SCHEMA_VERSION (${match[1]})`,
  );
});

test('the export route reports SCHEMA_VERSION rather than a literal', () => {
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'queries.js'), 'utf8');
  assert.match(routeSource, /schemaVersion:\s*SCHEMA_VERSION/);
  assert.doesNotMatch(
    routeSource,
    /schemaVersion:\s*\d/,
    'export must not hardcode a schema version — it will drift again',
  );
});
