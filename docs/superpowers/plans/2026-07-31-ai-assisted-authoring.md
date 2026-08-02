# AI-Assisted Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an analyst rewrite and document a forked query in conversation with `deepseek-v4-flash` on Ollama Cloud, without giving the pod that holds the query store any network access, and without sending operational detail off-cluster unredacted.

**Architecture:** A third stateless Deployment, `kqlstore-ai`, reached through nginx at `/api/ai/`. It holds no database, no volume and no session state — conversation history is replayed by the client each turn. Query text passes through a redaction layer extracted from the existing GitHub backup scanner before egress. Model output is never applied directly: every proposal is validated and reviewed before it reaches the draft.

**Tech Stack:** Express 5 on Node 24 (built-in `fetch`, no HTTP client dependency), React 19, Kubernetes with kustomize, nginx.

## Prerequisite

**Plan 1 (`2026-07-31-fork-lineage-and-schema-store.md`) must be complete and merged.** This plan forks from the lineage columns it adds and reads the schema store it creates. Do not start Task 5 onwards without it.

## Global Constraints

- **No new npm dependencies anywhere.** Node 24 has `fetch` and `crypto` built in; Ollama's API is plain HTTP. The AI service is Express and nothing else. This is deliberate — see the supply-chain reasoning in `k8s/api-backup-github-cronjob.yaml`.
- **`k8s/api-networkpolicy.yaml` must keep `egress: []` on `kqlstore-api`.** If any task appears to need egress there, the task is wrong.
- **`nginx.conf` must keep `connect-src 'self'`** in its Content-Security-Policy. The browser never talks to a third-party origin.
- The AI service never imports `api/db.js` and never mounts the PVC. It receives text and returns text.
- **Ollama Cloud does not support structured outputs** (verified 2026-07-31). Do not pass a `format` JSON schema and expect it to be honoured. Structured data comes back via tool calling and is then validated.
- The model is `deepseek-v4-flash:cloud`, 1M context, capabilities `tools thinking cloud`.
- `OLLAMA_API_KEY` comes from a Secret and is read from `process.env` at request time. It must never appear in a response body, a log line, or an error message.
- Coverage thresholds apply to `src/domain/**` and `src/lib/**`: lines 80, functions 80, branches 75.
- Commit after every task. Conventional commit format.

---

### Task 1: Extract the redaction scanner into a shared module

**Files:**
- Create: `api/lib/redact.js`
- Modify: `k8s/api-backup-github-cronjob.yaml:248-340` (replace the inlined rules with a require of the new module)
- Test: `api/test/redact.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SECRET_RULES` → `Array<[string, RegExp]>`
  - `DISCLOSURE_RULES` → `Array<[string, RegExp]>`
  - `PLACEHOLDER` → `RegExp`
  - `scan(text)` → `{ secrets: Array<{rule, match}>, disclosures: Array<{rule, value}> }`
  - `redact(text, makeMarker, allow)` → `{ text, applied: Array<{rule, value, marker}> }`

**Why this task exists:** the scanner is currently inlined in the CronJob YAML and exists nowhere as a module. It cannot be reused until it is extracted, and the extraction has to leave a production backup path behaving identically.

- [ ] **Step 1: Write the failing test**

```javascript
// api/test/redact.test.js
const test = require('node:test');
const assert = require('node:assert');
const { scan, redact, SECRET_RULES, DISCLOSURE_RULES } = require('../lib/redact');

const marker = (rule, index) => `<${rule.toUpperCase().replace(/[^A-Z]+/g, '_')}_${index}>`;

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

test('redact leaves documentation placeholders alone', () => {
  const out = redact('DeviceName == "DEVICENAME" and Mail == "user@example.com"', marker, new Set());
  assert.ok(out.text.includes('DEVICENAME'));
  assert.ok(out.text.includes('user@example.com'));
});

test('the same value gets the same marker within one call', () => {
  const out = redact('10.0.0.1 and again 10.0.0.1', marker, new Set());
  const markers = out.applied.map((a) => a.marker);
  assert.strictEqual(new Set(markers).size, 1);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test test/redact.test.js`
Expected: FAIL — "Cannot find module '../lib/redact'"

- [ ] **Step 3: Write minimal implementation**

Create `api/lib/redact.js`. Copy `SECRET`, `DISCLOSURE` and `PLACEHOLDER` **verbatim** from `k8s/api-backup-github-cronjob.yaml:255-283`, including their comments — particularly the one explaining why public domains are deliberately unmatched. Export them as `SECRET_RULES`, `DISCLOSURE_RULES` and `PLACEHOLDER`.

```javascript
// api/lib/redact.js
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
// ---------------------------------------------------------------------------

const SECRET_RULES = [
  // ... copied verbatim from the CronJob, all 12 entries
];

const DISCLOSURE_RULES = [
  // ... copied verbatim from the CronJob, all 6 entries
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
 * @param {string} text
 * @param {(rule: string, index: number) => string} makeMarker
 * @param {Set<string>} allow lower-cased values that must survive verbatim
 * @returns {{text: string, applied: Array<{rule: string, value: string, marker: string}>}}
 */
function redact(text, makeMarker, allow = new Set()) {
  if (typeof text !== 'string' || !text) return { text: text ?? '', applied: [] };

  const { disclosures } = scan(text);
  const assigned = new Map();
  const applied = [];
  let out = text;

  for (const { rule, value } of disclosures) {
    if (allow.has(value.toLowerCase())) continue;
    if (assigned.has(value)) continue;
    const marker = makeMarker(rule, assigned.size + 1);
    assigned.set(value, marker);
    applied.push({ rule, value, marker });
  }

  // Longest first, so replacing a short value cannot corrupt a longer one containing it.
  for (const [value, marker] of [...assigned].sort((a, b) => b[0].length - a[0].length)) {
    out = out.split(value).join(marker);
  }

  return { text: out, applied };
}

module.exports = { SECRET_RULES, DISCLOSURE_RULES, PLACEHOLDER, scan, redact };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && node --test test/redact.test.js`
Expected: PASS, 9 tests

- [ ] **Step 5: Rewire the CronJob to the module and prove it is unchanged**

Replace the inlined `SECRET`/`DISCLOSURE`/`PLACEHOLDER` definitions in `k8s/api-backup-github-cronjob.yaml` with `const { SECRET_RULES: SECRET, DISCLOSURE_RULES: DISCLOSURE, PLACEHOLDER } = require('/app/lib/redact');`. The job already runs from the API image, so the module is present.

Keep the job's own HMAC `fingerprint` function exactly as it is and pass it as `makeMarker`. **Its output must not change** — a different marker means every backed-up query looks modified on the next run.

Run the CI script check: `bash .github/workflows/ci.yml`'s embedded-script syntax step, or directly:

```bash
node --check <(sed -n '/node -e/,/^EOF/p' k8s/api-backup-github-cronjob.yaml)
```

Then verify byte-identical output on a real store:

```bash
cd api && node -e "
const { redact } = require('./lib/redact');
const crypto = require('crypto');
const fp = (v) => 'REDACTED-' + crypto.createHmac('sha256','testsalt').update(v).digest('hex').slice(0,8);
const sample = 'Account == \"user@corp.local\" and IP == \"10.1.1.1\"';
console.log(JSON.stringify(redact(sample, (rule, i) => fp(rule + i), new Set()), null, 2));
"
```

Expected: markers in `REDACTED-<8 hex>` form, and the sample's two disclosures both found.

- [ ] **Step 6: Commit**

```bash
git add api/lib/redact.js api/test/redact.test.js k8s/api-backup-github-cronjob.yaml
git commit -m "refactor: extract the disclosure scanner from the backup job into api/lib/redact.js"
```

---

### Task 2: The kqlstore-ai service

**Files:**
- Create: `api-ai/package.json`, `api-ai/server.js`, `api-ai/app.js`, `api-ai/Dockerfile`, `api-ai/.dockerignore`
- Create: `api-ai/lib/redact.js` (a re-export shim — see Step 3)
- Test: `api-ai/test/health.test.js` (create)

