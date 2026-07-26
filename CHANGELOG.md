# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project does not
yet follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html): no release has ever been
tagged, so entries below are grouped by date rather than by version, and each is identified by the
commits it covers. The `schemaVersion: 4` the UI reports is the *data* format version, not a
release number.

## [Unreleased]

Work on `feat/persistence-merge`, not yet on `main`. Four large pieces: the move from per-browser
storage to a shared SQLite tier; the move from a CDN-loaded single file to a bundled, modularised,
tested frontend; a validated detection metadata schema with exports that make the library legible
to the rest of the SOC; and an accessibility pass that made the app operable from the keyboard.

### Added

- **Schema v4: a validated detection metadata block.** A query record had eleven fields and not one
  of them was detection metadata, so the library could not answer either of the questions that
  justify keeping one — what is my ATT&CK coverage, and is this rule still valid. ATT&CK IDs could
  only be smuggled into free-text tags, and the deployed instance was doing exactly that, with
  `t1059` and `t1218` sitting alongside `powershell`, where a typo like `T1059.01` is
  indistinguishable from the real thing. v4 adds `queryType`, `severity`, `confidence`, `platform`,
  `attack.tactics`, `attack.techniques`, `dataSources`, `entityMappings`, `falsePositives`,
  `tuningNotes`, `references`, `lookback`, `version`, `lastValidated`, `author` and `license`.
  Tactics are checked against the 14 Enterprise tactics, techniques against `Txxxx[.yyy]`,
  `lookback` against KQL timespan syntax, references must be `http`/`https`, and an entity mapping
  must name a real Sentinel entity type. Everything is optional, so a v3 record still validates
  untouched. Migration promotes what was already there rather than inventing anything: a tag
  matching `tNNNN[.NNN]` becomes an `attack.techniques` entry and the remaining tags are left alone.
  (`33fb9ff`)
- **A `metadata` column and an additive migration** for it — one JSON document rather than
  seventeen columns, on the same reasoning as `tags`: it is optional, it is only ever read as a
  whole, and all filtering happens client-side. The write path accepts the detection fields either
  nested under `metadata` or spread across the top level, because `toFrontend` returns them at the
  top level; without that the API emitted a shape it could not itself consume and a client that read
  a query and wrote it back silently dropped every metadata field. (`33fb9ff`)
- **Three exports, reachable from an accessible export menu** (`33fb9ff`, `b547759`):
  - *Sentinel scheduled analytics rule YAML*, mapping ATT&CK slugs to Sentinel's PascalCase tactics
    and emitting entity mappings in `fieldMappings` shape. Multi-line KQL goes into a literal block
    scalar and round-trips byte-for-byte, verified by parsing the output with PyYAML rather than
    trusting the emitter. Every field it has to default is reported as a warning and listed by rule
    name, so nobody ships an unmapped rule believing it is mapped.
  - *ATT&CK Navigator layer*, scored by how many queries cover each technique so the heat map reads
    as depth rather than yes/no, with the contributing query names in each comment.
  - *Native JSON* now carrying the schema envelope. The old export emitted a bare array, and since
    import only runs the migration chain on a versioned blob, an exported file could never be
    migrated on re-import.
- **`content/starter-pack.json`** — 15 queries across 8 tables, 10 tactics and 16 techniques, every
  one carrying false positives, tuning notes and references. First run was an empty box with nothing
  to search and no worked example of the metadata model. The pack is validated in CI against the
  real validator with zero errors, every query must bound its own time range, and `meta.notice`
  states plainly that these are starting points that have not been validated against live data.
  (`33fb9ff`)
- **A KQL linter** (`src/domain/lint.js`) covering the mistakes that actually cost money in Log
  Analytics: `contains` where `has` would do, unbounded time ranges, leading wildcards, an unscoped
  `search`, `join` without `kind=`, a datetime column compared to a string, deprecated operator
  spellings, `distinct` over a high-cardinality column, `take` without an order, and more. It is a
  lexer plus shape checks rather than a parser, and it never fires inside a comment or a string.
  Every rule has both a positive and a negative test, because a linter that fires on correct KQL
  gets switched off. (`b547759`)
- **Accessibility**, where the app previously had zero `role=`, zero `aria-*` and zero `tabIndex`
  (`b547759`):
  - A shared `Modal` wrapper with `role="dialog"`, `aria-modal`, `aria-labelledby`, focus on open, a
    real Tab trap, Escape handled locally, and focus restored to the opener on close. Applied to the
    keyboard help, the query editor and the import preview, all of which were plain `div`s.
  - `TableSelector` is a proper listbox popup with arrow-key navigation and `aria-activedescendant`.
  - Every icon-only button has an accessible name, the selection control is a real checkbox, and
    toasts are announced through `role="status"`/`aria-live`.
  - Contrast: secondary text was 2.46–4.08:1 against its surfaces where WCAG 1.4.3 wants 4.5:1,
    lifted to roughly 7:1 with the measured before and after in each comment.
  - axe-core: 7 violations across 8 nodes before, 0 after, asserted in the suite and confirmed
    separately in real Chromium across four application states.
- **Optimistic concurrency on `PUT /api/queries/:id`.** Send the `updated` value the edit was based
  on, as `expectedUpdated` or the `X-Expected-Updated` header, and a superseded write is refused with
  409 and the current row rather than silently clobbering a concurrent edit. Opt-in, so existing
  callers — including the SPA — are unaffected. (`4908dde`)
