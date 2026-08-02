// ---------------------------------------------------------------------------
// Disclosure and secret scanning.
//
// These rules were inlined in k8s/api-backup-github-cronjob.yaml until the AI service
// needed the same judgement about what must not leave the cluster. Extracting them means
// one definition of "sensitive" rather than two that drift, and it means the rules are
// unit-testable — inside a CronJob's shell heredoc they never were.
//
// The two classes are treated differently by both callers, and the distinction matters:
//   SECRET      — a credential. The backup job FAILS rather than publishing. The AI
//                 service REFUSES the request rather than sending.
//   DISCLOSURE  — operational detail. Replaced with a marker; the content still goes.
//
// The marker scheme is the caller's, not this module's. The backup job needs stable HMAC
// fingerprints so an unchanged query produces an unchanged commit. The AI service needs
// readable typed placeholders, because a model handles <EMAIL_1> far better than it
// handles REDACTED-a3f1b2c9, and because typed placeholders survive the model rewriting
// the KQL around them. Hence makeMarker is injected.
//
// Two behaviours are pinned by the backup job and must not drift, because the job's
// committed output has to stay byte-identical across this extraction:
//
//   1. redact() replaces match-locally, exactly like the job's sequential replace()
//      loop. The Watchlist rule captures only the name inside a _GetWatchlist(...) call,
//      and the replacement stays inside that match — a watchlist name appearing again as
//      plain text elsewhere is NOT replaced. A global substitution would make every
//      backed-up query that names a watchlist outside the call look modified on the
//      next run.
//   2. makeMarker receives the VALUE as its third argument. The backup job's fingerprint
//      is an HMAC of the value, so a caller that wants stable markers must be able to
//      derive one from it; a caller that only cares about readability can ignore it.
// ---------------------------------------------------------------------------

// Verbatim from the CronJob. The AWS and Google patterns match the providers' real
// key formats; the rest are the credential shapes a detection library actually collects.
// The `Assigned secret` rule is deliberately loose (any `token=...`-style assignment with
// 12+ characters after the separator) because a credential in a query rarely wears a
// recognised prefix — the cost of a false positive here is a refused request, which is
// the recoverable direction. See api-ai/docs for why the AI service refuses outright.
const SECRET_RULES = [
  ['AWS access key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['Azure storage key', /\bAccountKey\s*=\s*[A-Za-z0-9+/=]{60,}/g],
  ['Azure SAS token', /\bsig=[A-Za-z0-9%+/=]{40,}/g],
  ['Connection string password', /\b(?:Password|Pwd)\s*=\s*[^;\s"']{6,}/gi],
  ['Credential in URL', /\b[a-z]{2,10}:\/\/[^/\s:@]+:[^/\s:@]+@/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z\-_]{35}\b/g],
  ['Private key block', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['Bearer token', /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}/g],
  ['Assigned secret', /\b(?:api[_-]?key|apikey|secret|passwd|password|token)\s*[=:]\s*["']?[A-Za-z0-9\-_./+]{12,}/gi],
];

// Verbatim from the CronJob.
const DISCLOSURE_RULES = [
  ['Private IPv4', /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g],
  ['Email or UPN', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ['UNC path', /\\\\[A-Za-z0-9_.$-]{2,}\\[A-Za-z0-9_.$-]+/g],
  ['GUID', /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g],
  ['Watchlist name', /_GetWatchlist\s*\(\s*['"]([^'"]+)['"]/gi],
  // Internal-looking hostnames only. Public domains are deliberately
  // NOT matched: a shadow-AI hunt that looks for api.openai.com
  // discloses nothing by naming it, and redacting it would break the
  // detection while protecting nothing. These suffixes are the ones
  // that only ever appear inside somebody's estate.
  ['Internal hostname', /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:local|internal|corp|lan|intra|home|ad)\b/gi],
];

const PLACEHOLDER = /^(?:DEVICENAME|HOSTNAME|COMPUTERNAME|INITIALDOMAIN\.com|REDIRECTDOMAIN\.com|example\.com|contoso\.com)$/i;

/** Find everything of interest without changing anything. */
function scan(text) {
  const secrets = [];
  const disclosures = [];
  if (typeof text !== 'string' || !text) return { secrets, disclosures };

  for (const [rule, rx] of SECRET_RULES) {
    for (const m of text.matchAll(rx)) secrets.push({ rule, match: m[0] });
  }
  for (const [rule, rx] of DISCLOSURE_RULES) {
    for (const m of text.matchAll(rx)) {
      // A capture group means the rule targets part of the match — the watchlist NAME,
      // not the whole _GetWatchlist(...) call. Redacting the call would break the query.
      const value = m[1] !== undefined ? m[1] : m[0];
      if (PLACEHOLDER.test(value)) continue;
      disclosures.push({ rule, value });
    }
  }
  return { secrets, disclosures };
}

/**
 * Replace disclosures with markers.
 *
 * Substitution is sequential and match-local, mirroring the backup job's replace() loop
 * so a caller can hand this the job's HMAC fingerprint and get byte-identical output.
 *
 * @param {string} text
 * @param {(rule: string, index: number, value: string) => string} makeMarker
 * @param {Set<string>} allow lower-cased values that must survive verbatim
 * @returns {{text: string, applied: Array<{rule: string, value: string, marker: string}>}}
 */
function redact(text, makeMarker, allow = new Set()) {
  if (typeof text !== 'string' || !text) return { text: text ?? '', applied: [] };

  const assigned = new Map();
  const applied = [];
  let out = text;

  for (const [rule, rx] of DISCLOSURE_RULES) {
    out = out.replace(rx, (...args) => {
      const match = args[0];
      // String.replace hands the callback (match, p1..pN, offset, string). Only the
      // watchlist rule captures, so for every other rule args[1] is the OFFSET — a
      // number. Reading it as a capture would treat the offset as the value. Take a
      // capture only when it really is one.
      const captured = typeof args[1] === 'string' ? args[1] : undefined;
      const value = captured !== undefined ? captured : match;
      if (allow.has(value.toLowerCase()) || PLACEHOLDER.test(value)) return match;

      let marker = assigned.get(value);
      if (!marker) {
        marker = makeMarker(rule, assigned.size + 1, value);
        assigned.set(value, marker);
        applied.push({ rule, value, marker });
      }
      return match.replace(value, marker);
    });
  }

  return { text: out, applied };
}

module.exports = { SECRET_RULES, DISCLOSURE_RULES, PLACEHOLDER, scan, redact };
