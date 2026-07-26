# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project does not
yet follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html): no release has ever been
tagged, so entries below are grouped by date rather than by version, and each is identified by the
commits it covers. The `schemaVersion: 3` the UI reports is the *data* format version, not a
release number.

## [Unreleased]

Work on `feat/persistence-merge`, not yet on `main`. Two large pieces: the move from per-browser
storage to a shared SQLite tier, and the move from a CDN-loaded single file to a bundled,
modularised, tested frontend.

### Added

- **SQLite persistence tier.** The source of truth moved from per-browser `localStorage` to an
  Express + `better-sqlite3` API backed by a PersistentVolumeClaim. `localStorage` is demoted to a
  read cache, and queries that existed only in the cache are pushed to the API once on first load.
  nginx proxies `/api/` to the API Service so the browser stays same-origin. This removes the
  architecture's central limitation: queries were scoped to one browser profile, on one device, at
  one origin, and were visible nowhere else. (`3325af1`)
- **A real build.** The frontend is bundled at image build time by esbuild and the Tailwind CLI
  into `dist/app.js` and `dist/app.css`, from a committed lockfile with `npm ci --ignore-scripts`
  and both of its base images pinned by digest. One 2 706-line `KQLStore.jsx` became 30 modules
  under `src/`, none near the 800-line ceiling, organised as `components/`, `domain/`, `storage/`,
  `hooks/`, `lib/` and `context/`. (`c559197`)
- **A Content-Security-Policy**, made possible by the bundle: `script-src 'self'` with neither
  `unsafe-inline` nor `unsafe-eval`, plus `frame-ancestors 'none'`, `base-uri 'none'` and
  `object-src 'none'`. `style-src` keeps `unsafe-inline` for React's `style` prop, documented in
  `nginx.conf` along with what removing it would take. (`c559197`)
- **Tests that import the production modules**: 43 Vitest cases over `src/domain` and `src/lib`
  with enforced coverage thresholds, and 48 Node test-runner cases over the API covering
  validation, the routes, import, health, the error handler and concurrent writes. The highlighter
  tests encode all three earlier defects as regressions, against a reference lexer the
  implementation must agree with token-for-token; verified by mutation. (`16fce35`)
- **`usage_count` column and an additive migration** for databases created before it existed.
  Without it the frontend's `usageCount` was silently dropped on every round-trip and the "Most
  Used" sort could never be populated. (`3325af1`)
- **Server-side input validation** (`api/validate.js`), applied to `POST`, `PUT` and every item of
  an import: name 200 characters, query 50 000, description 1 000, table 200, at most 20 tags of
  50 characters, `category` restricted to an allow-list, `usageCount` a non-negative integer.
  Import is capped at 1 000 items and reports rejected entries instead of silently storing junk.
  (`f29873c`)
- **Pagination** on `GET /api/queries` (`?limit=&offset=`, maximum page size 1 000) and an
  `upsert` mode for `POST /api/queries/import` alongside the existing insert-only default.
- **NetworkPolicy** (`k8s/api-networkpolicy.yaml`) restricting API ingress to the frontend pods
  and denying API egress entirely. A ClusterIP Service is reachable by every pod in the cluster,
  so this is the primary in-cluster access control. (`3325af1`)
- **Optional `API_TOKEN` bearer check**, placed before `express.json()` so an unauthenticated
  caller never has a body parsed on its behalf. Health is exempt for kubelet probes. Off by
  default, with a startup warning. (`3325af1`)
- **An `ErrorBoundary` with export-and-purge recovery.** A render-time throw previously left a
  blank page, and the only recovery UI lived inside the crashed tree. (`c559197`)
- **A nightly backup CronJob** (`k8s/api-backup-cronjob.yaml`) with its own claim, deny-all
  NetworkPolicy and 14-day retention. It uses SQLite's online backup API — the image carries no
  `sqlite3` CLI — takes the copy out of WAL mode, and verifies it with `integrity_check` and a row
  count before pruning anything.
