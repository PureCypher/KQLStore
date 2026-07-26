# Contributing

Thanks for looking. KQL Store is a small, deliberately unfashionable codebase: React and esbuild,
Express and SQLite, no framework beyond that and very little tooling to learn. Read this once and
you will know everything you need.

## Running it locally

The quickest full-stack loop is the Docker stack from the
[README](README.md#quickstart-with-docker) — two `docker build`s and two `docker run`s. Rebuild
the frontend image after a change to `src/`; the bundle is produced at image build time, so
nothing is picked up until you rebuild:

```bash
docker build -t kqlstore:local . && docker restart kqlstore-web-local
```

For frontend work on its own, build the bundle directly. `better-sqlite3` is not involved here,
so any supported Node will do:

```bash
npm ci
npm run build          # esbuild → dist/app.js, Tailwind → dist/app.css
```

Linting is not part of that install. The root `package.json` belongs to the application build, so
the lint toolchain is pinned in `.github/workflows/ci.yml` and installed on demand — locally, do
the same rather than adding it to the project:

```bash
npm install --no-save --no-package-lock eslint@9.39.5 eslint-plugin-react@7.37.5 \
  eslint-plugin-react-hooks@7.1.1 globals@17.7.0
node_modules/.bin/eslint .
```

For API work, drive it with `curl` and skip the frontend entirely:

```bash
curl -s http://localhost:3000/api/health
curl -s http://localhost:3000/api/queries | head -c 400
```

To run the API on the host rather than in a container — faster restarts, real stack traces —
note that `better-sqlite3` 11.x publishes prebuilt binaries for Node 18, 20 and 22 only. On
anything newer `npm ci` falls back to a node-gyp build that fails; on Node 25 it stops with
`gyp ERR! not ok`. Use Node 22:

```bash
cd api
npm ci
DB_PATH=./dev.db PORT=3000 npm run dev     # node --watch server.js
```

The root `.gitignore` excludes `*.db`, `*.db-wal` and `*.db-shm`, so a local database will not be
committed by accident.

## Tests

Two suites, run separately, because the two halves have separate dependency trees.

**Frontend** — Vitest against the real `src/` modules, with coverage thresholds enforced for
`src/domain` and `src/lib`:

```bash
npm ci
npm test               # 43 tests
npm run test:coverage
```

**API** — Node's built-in test runner, from inside `api/`:

```bash
cd api
npm ci
node --test            # 48 tests
```

Run the API suite from `api/` with no path argument. `node --test test/` treats the directory as
a single file to execute and fails with `MODULE_NOT_FOUND` before running anything.

**Tests must pass before a change is merged.** CI (`.github/workflows/ci.yml`) runs lint, the API
suite, both image builds and a manifest check, but do not use it as your first signal. If a change
makes a test fail, fix the change; only fix the test when the test is provably describing the
wrong behaviour, and say so in the commit message.

Adding tests is welcome and rarely more than a few lines — `api/test/helpers.js` already gives you
a per-file temporary database and a server bound to an ephemeral port, with no supertest and no
extra dependencies.

Do not write a test that re-implements the code it is testing. The suite this one replaced kept
local copies of five functions under a comment reading "mirrors app logic", two of which had
already drifted; it could not have detected a regression in the shipped code. Import the real
module.

## Adding a query

Queries are data, not code. **Do not open a pull request that adds query content.** The repository
ships zero queries on purpose (see the README's opening paragraph). If you want to propose one for
a future bundled set, open a *Detection query submission* issue — the template asks for the
prerequisites and false-positive profile that make a query reviewable by someone who cannot run it
in your tenant.

To add one to your own instance through the UI: **New Query**, then a name and the query body.
Everything else is optional — the table is guessed from the query text if you leave it blank, and
the category defaults to Utility.

Through the API, which is the route for bulk loading:

```bash
curl -s -X POST http://localhost:3000/api/queries \
  -H 'Content-Type: application/json' \
  -d '{
        "name": "Failed sign-ins by source IP",
        "query": "SigninLogs | where ResultType != 0 | summarize count() by IPAddress",
        "category": "Hunting",
        "table": "SigninLogs",
        "tags": ["identity"]
      }'
```

`name` and `query` are required; `category` must be one of Detection, Hunting, Investigation,
Monitoring, Reporting, Enrichment, Utility. A rejected payload comes back as HTTP 400 naming the
specific field. For a batch, POST `{"queries": [...]}` to `/api/queries/import`; add
`"mode": "upsert"` to let newer incoming rows overwrite stored ones, otherwise existing `id`s are
left alone.

## Commit convention

Conventional Commits, lowercase, imperative, no full stop:

```
<type>: <what changed and, where it is not obvious, why>

<optional body — the reasoning, the failure mode, the thing that will not be
obvious to whoever reads this in a year>
```

Types in use: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `perf`. Real examples from
this repository:

```
feat: merge SQLite persistence tier; queries are now shared across devices
fix: close three defects in the KQL syntax highlighter
docs: record Cloudflare Access as the authn layer in the API deployment
```

The earliest commits predate the convention and are sentence-case; match the recent ones, not
those. Subjects that restate the diff (`refactor: improve readability`) are the one thing to
avoid — that history exists here and it is useless.

## Code style

Read a couple of files before writing any. The house style is consistent and easy to match.

**File size.** 200–400 lines is typical, 800 is the ceiling. `src/` is split by responsibility —
`components/`, `domain/`, `storage/`, `hooks/`, `lib/`, `context/` — and new code belongs in the
module that owns that concern rather than in whichever file is already open.

**No components declared inside other components.** A component defined in another component's
body is a new function identity on every render, so React unmounts and remounts the whole subtree
— state lost, inputs blurred mid-typing, effects re-fired. Declare components at module scope and
pass props.

**Comments explain why, not what.** The code says what it does. A comment earns its place by
recording the failure it prevents, the constraint it satisfies, or the alternative that was tried
and did not work. Banner comments (`// ---`, `# ---`) separate major sections in files long enough
to need them.

**American spelling in identifiers, British in prose.** The database column is `favorite`, the
field is `usageCount`, and CSS is `color`. Do not "correct" them: `favorite` is a schema column
name, and renaming it is a migration, not a tidy-up. Prose — comments, documentation, commit
messages, UI copy — is British.

**Immutability.** Build new objects, do not mutate in place. Spread, do not assign.

**Errors are handled explicitly.** No silent `catch {}`. Either recover, with a comment saying
what is being tolerated and why, or propagate. The API's route handlers all funnel through
`next(err)` to `api/middleware/errorHandler.js`; keep them that way.

**Validate at the boundary.** Anything arriving over the network is untrusted, including from the
app's own frontend. Server-side bounds live in `api/validate.js` and every write path goes through
them. Client-side validation is a convenience for the user, never a control.

**Parameterised SQL, always.** Every statement in `api/routes/` is a prepared statement with bound
parameters. There is no string-built SQL in this codebase and there should never be.

**No inline `<script>`, no third-party CDNs.** The Content-Security-Policy in `nginx.conf` is
strict precisely because everything is bundled. Adding a CDN tag or an inline script means
weakening it with `'unsafe-inline'`, which is not a trade this project makes.

**No stray debugging.** `console.error` in the API error handler is deliberate; a `console.log`
left in a component is not, and `eslint .` will tell you.

## Before you open a pull request

- `npm test` passes at the root and `node --test` passes from `api/`, and ESLint passes with no
  new suppressions. A new `eslint-disable` is a change that needs justifying in the PR, not a way
  to get green.
- Both images build: `docker build -t kqlstore:test .` and `docker build -t kqlstore-api:test ./api`.
- No secrets, tokens, or internal hostnames beyond the registry address already in `k8s/`.
- If you changed the schema, `api/db.js` carries an additive migration, and you have run the new
  code against a database created by the *previous* version. A migration that only works on an
  empty table is the failure that reaches the PVC.
- If you changed Kubernetes manifests, `kubectl apply -k k8s/ --dry-run=server` against a real
  cluster where the namespace already exists. A dry run cannot create the namespace, so on a
  genuinely clean cluster every other object reports `namespaces "kqlstore" not found` and tells
  you nothing.
- If you changed behaviour the README describes, the README changed too.

The pull-request template covers the rest, and an honest "not tested" in it is more useful than a
ticked box that was not earned.

By contributing you agree that your work is licensed under the AGPL-3.0-only terms in
[LICENSE](LICENSE).
