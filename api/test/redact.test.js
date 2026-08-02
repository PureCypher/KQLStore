// ---------------------------------------------------------------------------
// Tests for the extracted disclosure/secret scanner.
//
// The rules were inlined in k8s/api-backup-github-cronjob.yaml until the AI service
// needed the same judgement. The extraction must leave the backup job's committed
// output byte-identical, which pins two behaviours here:
//
//   1. Substitution is per-match and match-local, exactly like the job's replace()
//      loop: a value that the WATCHLIST rule captured is replaced only inside the
//      _GetWatchlist(...) call, not everywhere it appears. (The plan's first draft
//      substituted globally, which would silently change every backed-up query the
//      next time a watchlist name also appeared as plain text.)
//   2. PLACEHOLDER is the verbatim regex from the job, so a documentation email like
//      user@example.com is NOT skipped — the full-string placeholder list matches
//      DEVICENAME and example.com, not "user@example.com". Redacting it is the job's
//      existing behaviour and this module's is kept the same.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const { scan, redact, SECRET_RULES, DISCLOSURE_RULES } = require('../lib/redact');

const marker = (rule, index) => `<${rule.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${index}>`;

test('detects a secret', () => {
  const out = scan('let k = "AKIAIOSFODNN7EXAMPLE";');
  assert.strictEqual(out.secrets.length, 1);
  assert.strictEqual(out.secrets[0].rule, 'AWS access key id');
});

test('detects a watchlist name as a disclosure, not a secret', () => {
  const out = scan("_GetWatchlist('HoneyTokenAccounts')");
  assert.strictEqual(out.secrets.length, 0);
  assert.ok(out.disclosures.some((d) => d.rule === 'Watchlist name'));
});

test('detects private IPv4 but not public', () => {
  const out = scan('DeviceIP == "10.1.2.3" or DeviceIP == "8.8.8.8"');
  const values = out.disclosures.filter((d) => d.rule === 'Private IPv4').map((d) => d.value);
  assert.deepStrictEqual(values, ['10.1.2.3']);
});

test('detects internal hostnames but leaves public domains alone', () => {
  const out = scan('Url has "dc01.corp" or Url has "api.openai.com"');
  const values = out.disclosures.filter((d) => d.rule === 'Internal hostname').map((d) => d.value);
  assert.deepStrictEqual(values, ['dc01.corp']);
});

test('redact replaces disclosures and reports what it did', () => {
  const out = redact('user@contoso-corp.example and 10.0.0.1', marker, new Set());
  assert.ok(!out.text.includes('10.0.0.1'));
  assert.strictEqual(out.applied.length >= 1, true);
});

test('redact honours the allowlist', () => {
  const guid = 'ab721a24-1e6f-11d0-9888-00aa006c33ed';
  const out = redact(`Rights == "${guid}"`, marker, new Set([guid.toLowerCase()]));
  assert.ok(out.text.includes(guid), 'allowlisted values must survive verbatim');
  assert.strictEqual(out.applied.length, 0);
});

test('redact leaves documentation placeholders alone but redacts full emails', () => {
  // DEVICENAME matches PLACEHOLDER verbatim and survives. user@example.com is a full
  // email address, which the verbatim PLACEHOLDER does NOT match — the backup job
  // redacts it, so this module must too or the two would drift.
  const out = redact('DeviceName == "DEVICENAME" and Mail == "user@example.com"', marker, new Set());
  assert.ok(out.text.includes('DEVICENAME'));
  assert.ok(!out.text.includes('user@example.com'));
  assert.ok(out.text.includes('<EMAIL_OR_UPN_1>'));
});

test('the same value gets the same marker within one call', () => {
  const out = redact('10.0.0.1 and again 10.0.0.1', marker, new Set());
  const markers = out.applied.map((a) => a.marker);
  assert.strictEqual(new Set(markers).size, 1);
});

test('a watchlist name outside its call is not replaced', () => {
  // The byte-identical contract with the backup job: the Watchlist rule captures only
  // inside _GetWatchlist(...), and substitution is match-local. A bare "HoneyTokens"
  // elsewhere in the query must survive, or every backed-up query that names a
  // watchlist outside the call would look modified on the next run.
  const out = redact('_GetWatchlist("HoneyTokens") | where Account == "HoneyTokens"', marker, new Set());
  assert.ok(out.text.includes('_GetWatchlist("<WATCHLIST_NAME_1>")'));
  assert.ok(out.text.includes('Account == "HoneyTokens"'));
});

test('rule tables are non-empty and well formed', () => {
  for (const table of [SECRET_RULES, DISCLOSURE_RULES]) {
    assert.ok(table.length > 0);
    for (const [name, rx] of table) {
      assert.strictEqual(typeof name, 'string');
      assert.ok(rx instanceof RegExp);
      assert.ok(rx.global, `${name} must be a global regex or matchAll misses repeats`);
    }
  }
});