- **Better table detection**: `detectTableFromQuery` now understands `union`, `find`, block comments,
  multi-line `let` statements and ASIM parsers, and no longer mistakes a `let`-bound variable for a
  table. ASIM tables get their own group and badge, having previously been lumped into Custom, which
  is where Microsoft is steering new detection content. The highlighter also covers the negated
  operators, the `project-*` family, `externaldata`, the IP functions and the series/time-bucket
  functions, none of which used to render as anything. (`b547759`)
- **Reference documentation** under `docs/`: the full v4 field table and migration chain
  (`schema.md`), the API surface including both import modes and the concurrency check (`api.md`),
  the three export formats and their limitations (`exports.md`), every lint rule (`kql-linter.md`),
  keyboard and dialog behaviour (`accessibility.md`), and the starter pack (`starter-pack.md`).

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
- **Tests that import the production modules.** The suite began at 43 Vitest cases over
  `src/domain` and `src/lib` with enforced coverage thresholds (`16fce35`) and stood at **296 cases
  across 10 files as of `b547759`**, adding metadata and migration, the exports, the linter, the
  starter pack, the dialog keyboard behaviour and the axe audit. Alongside it, **47 Node
  test-runner cases** over
  the API covering validation, the routes, both import modes, health, the error handler and
  concurrent writes. The highlighter tests encode all three earlier defects as regressions, against
  a reference lexer the implementation must agree with token-for-token; verified by mutation.
  (`16fce35`, `33fb9ff`, `b547759`)
- **`usage_count` column and an additive migration** for databases created before it existed.
  Without it the frontend's `usageCount` was silently dropped on every round-trip and the "Most
  Used" sort could never be populated. (`3325af1`)
- **Server-side input validation** (`api/validate.js`), applied to `POST`, `PUT` and every item of
  an import: name 200 characters, query 50 000, description 1 000, table 200, at most 20 tags of
  50 characters, `category` restricted to an allow-list, `usageCount` a non-negative integer.
  Import is capped at 1 000 items and reports rejected entries instead of silently storing junk.
  (`f29873c`)
- **Pagination** on `GET /api/queries` (`?limit=&offset=`, maximum page size 1 000) and an
  `upsert` mode for `POST /api/queries/import` alongside the existing insert-only default. Offline
  edits were being lost on reconnect: sync used `INSERT OR IGNORE`, so an edit made offline to a
  query that already existed on the server was discarded behind a success response. Upsert
  overwrites only when the incoming row is strictly newer, compared as instants rather than
  lexically, so a stale tab cannot roll back someone else's later edit. An unknown mode is rejected
  rather than defaulted, since a typo would otherwise fall back silently to the mode that discards
  updates. (`4908dde`)
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
- **The native JSON export carries an envelope** (`schemaVersion`, `queries`, `meta`) instead of a
  bare array, so a file exported today can still be migrated when a later build imports it.
  (`33fb9ff`)
- **Export moved from a single button to a menu** offering all three formats, which reports how many
  rules were exported with defaulted fields rather than letting someone ship an unmapped rule
  believing it was mapped. (`b547759`)
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
  strings. The `metadata` column added in v4 is parsed the same way. (`f29873c`, `33fb9ff`)
- **The import route lost its metadata wiring when it was rewritten for upsert support**, so
  importing the starter pack stored 15 queries with every detection field silently dropped. Caught
  by loading the pack through the real stack and reading it back, which is now how it is tested.
  (`b547759`)
- **`migrateData` downgraded data written by a newer build.** It fell through every migration branch
  and returned the blob restamped as the current version, and the caller wrote that downgrade back —
  destroying the version marker so a later migration would never run. It now refuses, and both call
  sites honour the refusal by loading the data read-only. (`33fb9ff`)
- **The KQL editor was a keyboard trap** (WCAG 2.1.2, Level A). The textarea intercepted Tab
  unconditionally to insert four spaces, so a keyboard user could never leave the field. Tab still
  indents; Escape now releases the capture without closing the dialog, with a visible hint wired to
  `aria-describedby`, and the capture returns on re-entry or as soon as the user types. (`b547759`)
- **The table dropdown's Escape destroyed the editor draft.** It bubbled to the global key handler,
  which closed the whole dialog; it now closes only the dropdown and stops propagating. (`b547759`)
- **Copy failed silently outside a secure context.** The clipboard write now falls back to
  `execCommand`, and when both paths fail the message names the cause instead of saying only
  "Failed to copy". (`4908dde`, `33fb9ff`)
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
- **The error handler no longer returns raw 5xx messages**, which leaked SQLite schema detail such
  as `UNIQUE constraint failed: queries.id` to an anonymous caller. Deliberate 4xx keep their
  specific message; the real 5xx message stays in the pod log. (`4908dde`)
- **The detection block is bounded at 20 000 characters serialised**, so the one field that holds
  free-form JSON cannot be used as unbounded storage. Its vocabularies are validated in the SPA
  rather than at the API, which is recorded as a residual risk in [SECURITY.md](SECURITY.md).
  (`33fb9ff`)
- **A query's `references` are restricted to `http` and `https`**, parsed with `new URL()` rather
  than pattern-matched. A reference field is a link, not a script sink, and a `javascript:` entry
  stored today is a rendered anchor tomorrow. (`33fb9ff`)

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