**Interfaces:**
- Consumes: `api/lib/redact.js` (Task 1).
- Produces: an Express app on port 3001 serving `GET /api/ai/health` → `{ status: 'ok', model: string, configured: boolean }`.

- [ ] **Step 1: Write the failing test**

```javascript
// api-ai/test/health.test.js
const test = require('node:test');
const assert = require('node:assert');
const { once } = require('events');

const app = require('../app');

let server;
let base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((r) => server.close(r)));

test('health reports the configured model', async () => {
  process.env.OLLAMA_MODEL = 'deepseek-v4-flash:cloud';
  const res = await fetch(`${base}/api/ai/health`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.status, 'ok');
  assert.strictEqual(body.model, 'deepseek-v4-flash:cloud');
});

test('health reports whether a key is present without revealing it', async () => {
  process.env.OLLAMA_API_KEY = 'sk-secret-value-do-not-leak';
  const res = await fetch(`${base}/api/ai/health`);
  const text = await res.text();
  assert.ok(text.includes('"configured":true'));
  assert.ok(!text.includes('sk-secret-value-do-not-leak'), 'the key must never appear in a response');
});

test('the service does not import the database', () => {
  const loaded = Object.keys(require.cache).filter((p) => p.includes('better-sqlite3'));
  assert.deepStrictEqual(loaded, [], 'kqlstore-ai must never load the database driver');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api-ai && node --test test/health.test.js`
Expected: FAIL — "Cannot find module '../app'"

- [ ] **Step 3: Write minimal implementation**

`api-ai/package.json` — express only, matching the API's engine bound:

```json
{
  "name": "kqlstore-ai",
  "version": "1.0.0",
  "description": "Stateless LLM proxy for KQL Store. Holds no data and mounts no volume.",
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "engines": { "node": ">=20 <25" },
  "dependencies": { "express": "^5.2.1" }
}
```

`api-ai/app.js`:

```javascript
const express = require('express');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const MODEL = () => process.env.OLLAMA_MODEL || 'deepseek-v4-flash:cloud';

app.get('/api/ai/health', (_req, res) => {
  res.json({
    status: 'ok',
    model: MODEL(),
    // Whether a key exists, never what it is.
    configured: Boolean(process.env.OLLAMA_API_KEY),
  });
});

// Errors are reported without their stack and without any upstream body: an Ollama error
// can echo the request, and the request contains query text.
app.use((err, _req, res, _next) => {
  const status = err.statusCode || 500;
  res.status(status).json({ error: status === 500 ? 'Internal error' : err.message });
});

module.exports = app;
```

`api-ai/server.js`:

```javascript
const app = require('./app');
const port = Number(process.env.PORT) || 3001;
app.listen(port, () => console.log(`kqlstore-ai listening on ${port}`));
```

For `api-ai/lib/redact.js`, do **not** copy the module. Have the Dockerfile copy `api/lib/redact.js` into the image so there is exactly one definition:

```dockerfile
# api-ai/Dockerfile
FROM node:24-alpine
WORKDIR /app
COPY api-ai/package*.json ./
RUN npm ci --omit=dev
COPY api-ai/ ./
# One definition of "sensitive", shared with the backup job. Copied rather than
# duplicated: two drifting rule tables is exactly the failure this avoids.
COPY api/lib/redact.js ./lib/redact.js
USER node
EXPOSE 3001
CMD ["node", "server.js"]
```

The build context is the repository root. For local test runs, symlink it: `ln -s ../../api/lib/redact.js api-ai/lib/redact.js` and add `api-ai/lib/redact.js` to `.gitignore`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api-ai && npm install && node --test test/health.test.js`
Expected: PASS, 3 tests

- [ ] **Step 5: Add the service to CI**

Extend the `api-test` job in `.github/workflows/ci.yml` with a matching `api-ai` step, guarded on the directory existing exactly as the existing one is.

Run: `npm run lint`
Expected: clean — check `eslint.config.cjs` covers `api-ai/` with the same CommonJS settings as `api/`, and add it if not.

- [ ] **Step 6: Commit**

```bash
git add api-ai .github/workflows/ci.yml eslint.config.cjs .gitignore
git commit -m "feat(ai): add the stateless kqlstore-ai service with a health endpoint"
```

---

### Task 3: Deploy kqlstore-ai and prove the network path

**Files:**
- Create: `k8s/ai-deployment.yaml`, `k8s/ai-service.yaml`, `k8s/ai-networkpolicy.yaml`, `k8s/ai-secret.example.yaml`
- Modify: `k8s/kustomization.yaml`, `nginx.conf`, `k8s/api-networkpolicy.yaml` (frontend egress to the new pod)
- Create: `docs/maintenance/ai-service.md`

**Interfaces:**
- Consumes: the image from Task 2.
- Produces: `/api/ai/health` reachable through nginx from inside the cluster.

**This task is verification-heavy and mostly not unit-testable. Do not skip Step 4.**

- [ ] **Step 1: Write the manifests**

`k8s/ai-deployment.yaml` — 1 replica, no volumes, `OLLAMA_API_KEY` from `secretKeyRef`, readiness and liveness probes on `/api/ai/health`, and a `securityContext` matching `k8s/api-deployment.yaml` (`runAsNonRoot`, `readOnlyRootFilesystem`, dropped capabilities).

`k8s/ai-networkpolicy.yaml`:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: kqlstore-ai
  namespace: kqlstore
  labels:
    app: kqlstore-ai
    app.kubernetes.io/managed-by: kustomize
spec:
  podSelector:
    matchLabels:
      app: kqlstore-ai
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: kqlstore
      ports:
        - protocol: TCP
          port: 3001
  egress:
    # DNS, to resolve ollama.com.
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
    # Ollama Cloud. This CANNOT be pinned to a CIDR — the provider's addresses move — so
    # it is 443 to everything outside RFC1918 and the cluster's own ranges. That is the
    # real price of this feature, and it is why this pod has no database, no volume and
    # no state: what it can reach is broad, so what it can reveal must be narrow.
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8
              - 172.16.0.0/12
              - 192.168.0.0/16
              - 169.254.0.0/16
      ports:
        - protocol: TCP
          port: 443
```

Add an egress rule to the existing `kqlstore-frontend` policy in `k8s/api-networkpolicy.yaml` allowing nginx to reach `app: kqlstore-ai` on 3001. **Do not touch the `kqlstore-api` policy — it stays `egress: []`.**

In `nginx.conf`, add the location block beside the existing `/api/` one:

```nginx
    location /api/ai/ {
        proxy_pass http://kqlstore-ai.kqlstore.svc.cluster.local:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # Streaming. Without this nginx buffers the whole response and the chat degrades
        # to a 30-second blank pause with no error to explain it.
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding on;

        # A thinking model on a long context is slow. The default 60s read timeout cuts
        # answers off mid-stream.
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
```

- [ ] **Step 2: Verify the CSP is untouched**

```bash
grep -c "connect-src 'self'" nginx.conf
```

Expected: `1`. If this is 0, the CSP was weakened — revert. The browser must never call Ollama directly.

- [ ] **Step 3: Verify the API policy is untouched**

```bash
grep -A 2 "^  egress" k8s/api-networkpolicy.yaml | head -5
```

Expected: `egress: []` still present on the `kqlstore-api` policy.

- [ ] **Step 4: Verify the NetworkPolicy deny path across nodes**

This is the known hazard: cross-node SNAT on this cluster erases pod identity, so `from: podSelector` rules permit or deny depending on scheduling. Testing it on one node proves nothing.

```bash
# Where is everything actually running?
kubectl -n kqlstore get pods -o wide

# From an nginx pod, the AI health endpoint must answer.
kubectl -n kqlstore exec deploy/kqlstore -- \
  wget -qO- http://kqlstore-ai:3001/api/ai/health

# From a pod that is NOT labelled app=kqlstore, it must NOT.
kubectl -n kqlstore run netpol-probe --rm -it --restart=Never \
  --image=busybox --labels=app=probe -- \
  wget -T 5 -qO- http://kqlstore-ai:3001/api/ai/health
```