- **`k8s/kustomization.yaml`**, so `kubectl apply -k k8s/` converges on a first apply: kustomize
  sorts by kind, which puts the Namespace and the claims ahead of the workloads that need them.
- **CI** (`.github/workflows/ci.yml`) running lint, both test suites, both image builds and a
  manifest check, with every action pinned to a commit SHA and a read-only default token; plus
  issue and pull-request templates and a Dependabot configuration.
- **Startup probes, a PodDisruptionBudget and topology spread** for the frontend;
  `automountServiceAccountToken: false` on every pod; and `NODE_OPTIONS=--max-old-space-size=96`,
  because V8 does not derive its heap ceiling from the cgroup limit and the pod is OOMKilled
  instead of collecting.
- **`api/package-lock.json`** (generated under `node:22-alpine`) so the API image is reproducible,
  plus `api/.dockerignore` and a repository `.gitignore`. `engines` pinned to `>=20 <23` because
  `better-sqlite3` 11.x publishes no prebuild for newer runtimes. (`3325af1`)
- **Project documentation**: `README.md` rewritten from its one-line placeholder, plus `LICENSE`
  (AGPL-3.0-only), `CONTRIBUTING.md`, `SECURITY.md` and this changelog;
  `docs/local/nginx.local.conf` for running the frontend image outside Kubernetes, where the
  shipped config's cluster upstream cannot be resolved; and `docs/maintenance/backup-shell.yaml`,
  a throwaway pod for pulling backups off the node and restoring them.

### Changed

- **Every mutation path now goes through the API.** `toggleFavorite`, `incrementUsage`,
  `handleBulkDelete`, `handleBulkCategory`, `handleBulkTable` and `duplicateQuery` previously wrote
  only the `localStorage` cache, each showing a success toast first. Once the API became the source
  of truth the next load replaced those writes with the server rows: starring a query silently
  un-starred itself, usage counts reset, bulk-deleted queries came back, bulk re-categorisation was
  discarded, and a duplicate existed only in the cache. Bulk operations share an `applyBulk` helper
  that reports what actually landed rather than asserting success. (`3325af1`, `f29873c`)
- Request body limit lowered from 10 MB to 2 MB, with a matching `client_max_body_size` in
  `nginx.conf` so the proxy and the parser agree. (`f29873c`)
- `k8s/api-deployment.yaml` documents why `API_TOKEN` is deliberately unset: Cloudflare Access
  authenticates at the edge, and enabling the token without also making nginx inject the header
  locks the SPA out of its own API entirely. (`1d118ec`, `f29873c`)

### Removed

- **Third-party CDNs.** React, lucide and Tailwind were fetched from `esm.sh` and
  `cdn.tailwindcss.com` on every page load, with no subresource integrity and no version pin on
  Tailwind — arbitrary code execution in the app's origin on any CDN compromise, a usage beacon to
  two third parties, and unusable air-gapped. (`c559197`)
- `KQLStore.jsx`, `KQLStoreTests.jsx` and `tests.html`, superseded by `src/` and the Vitest suite.
  The harness had already stopped being shipped in the production image: a test harness on the
  production surface can touch the same origin's storage. (`c559197`, `16fce35`)

### Fixed

- **Syntax highlighter, three defects** (`9ca5b8d`):
  - *`$`-expansion denial of service.* The placeholder restore loop passed user query text as a
    string replacement, so `` $& ``, `` $` ``, `$'` and `$$` were interpreted as special patterns. A
    116-byte query body containing `$'` expanded to roughly 41 MB and hung the tab on every page
    load; 289 bytes exceeded V8's maximum string length. Now uses a function replacement, which
    disables `$` interpretation.
  - *Placeholder token spoofing.* A query containing a literal `__PH0__` was matched first by the
    restore loop, relocating a comment into a string literal and leaving the real token visible as
    text. The token prefix is now derived from the input so it cannot collide.
  - *Comments versus strings.* Separate passes were mutually destructive: a `//` inside a URL
    literal opened a comment that swallowed the rest of that line and the line after it. Both are
    now matched in one alternation, so whichever opens first wins.

  Verified against an independent reference lexer over 29,712 fuzz inputs: 15,605 disagreements
  before, 0 after.