Expected: the first succeeds, the second times out.

Then **force the pods apart and repeat**:

```bash
kubectl -n kqlstore get pods -o wide   # note the nodes
kubectl -n kqlstore cordon <node-running-kqlstore-ai>
kubectl -n kqlstore rollout restart deploy/kqlstore-ai
kubectl -n kqlstore uncordon <node>
# re-run both probes above
```

If the allow case fails once the pods are on different nodes, replace the `from: podSelector` with a `namespaceSelector` on `kubernetes.io/metadata.name: kqlstore` and record the reason in `docs/maintenance/ai-service.md`. **Do not proceed to Task 4 with an unverified network path.**

- [ ] **Step 5: Verify egress actually reaches Ollama**

```bash
kubectl -n kqlstore exec deploy/kqlstore-ai -- \
  node -e "fetch('https://ollama.com/api/tags',{headers:{Authorization:'Bearer '+process.env.OLLAMA_API_KEY}}).then(r=>console.log(r.status)).catch(e=>{console.error('FAILED',e.message);process.exit(1)})"
```

Expected: a 200. A hang means the egress rule or DNS is wrong; a 401 means the Secret is wrong but the network is right.

- [ ] **Step 6: Document and commit**

Write `docs/maintenance/ai-service.md` covering: what the pod is and is not allowed to do, why egress cannot be a CIDR, the cross-node NetworkPolicy hazard and how to re-test it, how to rotate `OLLAMA_API_KEY`, and how to disable the feature entirely (scale to 0 — the SPA must degrade to manual editing, verified in Task 8).

```bash
git add k8s/ nginx.conf docs/maintenance/ai-service.md
git commit -m "feat(k8s): deploy kqlstore-ai with narrow egress, keeping the API pod airgapped"
```

---

### Task 4: The redaction endpoint

**Files:**
- Create: `api-ai/lib/fields.js`, `api-ai/routes/redact.js`
- Modify: `api-ai/app.js` (mount)
- Test: `api-ai/test/redact-route.test.js` (create)

**Interfaces:**
- Consumes: `scan` from `lib/redact.js` (Task 1).
- Produces:
  - `api-ai/lib/fields.js` exporting `FIELDS`, `collectSecrets(fields)`, `redactFields(fields, allow)` and `unredact(text, applied)` — Task 5's chat route imports all four, so they live in a module from the start rather than being extracted later.
  - `POST /api/ai/redact` with body `{ fields: {name?, description?, query?} }` → `200 { redacted: {...}, applied: [{rule, value, marker}], blocked: false }` or `422 { blocked: true, secrets: [{rule, field}], error }`.

**Design note:** markers are typed and readable (`<PRIVATE_IPV4_1>`), not HMAC fingerprints. A model handles a typed placeholder correctly — it keeps `<EMAIL_1>` in a string comparison where it would mangle `REDACTED-a3f1b2c9` — and un-redaction stays reliable when the model rewrites the KQL around it. `applied` is returned so the client can un-redact locally; the mapping never goes upstream.

- [ ] **Step 1: Write the failing test**

```javascript
// api-ai/test/redact-route.test.js
const test = require('node:test');
const assert = require('node:assert');
const { once } = require('events');
const app = require('../app');

let server, base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((r) => server.close(r)));

const post = async (body) => {
  const res = await fetch(`${base}/api/ai/redact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

test('redacts a private IP and returns the mapping', async () => {
  const res = await post({ fields: { query: 'DeviceIP == "10.1.2.3"' } });
  assert.strictEqual(res.status, 200);
  assert.ok(!res.body.redacted.query.includes('10.1.2.3'));
  assert.match(res.body.redacted.query, /<PRIVATE_IPV4_1>/);
  assert.strictEqual(res.body.applied[0].value, '10.1.2.3');
});

test('blocks a request carrying a credential', async () => {
  const res = await post({ fields: { query: 'let k = "AKIAIOSFODNN7EXAMPLE";' } });
  assert.strictEqual(res.status, 422);
  assert.strictEqual(res.body.blocked, true);
  assert.strictEqual(res.body.secrets[0].rule, 'AWS access key id');
});