- **Ten components were declared inside `App()`.** React reconciles by element-type identity, so
  each was a new type on every render and its entire subtree was unmounted and remounted whenever
  the parent re-rendered. The sidebar search input lost focus after every keystroke; the query
  editor discarded an in-progress draft whenever any background state changed, including on
  invisible timers; armed delete confirmations reverted themselves; and the `React.memo` wrappers
  were inert, because the memoised object itself was recreated each render. All ten now live at
  module scope and read shared state from a context. (`c559197`)
- **Editing a saved query was broken.** `saveQuery` decided create-versus-update from a flag
  assigned inside a `setQueries` updater. React defers updaters, so the flag was still false when
  the request was dispatched: every edit took the create path, `POST`ed a duplicate primary key and
  was rejected with a 500. The decision now comes from `queriesRef`. (`3325af1`)
- **The `/api/` proxy configuration did not parse.** `resolver` had been given a hostname; nginx
  requires an IP address, so the config was invalid and the container could not start. Confirmed
  with `nginx -t` against the real file. (`c559197`)
- **The SPA fallback turned every missing asset into a 200 carrying `index.html`.** There is no
  client-side router, so `try_files` now ends in `=404`. (`c559197`)
- **`crypto.timingSafeEqual` compared character length, not byte length.** A token of equal
  character length but different UTF-8 byte length made it throw `RangeError`, turning a 401 into a
  500 and handing the caller a token-length oracle. Bearer matching is also now case-insensitive,
  per RFC 7235. (`f29873c`)
- **One malformed `tags` row could 500 every endpoint that read it.** `toFrontend` called
  `JSON.parse` on the column unguarded; it now parses defensively and coerces to an array of
  strings. (`f29873c`)
- `generateId` prefers `crypto.randomUUID`, falling back to the `Math.random` path only on
  plain-HTTP origins where it is undefined. (`c559197`)

### Security

- **CORS is off by default.** A bare `cors()` reflected every origin, which let any page on the
  network read and write the entire query store. The middleware is now mounted only when
  `CORS_ORIGIN` is set explicitly — unnecessary in the shipped topology, where nginx makes the
  browser same-origin. (`3325af1`)
- **`/api/health` no longer discloses the query count**, which handed anyone who could reach the
  port the size of the estate's detection library for free. It reports status, writability and a
  timestamp, and separately proves the PVC is neither full nor read-only.
- Without the new field bounds, one request could write a multi-megabyte query body or a
  100 000-element tags array into the PVC. A large enough store then exhausts the pod's memory on
  every `GET /api/queries` while `/api/health` still reports `ok`, so Kubernetes never sees an
  unhealthy pod and it restarts straight back into the same failure. (`f29873c`)

## 2026-03-09

### Removed

- `.playwright-mcp/` browser console logs, committed by accident. (`e0670a3`)

## 2026-02-21

### Fixed

- Error handling in the KQL storage adapter; deployment configuration corrections across
  `k8s/api-deployment.yaml` and `k8s/deployment.yaml`, and a `db.js` adjustment. (`8035394`)

## 2026-02-16

### Added

- **First API tier**, on the `feature/storage-persistence` branch: `api/` with Express, SQLite,
  routed queries and health endpoints, an error-handling middleware and a Dockerfile; `k8s/`
  manifests for the API Deployment, Service and PVC; `/api/` proxying in `nginx.conf`. (`7f9ff04`)
- Credentials included on API fetches, and richer query-description rendering. (`4df1ec7`)

### Changed

- Query description validation relaxed and the description textarea reworked for longer input.
  (`245fa71`)

## 2026-02-15

### Added

- **Initial application.** The `KQLStore.jsx` SPA and its `KQLStoreTests.jsx` browser test suite,
  `index.html` and `tests.html` import-map entry points, the Babel-build `Dockerfile`,
  `nginx.conf`, and the first Kubernetes manifests — Namespace, Deployment and Service.
  (`9da1a2a`, `c6d91c5`)
- The deployed-interface screenshot used by the README. (`34f5454`)