test('a blocked response does not echo the credential', async () => {
  const res = await fetch(`${base}/api/ai/redact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { query: 'let k = "AKIAIOSFODNN7EXAMPLE";' } }),
  });
  const text = await res.text();
  assert.ok(!text.includes('AKIAIOSFODNN7EXAMPLE'), 'a blocked secret must not come back in the response');
});

test('numbers markers per rule across fields', async () => {
  const res = await post({ fields: { name: 'host dc01.corp', query: 'DeviceIP == "10.0.0.1"' } });
  const rules = res.body.applied.map((a) => a.rule).sort();
  assert.deepStrictEqual(rules, ['Internal hostname', 'Private IPv4']);
});

test('the same value across two fields gets one marker', async () => {
  const res = await post({ fields: { description: 'see 10.0.0.9', query: 'IP == "10.0.0.9"' } });
  assert.strictEqual(res.body.applied.length, 1);
  assert.ok(res.body.redacted.description.includes(res.body.applied[0].marker));
  assert.ok(res.body.redacted.query.includes(res.body.applied[0].marker));
});

test('clean input passes through unchanged', async () => {
  const res = await post({ fields: { query: 'SigninLogs | where ResultType != 0' } });
  assert.strictEqual(res.body.redacted.query, 'SigninLogs | where ResultType != 0');
  assert.deepStrictEqual(res.body.applied, []);
});

test('rejects a body with no fields object', async () => {
  const res = await post({});
  assert.strictEqual(res.status, 400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api-ai && node --test test/redact-route.test.js`
Expected: FAIL — 404

- [ ] **Step 3: Write minimal implementation**

```javascript
// api-ai/lib/fields.js
// ---------------------------------------------------------------------------
// Field-level redaction for one request.
//
// lib/redact.js works on a single string. This works on the three fields that make up a
// query, sharing ONE marker namespace across them: a watchlist name appearing in both the
// description and the query body must become the same placeholder in both. Two
// placeholders for one value tells the model they are two different things, and it will
// write a query that treats them as such.
// ---------------------------------------------------------------------------
const { scan } = require('./redact');

const FIELDS = ['name', 'description', 'query'];

/** <PRIVATE_IPV4_1>, <EMAIL_2>. Typed and readable, on purpose — see redact.js's header. */
const makeMarker = (rule, index) => `<${rule.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${index}>`;

/** Every SECRET hit across the fields, as {rule, field}. Values are deliberately dropped. */
function collectSecrets(fields) {
  const out = [];
  for (const field of FIELDS) {
    const text = fields[field];
    if (typeof text !== 'string') continue;
    for (const hit of scan(text).secrets) out.push({ rule: hit.rule, field });
  }
  return out;
}

function redactFields(fields, allow = new Set()) {
  const assigned = new Map();
  const applied = [];
  const redacted = {};

  for (const field of FIELDS) {
    const text = fields[field];
    if (typeof text !== 'string' || !text) continue;
    for (const { rule, value } of scan(text).disclosures) {
      if (allow.has(value.toLowerCase()) || assigned.has(value)) continue;
      const marker = makeMarker(rule, assigned.size + 1);
      assigned.set(value, marker);
      applied.push({ rule, value, marker });
    }
  }

  // Longest first: replacing a short value cannot then corrupt a longer one containing it.
  const ordered = [...assigned].sort((a, b) => b[0].length - a[0].length);
  for (const field of FIELDS) {
    const text = fields[field];
    if (typeof text !== 'string') continue;
    let out = text;
    for (const [value, marker] of ordered) out = out.split(value).join(marker);
    redacted[field] = out;
  }

  return { redacted, applied };
}

/** Put the originals back. Used on the model's response, where markers may have moved. */
function unredact(text, applied) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const { value, marker } of applied) out = out.split(marker).join(value);
  return out;
}

module.exports = { FIELDS, makeMarker, collectSecrets, redactFields, unredact };
```

```javascript
// api-ai/routes/redact.js
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

    // Secrets are refused outright. A credential does not get a placeholder and a warning
    // — it gets a rejection, because there is no version of "send it anyway" that is
    // correct, and because the operator's next move is to remove it from the query.
    const secrets = collectSecrets(fields);
    if (secrets.length > 0) {
      // Rules only, never the matched value. Echoing it would put the credential into a
      // response body, a browser cache, and probably a screenshot.
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
```

Mount in `api-ai/app.js`: `app.use('/api/ai/redact', require('./routes/redact'));`

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api-ai && node --test test/redact-route.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: clean, no unused imports.

- [ ] **Step 6: Commit**

```bash
git add api-ai/lib/fields.js api-ai/routes/redact.js api-ai/app.js api-ai/test/redact-route.test.js
git commit -m "feat(ai): add the redaction preview endpoint, refusing requests carrying secrets"
```

---

### Task 5: The Ollama chat route

**Files:**
- Create: `api-ai/lib/ollama.js`, `api-ai/routes/chat.js`
- Modify: `api-ai/app.js`
- Test: `api-ai/test/chat.test.js` (create)

**Interfaces:**
- Consumes: `collectSecrets`, `redactFields`, `unredact` from `api-ai/lib/fields.js` (Task 4).
- Produces: `POST /api/ai/chat`, body `{ messages: [{role, content}], schemas: [{name, columns, notes}], allowVerbatim: boolean, draft: {name, description, query} }` → an NDJSON stream of `{type: 'text', value}` lines, then a final `{type: 'proposal', fields: {...}}` or `{type: 'error', value}`.

- [ ] **Step 1: Write the failing test**

```javascript
// api-ai/test/chat.test.js
const test = require('node:test');
const assert = require('node:assert');
const { once } = require('events');

// Stub Ollama before the route loads. No network is touched by this suite.
const upstream = { lastRequest: null, reply: null };
global.fetch = async (url, init) => {
  upstream.lastRequest = { url, init, body: JSON.parse(init.body) };
  return {
    ok: true,
    status: 200,
    body: (async function* () { yield Buffer.from(upstream.reply); })(),
  };
};

const app = require('../app');
let server, base;
test.before(async () => {
  process.env.OLLAMA_API_KEY = 'test-key';
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((r) => server.close(r)));

const chat = async (body) => {
  const res = await fetch(`${base}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
};

const baseBody = {
  messages: [{ role: 'user', content: 'make this detect Okta' }],
  schemas: [{ name: 'OktaLogs', columns: [{ name: 'eventType', type: 'string' }], notes: '' }],
  draft: { name: 'Entra risky sign-in', description: 'd', query: 'SigninLogs | take 1' },
  allowVerbatim: false,
};

test('sends the configured model and a bearer token', async () => {
  upstream.reply = JSON.stringify({ message: { content: 'done' }, done: true }) + '\n';
  await chat(baseBody);
  assert.match(upstream.lastRequest.url, /ollama\.com/);
  assert.strictEqual(upstream.lastRequest.body.model, 'deepseek-v4-flash:cloud');
  assert.strictEqual(upstream.lastRequest.init.headers.Authorization, 'Bearer test-key');
});

test('redacts the draft before it reaches the model', async () => {
  upstream.reply = JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n';
  await chat({ ...baseBody, draft: { ...baseBody.draft, query: 'IP == "10.1.2.3"' } });
  const sent = JSON.stringify(upstream.lastRequest.body);
  assert.ok(!sent.includes('10.1.2.3'), 'an unredacted private IP reached the model');
  assert.ok(sent.includes('<PRIVATE_IPV4_1>'));
});

test('allowVerbatim sends the original text', async () => {
  upstream.reply = JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n';
  await chat({ ...baseBody, draft: { ...baseBody.draft, query: 'IP == "10.1.2.3"' }, allowVerbatim: true });
  assert.ok(JSON.stringify(upstream.lastRequest.body).includes('10.1.2.3'));
});

test('a secret is refused even with allowVerbatim', async () => {
  const res = await chat({
    ...baseBody,
    draft: { ...baseBody.draft, query: 'let k = "AKIAIOSFODNN7EXAMPLE";' },
    allowVerbatim: true,
  });
  assert.strictEqual(res.status, 422, 'allowVerbatim covers disclosures, never credentials');
});

test('includes the supplied schemas in the prompt', async () => {
  upstream.reply = JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n';
  await chat(baseBody);
  assert.ok(JSON.stringify(upstream.lastRequest.body).includes('OktaLogs'));
});

test('streams text chunks as NDJSON', async () => {
  upstream.reply = [
    JSON.stringify({ message: { content: 'Hel' }, done: false }),
    JSON.stringify({ message: { content: 'lo' }, done: true }),
  ].join('\n') + '\n';
  const res = await chat(baseBody);
  const lines = res.text.trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(lines.filter((l) => l.type === 'text').map((l) => l.value), ['Hel', 'lo']);
});

test('emits a proposal from a tool call', async () => {
  upstream.reply = JSON.stringify({
    message: {
      content: '',
      tool_calls: [{ function: { name: 'propose_query', arguments: { name: 'Okta risky sign-in', tags: ['okta'] } } }],
    },
    done: true,
  }) + '\n';
  const res = await chat(baseBody);
  const proposal = res.text.trim().split('\n').map(JSON.parse).find((l) => l.type === 'proposal');
  assert.strictEqual(proposal.fields.name, 'Okta risky sign-in');
});

test('un-redacts markers in the proposal before returning', async () => {
  upstream.reply = JSON.stringify({
    message: { content: '', tool_calls: [{ function: { name: 'propose_query', arguments: { query: 'IP == "<PRIVATE_IPV4_1>"' } } }] },
    done: true,
  }) + '\n';
  const res = await chat({ ...baseBody, draft: { ...baseBody.draft, query: 'IP == "10.1.2.3"' } });
  const proposal = res.text.trim().split('\n').map(JSON.parse).find((l) => l.type === 'proposal');
  assert.strictEqual(proposal.fields.query, 'IP == "10.1.2.3"', 'markers must be restored on the way back');
});

test('a missing API key fails without contacting anything', async () => {
  const saved = process.env.OLLAMA_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  const res = await chat(baseBody);
  assert.strictEqual(res.status, 503);
  assert.ok(!res.text.includes('Bearer'));
  process.env.OLLAMA_API_KEY = saved;
});

test('an upstream failure does not echo the upstream body', async () => {
  const saved = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'upstream said: SigninLogs | where secret' });
  const res = await chat(baseBody);
  assert.ok(!res.text.includes('SigninLogs'), 'an upstream error body can contain the request');
  global.fetch = saved;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api-ai && node --test test/chat.test.js`
Expected: FAIL — 404

- [ ] **Step 3: Write minimal implementation**

`api-ai/lib/fields.js` already exists from Task 4 — import `collectSecrets`, `redactFields` and `unredact` from it. Do not reimplement any of them here.

`api-ai/lib/ollama.js` — build the request and the tool definition:

```javascript
const OLLAMA_URL = process.env.OLLAMA_URL || 'https://ollama.com/api/chat';

// Ollama Cloud does not support the `format` JSON-schema parameter (verified 2026-07-31),
// so this tool definition is the only structure available. It is a request, not a
// guarantee: the model can return fields that do not validate, and the client's review
// gate is what makes that safe. Do not remove that gate on the strength of this schema.
const PROPOSE_TOOL = {
  type: 'function',
  function: {
    name: 'propose_query',
    description: 'Propose changes to the query being edited. Only include fields you are changing.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        query: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        severity: { type: 'string', enum: ['Informational', 'Low', 'Medium', 'High', 'Critical'] },
        attack: {
          type: 'object',
          properties: {
            tactics: { type: 'array', items: { type: 'string' } },
            techniques: { type: 'array', items: { type: 'string' } },
          },
        },
        falsePositives: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

function systemPrompt(schemas) {
  const rendered = schemas.map((s) => {
    const cols = s.columns.map((c) => `${c.name}:${c.type}`).join(', ');
    return `${s.name}\n  columns: ${cols}${s.notes ? `\n  notes: ${s.notes}` : ''}`;
  }).join('\n\n');

  return [
    'You help a detection engineer adapt KQL queries for Microsoft Sentinel and Defender XDR.',
    'Only use columns that appear in the schemas below. If a needed column is absent, say so rather than inventing one.',
    'Values written as <SOMETHING_1> are redacted placeholders. Keep them exactly as they are; never guess what they stood for.',
    'When you change the query or its metadata, call propose_query. Explain your reasoning in the message text.',
    '',
    'Available table schemas:',
    rendered || '(none provided)',
  ].join('\n');
}

module.exports = { OLLAMA_URL, PROPOSE_TOOL, systemPrompt };
```

`api-ai/routes/chat.js`: refuse with 503 when `OLLAMA_API_KEY` is absent; run `collectSecrets` and return 422 when any hit, **regardless of `allowVerbatim`**; redact the draft unless `allowVerbatim`; POST to `OLLAMA_URL` with `{model, messages, tools: [PROPOSE_TOOL], stream: true}`; iterate the response body, emitting `{type:'text'}` per chunk and accumulating tool calls; on completion un-redact every string in the tool-call arguments and emit `{type:'proposal'}`. On a non-ok upstream, emit `{type:'error', value:'The model service failed.'}` — never the upstream body.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api-ai && node --test test/chat.test.js`
Expected: PASS, 10 tests

- [ ] **Step 5: Confirm no secret can reach the wire**

Run: `cd api-ai && node --test "test/**/*.test.js"`
Expected: PASS. The "redacts the draft before it reaches the model" and "a secret is refused even with allowVerbatim" tests are the two that matter most — if either is skipped or weakened, stop.

- [ ] **Step 6: Commit**

```bash
git add api-ai/lib api-ai/routes/chat.js api-ai/app.js api-ai/test/chat.test.js
git commit -m "feat(ai): stream chat from Ollama with redaction on the way out and restoration on the way back"
```

---

### Task 6: The proposal validation gate

**Files:**
- Create: `src/domain/proposal.js`
- Test: `src/domain/__tests__/proposal.test.js` (create)

**Interfaces:**
- Consumes: `validateQuery` from `src/domain/validate.js`.
- Produces: `reviewProposal(draft, proposed)` → `Array<{field, from, to, valid, reason}>`, one entry per field the model wants to change, ordered as given.

- [ ] **Step 1: Write the failing test**

```javascript
// src/domain/__tests__/proposal.test.js
import { describe, it, expect } from 'vitest';
import { reviewProposal } from '../proposal.js';

const draft = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Entra risky sign-in', description: 'Original', query: 'SigninLogs | take 1',
  category: 'Hunting', table: 'SigninLogs', tags: ['entra'], favorite: false, usageCount: 0,
  parentId: null, parentName: '',
};

describe('reviewProposal', () => {
  it('reports a valid field change as accepted-by-default', () => {
    const [change] = reviewProposal(draft, { name: 'Okta risky sign-in' });
    expect(change.field).toBe('name');
    expect(change.from).toBe('Entra risky sign-in');
    expect(change.to).toBe('Okta risky sign-in');
    expect(change.valid).toBe(true);
  });

  it('ignores a field the model returned unchanged', () => {
    expect(reviewProposal(draft, { name: 'Entra risky sign-in' })).toEqual([]);
  });

  it('rejects an invalid ATT&CK technique with a readable reason', () => {
    const [change] = reviewProposal(draft, { attack: { techniques: ['T1078.9'] } });
    expect(change.valid).toBe(false);
    expect(change.reason).toMatch(/T1078\.9/);
  });

  it('accepts a well-formed technique', () => {
    const [change] = reviewProposal(draft, { attack: { techniques: ['T1078.004'] } });
    expect(change.valid).toBe(true);
  });

  it('rejects a severity outside the vocabulary', () => {
    const [change] = reviewProposal(draft, { severity: 'Catastrophic' });
    expect(change.valid).toBe(false);
    expect(change.reason).toMatch(/severity/i);
  });

  it('rejects an empty query rather than letting it through', () => {
    const [change] = reviewProposal(draft, { query: '' });
    expect(change.valid).toBe(false);
  });

  it('rejects a name over 200 characters', () => {
    const [change] = reviewProposal(draft, { name: 'x'.repeat(201) });
    expect(change.valid).toBe(false);
  });

  it('drops tags over the cap but keeps the change valid', () => {
    const tags = Array.from({ length: 30 }, (_, i) => `t${i}`);
    const [change] = reviewProposal(draft, { tags });
    expect(change.valid).toBe(true);
    expect(change.to).toHaveLength(20);
  });

  it('handles several fields at once, each judged independently', () => {
    const out = reviewProposal(draft, { name: 'Okta', severity: 'Nope', description: 'Better' });
    expect(out).toHaveLength(3);
    expect(out.find((c) => c.field === 'name').valid).toBe(true);
    expect(out.find((c) => c.field === 'severity').valid).toBe(false);
    expect(out.find((c) => c.field === 'description').valid).toBe(true);
  });

  it('ignores fields the model is not allowed to set', () => {
    const out = reviewProposal(draft, { id: 'hijacked', usageCount: 9999, parentId: 'x' });
    expect(out).toEqual([]);
  });

  it('returns empty for a null or non-object proposal', () => {
    expect(reviewProposal(draft, null)).toEqual([]);
    expect(reviewProposal(draft, 'nope')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/__tests__/proposal.test.js`
Expected: FAIL — "Failed to resolve import ../proposal.js"

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/domain/proposal.js
// ============================================================
// The model output gate.
//
// Ollama Cloud does not support structured outputs, so nothing constrains what comes back
// — the tool schema in api-ai/lib/ollama.js is a request, not a guarantee. The model will
// return T1078.9, it will return severities that are not in the vocabulary, and it will
// occasionally return an empty query.
//
// So every proposed field is run through the same validateQuery the save path uses,
// applied to a copy of the draft with that one field changed. A field that survives is
// offered pre-accepted; a field that does not is offered pre-REJECTED with the validator's
// own message attached. Nothing is dropped silently and nothing is applied silently: the
// weakness becomes visible rather than hidden.
// ============================================================
import { validateQuery } from './validate.js';

// Fields the model may propose. id, usageCount, parentId, created and updated are
// deliberately absent — they are identity and history, not content, and a model has no
// business proposing them.
const PROPOSABLE = [
  'name', 'description', 'query', 'category', 'table', 'tags',
  'severity', 'confidence', 'queryType', 'platform', 'attack',
  'falsePositives', 'tuningNotes', 'references', 'entityMappings', 'lookback',
];

function unchanged(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The validator's complaint about one field, or '' if it did not complain about it. */
function reasonFor(errors, field) {
  const hit = errors.find((e) => e.toLowerCase().includes(field.toLowerCase()));
  return hit || errors[0] || '';
}

/**
 * @param {object} draft the query as it currently stands in the editor
 * @param {object} proposed the model's tool-call arguments
 * @returns {Array<{field: string, from: unknown, to: unknown, valid: boolean, reason: string}>}
 */
export function reviewProposal(draft, proposed) {
  if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) return [];

  const out = [];
  for (const field of PROPOSABLE) {
    if (!(field in proposed)) continue;
    if (unchanged(draft[field], proposed[field])) continue;

    const candidate = { ...draft, [field]: proposed[field] };
    const { valid, errors, sanitized } = validateQuery(candidate);

    // Judge this field alone: a draft that was already invalid elsewhere must not cause
    // an unrelated proposal to be rejected.
    const complaint = errors.find((e) => e.toLowerCase().includes(field.toLowerCase()));
    const fieldValid = valid || !complaint;

    out.push({
      field,
      from: draft[field],
      to: fieldValid && sanitized ? sanitized[field] ?? proposed[field] : proposed[field],
      valid: fieldValid,
      reason: fieldValid ? '' : reasonFor(errors, field),
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/__tests__/proposal.test.js`
Expected: PASS, 11 tests

- [ ] **Step 5: Verify coverage**

Run: `npm run test:coverage`
Expected: PASS — `src/domain/proposal.js` at or above 80/80/75.

- [ ] **Step 6: Commit**

```bash
git add src/domain/proposal.js src/domain/__tests__/proposal.test.js
git commit -m "feat: validate every AI proposal per-field before it can be accepted"
```

---

### Task 7: Chat, review and redaction-preview components

**Files:**
- Create: `src/components/AIChatPanel.jsx`, `src/components/ProposalReview.jsx`, `src/components/RedactionPreview.jsx`
- Modify: `src/storage/adapter.js` (add `aiChat`, `aiRedact`)
- Test: `src/components/__tests__/aiChat.test.js` (create)

**Interfaces:**
- Consumes: `reviewProposal` (Task 6); `/api/ai/chat` and `/api/ai/redact` (Tasks 4–5).
- Produces: `<AIChatPanel draft onProposal onClose schemas />`, `<ProposalReview changes onAccept onReject />`, `<RedactionPreview applied blocked onConfirm onOverride />`.

- [ ] **Step 1: Write the failing test**

**Same three constraints as Plan 1's Task 6, restated because you may be reading this task alone:**
no JSX in `.js` test files (build trees with `h` from `harness.js`), no `user-event` and no `jest-dom`
(use `fireEvent` and assert on DOM properties), and `// @vitest-environment jsdom` on line 1 with an
explicit `cleanup()` per test.

These three components take ordinary props rather than reading context — they are leaf components
with no shell responsibilities — so `renderWithApp` is only needed for the ones that render a
`Modal`. Use it uniformly anyway; it is harmless and keeps the suites consistent.

```javascript
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, cleanup } from '@testing-library/react';
import { h, renderWithApp } from './harness.js';
import { ProposalReview } from '../ProposalReview.jsx';
import { RedactionPreview } from '../RedactionPreview.jsx';

describe('ProposalReview', () => {
  const changes = [
    { field: 'name', from: 'Old', to: 'New', valid: true, reason: '' },
    {
      field: 'severity', from: 'Low', to: 'Catastrophic', valid: false,
      reason: 'severity must be one of: Informational, Low, Medium, High, Critical',
    },
  ];
  const open = (props = {}) => renderWithApp(
    h(ProposalReview, { changes, onAccept: () => {}, onReject: () => {}, ...props }), {},
  );

  it('shows the old and new value for each change', () => {
    open();
    expect(screen.getByText('Old')).toBeTruthy();
    expect(screen.getByText('New')).toBeTruthy();
    cleanup();
  });

  it('shows the validator reason on an invalid change', () => {
    open();
    expect(screen.getByText(/severity must be one of/)).toBeTruthy();
    cleanup();
  });

  it('pre-selects valid changes and pre-rejects invalid ones', () => {
    open();
    expect(screen.getByRole('checkbox', { name: /name/i }).checked).toBe(true);
    expect(screen.getByRole('checkbox', { name: /severity/i }).checked).toBe(false);
    cleanup();
  });

  it('accepts only what is checked', () => {
    const onAccept = vi.fn();
    open({ onAccept });
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(onAccept).toHaveBeenCalledWith([changes[0]]);
    cleanup();
  });

  it('lets an invalid change be accepted only after an explicit tick', () => {
    const onAccept = vi.fn();
    open({ onAccept });
    fireEvent.click(screen.getByRole('checkbox', { name: /severity/i }));
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(onAccept.mock.calls[0][0]).toHaveLength(2);
    cleanup();
  });

  it('applies nothing when every change is unticked', () => {
    const onAccept = vi.fn();
    open({ onAccept });
    fireEvent.click(screen.getByRole('checkbox', { name: /name/i }));
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(onAccept).toHaveBeenCalledWith([]);
    cleanup();
  });
});

describe('RedactionPreview', () => {
  const applied = [
    { rule: 'Private IPv4', value: '10.1.2.3', marker: '<PRIVATE_IPV4_1>' },
    { rule: 'Watchlist name', value: 'HoneyTokens', marker: '<WATCHLIST_NAME_2>' },
  ];
  const open = (props = {}) => renderWithApp(
    h(RedactionPreview, {
      applied, blocked: false, secrets: [], onConfirm: () => {}, onOverride: () => {}, ...props,
    }), {},
  );

  it('lists what will be replaced', () => {
    open();
    expect(screen.getByText('10.1.2.3')).toBeTruthy();
    expect(screen.getByText('HoneyTokens')).toBeTruthy();
    cleanup();
  });

  it('shows the marker each value becomes', () => {
    open();
    expect(screen.getByText('<PRIVATE_IPV4_1>')).toBeTruthy();
    cleanup();
  });

  it('says nothing will be redacted when the list is empty', () => {
    open({ applied: [] });
    expect(screen.getByText(/nothing will be redacted/i)).toBeTruthy();
    cleanup();
  });

  it('offers an override that names the consequence', () => {
    const onOverride = vi.fn();
    open({ onOverride });
    fireEvent.click(screen.getByRole('button', { name: /send verbatim/i }));
    expect(onOverride).toHaveBeenCalled();
    cleanup();
  });

  it('offers no override at all when the request is blocked for a secret', () => {
    open({ applied: [], blocked: true, secrets: [{ rule: 'AWS access key id', field: 'query' }] });
    expect(screen.queryByRole('button', { name: /send verbatim/i })).toBeNull();
    expect(screen.getByText(/AWS access key id/)).toBeTruthy();
    cleanup();
  });

  it('does not render the matched secret value, only its rule', () => {
    open({ applied: [], blocked: true, secrets: [{ rule: 'AWS access key id', field: 'query' }] });
    expect(document.body.textContent).not.toMatch(/AKIA/);
    cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/aiChat.test.js`
Expected: FAIL — cannot resolve `../ProposalReview.jsx`

- [ ] **Step 3: Write minimal implementation**

Build the three components. Requirements that the tests above pin down and that must not be relaxed:

- `ProposalReview` pre-checks `valid` changes and pre-unchecks invalid ones, shows `reason` verbatim for invalid ones, and requires an explicit tick to accept an invalid change. `onAccept` receives only the checked changes.
- `RedactionPreview` lists every `applied` entry as value → marker, states plainly when nothing will be redacted, and offers "send verbatim" **only when `blocked` is false**. When blocked, it names the rules that fired and offers no way through.
- `AIChatPanel` holds `messages` in local state, calls `aiRedact` before every send, renders `RedactionPreview` as the gate, streams the NDJSON response appending `text` chunks, and on a `proposal` line calls `reviewProposal(draft, fields)` and hands the result to `ProposalReview`. `onClose` discards the conversation — nothing is persisted.

Add `aiChat` and `aiRedact` to `StorageAdapter` following the existing `operationLog` + `apiError` pattern. `aiChat` returns the `Response` so the caller can read the stream; the others parse JSON as usual.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/__tests__/aiChat.test.js`
Expected: PASS, 12 tests

- [ ] **Step 5: Accessibility check**

Run: `npx vitest run src/components/__tests__/a11y.test.js src/components/__tests__/dialog.test.js`
Expected: PASS. The chat panel adds a second focusable region inside the editor's existing focus trap — if `dialog.test.js` fails, the trap needs extending, not disabling.

- [ ] **Step 6: Commit**

```bash
git add src/components/AIChatPanel.jsx src/components/ProposalReview.jsx src/components/RedactionPreview.jsx src/storage/adapter.js src/components/__tests__/aiChat.test.js
git commit -m "feat: add the AI chat panel, proposal review and redaction preview"
```

---

### Task 8: Wire the chat into the editor

**Files:**
- Modify: `src/components/QueryEditorModal.jsx`
- Modify: `src/App.jsx` (load schemas, pass them down, feature detection)
- Test: `src/components/__tests__/editorState.test.js` (extend existing)

**Interfaces:**
- Consumes: `AIChatPanel` (Task 7).
- Produces: the editor renders the chat panel beside the form when toggled, sharing one draft.

- [ ] **Step 1: Write the failing test**

Append to `src/components/__tests__/editorState.test.js`. It already carries the jsdom pragma and
imports `h`, `renderWithApp`, `fireEvent`, `screen` and `cleanup`; add `AIChatPanel` to the imports.

`AIChatPanel` is replaced with a stub via `vi.mock`. What these tests protect is the
**shared-draft contract** — that the panel only reports changes and the form owns them — which is
observable at the boundary without a live stream and without adding any test-only API to the
production component. Task 7's suite covers the panel's own behaviour and Task 5's covers the wire.

```javascript
// Stub the panel: it exposes one button that invokes onProposal with a fixed accepted
// change, which is exactly the contract the editor depends on. Nothing else about the
// panel is this suite's business.
vi.mock('../AIChatPanel.jsx', () => ({
  AIChatPanel: ({ onProposal, onClose }) => h('div', { 'data-testid': 'ai-chat-panel' },
    h('button', {
      type: 'button',
      onClick: () => onProposal([
        { field: 'name', from: 'Entra risky sign-in', to: 'Okta risky sign-in', valid: true, reason: '' },
      ]),
    }, 'apply stub proposal'),
    h('button', { type: 'button', onClick: onClose }, 'close assistant'),
  ),
}));

describe('AI assist and the shared draft', () => {
  const openEditor = (overrides = {}) => renderWithApp(
    h(QueryEditorModal, { key: 'a' }),
    {
      editingQuery: { id: 'a', name: 'Entra risky sign-in', query: 'SigninLogs | take 1', tags: [] },
      saveQuery: vi.fn(),
      setEditingQuery: vi.fn(),
      aiAvailable: true,
      ...overrides,
    },
  );

  it('hides the assist toggle when the AI service is unavailable', () => {
    openEditor({ aiAvailable: false });
    expect(screen.queryByRole('button', { name: /assist with ai/i })).toBeNull();
    cleanup();
  });

  it('offers the assist toggle when the service is up', () => {
    openEditor();
    expect(screen.getByRole('button', { name: /assist with ai/i })).toBeTruthy();
    cleanup();
  });

  it('the form stays editable while the chat is open', () => {
    openEditor();
    fireEvent.click(screen.getByRole('button', { name: /assist with ai/i }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Typed by hand' } });
    expect(screen.getByDisplayValue('Typed by hand')).toBeTruthy();
    cleanup();
  });

  it('accepting a proposal writes through to the form', () => {
    openEditor();
    fireEvent.click(screen.getByRole('button', { name: /assist with ai/i }));
    fireEvent.click(screen.getByRole('button', { name: /apply stub proposal/i }));
    expect(screen.getByDisplayValue('Okta risky sign-in')).toBeTruthy();
    cleanup();
  });

  it('closing the chat keeps the accepted change in the form', () => {
    openEditor();
    fireEvent.click(screen.getByRole('button', { name: /assist with ai/i }));
    fireEvent.click(screen.getByRole('button', { name: /apply stub proposal/i }));
    fireEvent.click(screen.getByRole('button', { name: /close assistant/i }));
    expect(screen.queryByTestId('ai-chat-panel')).toBeNull();
    expect(screen.getByDisplayValue('Okta risky sign-in')).toBeTruthy();
    cleanup();
  });

  it('a hand edit after a proposal is not overwritten', () => {
    openEditor();
    fireEvent.click(screen.getByRole('button', { name: /assist with ai/i }));
    fireEvent.click(screen.getByRole('button', { name: /apply stub proposal/i }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Final wording' } });
    fireEvent.click(screen.getByRole('button', { name: /close assistant/i }));
    expect(screen.getByDisplayValue('Final wording')).toBeTruthy();
    cleanup();
  });
});
```

The stub pins two production requirements: `AIChatPanel` must be a **named** export taking
`onProposal` and `onClose` props, and the editor must render it only while `assistOpen` is true so
that closing unmounts it. Both are what the shared-draft design already calls for.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/editorState.test.js`
Expected: FAIL — no assist toggle

- [ ] **Step 3: Write minimal implementation**

In `QueryEditorModal.jsx` add `const [assistOpen, setAssistOpen] = useState(false);` and render `<AIChatPanel>` beside the form when open, passing the current draft and `onProposal` writing accepted changes back through the existing draft setter. **The draft state must not be duplicated** — the panel receives it and reports changes; it never holds its own copy.

In `App.jsx`, fetch `/api/ai/health` once on mount and hold `aiAvailable`. Pass it to the editor so the toggle is hidden — not disabled — when the service is scaled to 0. Fetch schemas once via `StorageAdapter.fetchSchemas()` and pass them to the panel.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/__tests__/editorState.test.js`
Expected: PASS

- [ ] **Step 5: Verify the degraded path**

Run: `npm run test:coverage && npm run lint && npm run build`
Expected: all PASS.

Then confirm in the cluster that scaling the AI service to zero leaves the editor fully usable:

```bash
kubectl -n kqlstore scale deploy/kqlstore-ai --replicas=0
# Open the app, fork a query, edit it by hand, save. No errors, no assist toggle.
kubectl -n kqlstore scale deploy/kqlstore-ai --replicas=1
```

- [ ] **Step 6: Commit**

```bash
git add src/components/QueryEditorModal.jsx src/App.jsx src/components/__tests__/editorState.test.js
git commit -m "feat: wire the AI chat panel into the query editor over a shared draft"
```

---

### Task 9: Provenance

**Files:**
- Modify: `api/db.js`, `api/validate.js`, `api/routes/queries.js`
- Modify: `src/domain/validate.js`, `src/components/QueryEditorModal.jsx`
- Test: `api/test/provenance.test.js` (create), `src/domain/__tests__/domain.test.js` (extend)

**Interfaces:**
- Consumes: accepted changes from `ProposalReview` (Task 7).
- Produces: `aiProvenance` on every query — an array of at most 10 records, newest last.

- [ ] **Step 1: Write the failing test**

```javascript
// api/test/provenance.test.js
const test = require('node:test');
const assert = require('node:assert');
const { useTempDatabase, startServer, api, makeQuery } = require('./helpers');

useTempDatabase();
const app = require('../app');

let server;
test.before(async () => { server = await startServer(app); });
test.after(async () => { await server.close(); });

const record = (over = {}) => ({
  model: 'deepseek-v4-flash:cloud',
  generatedAt: '2026-07-31T14:02:11Z',
  redaction: 'applied',
  instruction: 'make this detect Okta instead of Entra',
  fields: ['query', 'name'],
  ...over,
});

test('round-trips a provenance record', async () => {
  const res = await api(server.url, '/api/queries', {
    method: 'POST', body: makeQuery({ aiProvenance: [record()] }),
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.aiProvenance.length, 1);
  assert.deepStrictEqual(res.body.aiProvenance[0].fields, ['query', 'name']);
});

test('defaults to an empty array', async () => {
  const res = await api(server.url, '/api/queries', { method: 'POST', body: makeQuery({ name: 'Plain' }) });
  assert.deepStrictEqual(res.body.aiProvenance, []);
});

test('caps at the 10 most recent, dropping the oldest', async () => {
  const many = Array.from({ length: 15 }, (_, i) => record({ instruction: `step ${i}` }));
  const res = await api(server.url, '/api/queries', { method: 'POST', body: makeQuery({ name: 'Many', aiProvenance: many }) });
  assert.strictEqual(res.body.aiProvenance.length, 10);
  assert.strictEqual(res.body.aiProvenance[9].instruction, 'step 14');
  assert.strictEqual(res.body.aiProvenance[0].instruction, 'step 5');
});

test('rejects an unknown redaction value', async () => {
  const res = await api(server.url, '/api/queries', {
    method: 'POST', body: makeQuery({ name: 'Bad', aiProvenance: [record({ redaction: 'maybe' })] }),
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /redaction/);
});

test('truncates an over-long instruction rather than rejecting', async () => {
  const res = await api(server.url, '/api/queries', {
    method: 'POST', body: makeQuery({ name: 'Long', aiProvenance: [record({ instruction: 'x'.repeat(2000) })] }),
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.aiProvenance[0].instruction.length, 1000);
});

test('provenance does not leak into the v4 metadata document', async () => {
  const res = await api(server.url, '/api/queries', {
    method: 'POST', body: makeQuery({ name: 'Separate', severity: 'High', aiProvenance: [record()] }),
  });
  const db = require('../db');
  const row = db.prepare('SELECT metadata FROM queries WHERE id = ?').get(res.body.id);
  assert.ok(!('aiProvenance' in JSON.parse(row.metadata)));
});

test('a malformed provenance column does not 500 the list', async () => {
  const db = require('../db');
  db.prepare(`
    INSERT INTO queries (id, name, query, ai_provenance, created, updated)
    VALUES ('bad1', 'n', 'q', '{not json', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
  `).run();
  const res = await api(server.url, '/api/queries');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.find((q) => q.id === 'bad1').aiProvenance, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test test/provenance.test.js`
Expected: FAIL — `aiProvenance` undefined

- [ ] **Step 3: Write minimal implementation**

In `api/db.js`, add the column using the same guarded pattern as the lineage columns:

```javascript
const hasProvenance = db
  .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('queries') WHERE name = 'ai_provenance'")
  .get().n > 0;
if (!hasProvenance) {
  db.prepare("ALTER TABLE queries ADD COLUMN ai_provenance TEXT NOT NULL DEFAULT '[]'").run();
}
```

In `api/validate.js`, add `validateProvenance(value)` — array, each entry an object, `model` ≤100, `generatedAt` ≤64, `redaction` in `['applied','overridden']` (throw otherwise), `instruction` truncated to 1000, `fields` an array of ≤20 strings — keeping the last 10 entries. Return a JSON string. Call it from `validateQueryPayload` and add `aiProvenance` to `collectMetadata`'s exclusion set.

In `api/routes/queries.js`, add `aiProvenance: parseProvenance(row.ai_provenance)` to `toFrontend` — **before** the metadata spread, using a defensive parser mirroring `parseTags` — and add the column to the INSERT, UPDATE and import statements exactly as Task 3 of Plan 1 did for lineage.

In `src/domain/validate.js`, add the SPA-side equivalent to `validateQuery`, defaulting to `[]`.

In `QueryEditorModal.jsx`, when the user saves after accepting proposals, append one record whose `fields` lists **only the accepted** field names. A rejected proposal contributes nothing.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && node --test test/provenance.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Verify provenance reflects acceptance, not proposal**

The record is built by a pure function so this is testable without mounting anything. Add
`buildProvenanceRecord(accepted, context)` to `src/domain/proposal.js`:

```javascript
/**
 * One provenance entry for a save.
 *
 * `fields` lists what the operator ACCEPTED, never what the model proposed. A rejected
 * rewrite must not leave a record claiming a model authored the detection logic — that is
 * worse than no audit trail, because it is a trail that lies.
 */
export function buildProvenanceRecord(accepted, { model, generatedAt, redaction, instruction }) {
  return {
    model,
    generatedAt,
    redaction,
    instruction: String(instruction || '').slice(0, 1000),
    fields: accepted.map((c) => c.field),
  };
}
```

Add to `src/domain/__tests__/proposal.test.js`:

```javascript
describe('buildProvenanceRecord', () => {
  const ctx = {
    model: 'deepseek-v4-flash:cloud',
    generatedAt: '2026-07-31T14:02:11Z',
    redaction: 'applied',
    instruction: 'make this detect Okta instead of Entra',
  };

  it('records only accepted fields', () => {
    const accepted = [{ field: 'name', from: 'a', to: 'b', valid: true, reason: '' }];
    expect(buildProvenanceRecord(accepted, ctx).fields).toEqual(['name']);
  });

  it('does not record a proposed field that was rejected', () => {
    // The model proposed name AND query; the operator accepted only name.
    const accepted = [{ field: 'name', from: 'a', to: 'b', valid: true, reason: '' }];
    const record = buildProvenanceRecord(accepted, ctx);
    expect(record.fields).not.toContain('query');
  });

  it('records an empty fields array when nothing was accepted', () => {
    expect(buildProvenanceRecord([], ctx).fields).toEqual([]);
  });

  it('carries the redaction state through', () => {
    expect(buildProvenanceRecord([], { ...ctx, redaction: 'overridden' }).redaction).toBe('overridden');
  });

  it('truncates an over-long instruction', () => {
    const record = buildProvenanceRecord([], { ...ctx, instruction: 'x'.repeat(2000) });
    expect(record.instruction).toHaveLength(1000);
  });
});
```

Add `buildProvenanceRecord` to that file's import. In `QueryEditorModal.jsx`, call it with the
accumulated accepted changes and append the result to `draft.aiProvenance` on save.

Run: `npm run test:coverage`
Expected: PASS. **This is the test that keeps the audit trail honest — do not skip it.**

- [ ] **Step 6: Commit**

```bash
git add api/db.js api/validate.js api/routes/queries.js src/domain/validate.js src/components/QueryEditorModal.jsx api/test/provenance.test.js src/components/__tests__/aiChat.test.js
git commit -m "feat: record which fields an AI authored and the operator accepted"
```

---

### Task 10: Documentation

**Files:**
- Modify: `docs/schema.md`, `docs/api.md`, `README.md`, `SECURITY.md`
- Create: `docs/ai-assist.md`

- [ ] **Step 1: Document the provenance field**

Add `aiProvenance` to `docs/schema.md` with its bounds and the reason `fields` records acceptance rather than proposal. State that it is outside the v4 detection metadata document and therefore absent from the Sentinel and Navigator exports.

- [ ] **Step 2: Document the AI routes**

Add `/api/ai/health`, `/api/ai/redact` and `/api/ai/chat` to `docs/api.md`, including the NDJSON stream format and the 422 blocked-for-secret response.

- [ ] **Step 3: Write the feature guide**

Create `docs/ai-assist.md` covering: what is sent and what is not; the two rule classes and why a secret is refused where a disclosure is replaced; why markers are typed placeholders and not HMAC fingerprints; that Ollama Cloud has no structured outputs so the review gate is load-bearing; that no transcript is retained; and how to turn the whole feature off (scale to 0).

- [ ] **Step 4: Update the security documentation**

In `SECURITY.md`, record the deliberate trade: the `kqlstore-ai` pod holds broad egress, the `kqlstore-api` pod holds the data and holds none, and query text leaves the cluster redacted by default with a per-request override. Link to `docs/maintenance/ai-service.md`.

In `README.md`, update the architecture diagram to three Deployments and add the feature to the list.

- [ ] **Step 5: Verify links**

```bash
grep -oE '\]\([^)#][^)]*\)' docs/ai-assist.md docs/api.md docs/schema.md SECURITY.md README.md \
  | sed 's/.*](\(.*\))/\1/' | sed 's/#.*//' | grep -v '^http' | sort -u \
  | while read p; do [ -e "$p" ] || [ -e "docs/$p" ] || echo "DEAD $p"; done
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add docs/ README.md SECURITY.md
git commit -m "docs: document AI-assisted authoring, its data flow and its trade-offs"
```

---

## Definition of done

- [ ] `cd api && node --test "test/**/*.test.js"` passes
- [ ] `cd api-ai && node --test "test/**/*.test.js"` passes
- [ ] `npm run test:coverage`, `npm run lint`, `npm run build` all pass
- [ ] `grep -c "connect-src 'self'" nginx.conf` returns 1
- [ ] `kqlstore-api`'s NetworkPolicy still reads `egress: []`
- [ ] The NetworkPolicy allow and deny paths were verified with the pods on **different nodes**
- [ ] A query containing an AWS key is refused, and the key does not appear in the response
- [ ] A query containing a watchlist name reaches the model as a typed marker, and the marker is restored in the proposal
- [ ] An invalid ATT&CK technique arrives pre-rejected with a readable reason
- [ ] Scaling `kqlstore-ai` to 0 leaves forking and manual editing fully working, with no assist toggle
- [ ] Provenance on a saved query lists only the fields the operator accepted
