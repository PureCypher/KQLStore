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

For frontend work on its own, build the bundle directly. `better-sqlite3` is not involved here, so
any supported Node will do — this half is developed on Node 25:

```bash
npm ci
npm run build          # esbuild → dist/app.js, Tailwind → dist/app.css
npm run lint           # eslint ., must be clean
```

The lint toolchain is a root devDependency, so `npm ci` installs it and `npm run lint` uses it. CI
installs a pinned copy only when the project has not already resolved one — see the comment in
`.github/workflows/ci.yml`.

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

Two suites, run separately, because the two halves have separate dependency trees and disagree
about which Node they will run on.

**Frontend** — Vitest against the real `src/` and `content/` modules, with coverage thresholds
enforced for `src/domain` and `src/lib`. Any supported Node:

```bash
npm ci
npm test                       # the whole suite, a few hundred cases in about two seconds
npm run test:coverage          # thresholds: 80% lines and functions, 75% branches
npx vitest run src/domain      # or any path, to narrow the run
```

The suite grows with every feature, so no count is quoted here — `npm test` prints its own. Coverage
is enforced for `src/domain` and `src/lib` only: those modules are pure, they carry the logic that
has actually broken in this repository, and UI coverage is a separate problem.

**API** — Node's built-in test runner, no extra dependencies, from inside `api/`. `better-sqlite3`
11.x publishes prebuilds only up to the Node 22 ABI; on Node 24 it compiles from source instead,
which is why the container below installs a toolchain. If your host Node is outside the supported
range, run the suite in a container, which is what CI effectively does:

```bash
# Mount the repository root, not api/ — test/schema-version.test.js reads src/constants.js
# from the root to prove the API and the SPA agree on the schema version. Mounting only
# api/ makes that one test fail with ENOENT.
docker run --rm -v "$PWD":/repo -w /repo/api node:24-alpine sh -c \
  'apk add --no-cache python3 make g++ >/dev/null 2>&1; npm ci --silent; node --test "test/**/*.test.js"'
# ...
# # tests 49
# # pass 49
# # fail 0
```

On a host already running Node 20–24, the same thing without the container:

```bash
cd api
npm ci
node --test "test/**/*.test.js"     # 49 tests across 7 files
```

Two details about that command, both of which have cost time before:

- **Quote the glob.** Node expands it, not the shell — busybox `sh` has no recursive `**`, and
  `node --test test/` looks like it should work but does not: given a positional path, Node resolves
  it as a module rather than scanning it and fails with `MODULE_NOT_FOUND`.
- **A bare `node --test` reports 50, not 49.** Node's default patterns include everything under
  `test/`, so `test/helpers.js` is loaded as a test file and counted as one passing test despite
  containing none. The glob above is what CI runs and is the honest number.

**Tests must pass before a change is merged.** CI (`.github/workflows/ci.yml`) runs lint, the API
suite, both image builds and a manifest check, but do not use it as your first signal. If a change
makes a test fail, fix the change; only fix the test when the test is provably describing the
wrong behaviour, and say so in the commit message.

Adding tests is welcome and rarely more than a few lines — `api/test/helpers.js` already gives you
a per-file temporary database and a server bound to an ephemeral port, with no supertest and no
extra dependencies, and `src/components/__tests__/harness.js` mounts a component inside the app
context so a component test is three lines.

Do not write a test that re-implements the code it is testing. The suite this one replaced kept
local copies of five functions under a comment reading "mirrors app logic", two of which had
already drifted; it could not have detected a regression in the shipped code. Import the real
module.

## Adding a query

Queries are data, not code. **Do not open a pull request that adds query content**, including to
`content/starter-pack.json`. The pack is deliberately small and every entry has to be reviewable by
someone who cannot run it in their own tenant. If you want to propose one, open a *Detection query
submission* issue — the template asks for the prerequisites and false-positive profile that make a
query reviewable.

To add one to your own instance through the UI: **New Query**, then a name and the query body.
Everything else is optional — the category defaults to Utility and the table selector to `Custom`
— but a query with no `table` sorts and filters badly, so set it.

Through the API, which is the route for bulk loading:

```bash
curl -s -X POST http://localhost:8080/api/queries \
  -H 'Content-Type: application/json' \
  -d '{
        "name": "Failed sign-ins by source IP",
        "query": "SigninLogs | where TimeGenerated > ago(1d) | where ResultType != 0 | summarize count() by IPAddress",
        "category": "Hunting",
        "table": "SigninLogs",
        "tags": ["identity"],
        "severity": "Medium",
        "queryType": "Hunting",
        "attack": { "tactics": ["credential-access"], "techniques": ["T1110"] },
        "lookback": "1d"
      }'
```

`name` and `query` are required; `category` must be one of Detection, Hunting, Investigation,
Monitoring, Reporting, Enrichment, Utility. A rejected payload comes back as HTTP 400 naming the
specific field. The detection fields are accepted either at the top level, as above, or nested under
`metadata` — see [docs/schema.md](docs/schema.md) for every field and [docs/api.md](docs/api.md) for
the endpoints. For a batch, POST `{"queries": [...]}` to `/api/queries/import`; add
`"mode": "upsert"` to let newer incoming rows overwrite stored ones, otherwise existing `id`s are
left alone.

Note that the API bounds the *size* of the detection block and leaves the vocabularies to the SPA,
so a POST like the one above can store a technique ID the UI would have rejected. If you are
scripting a bulk load, validate before you send.

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
feat: detection metadata schema v4, Sentinel/ATT&CK exports, and a starter pack
feat: accessibility, KQL linting, and reachable exports
fix: close three defects in the KQL syntax highlighter
docs: record Cloudflare Access as the authn layer in the API deployment
```

The earliest commits predate the convention and are sentence-case; match the recent ones, not
those. Subjects that restate the diff (`refactor: improve readability`) are the one thing to
avoid — that history exists here and it is useless.

## Code style

Read a couple of files before writing any. The house style is consistent and easy to match.

**File size.** 200–400 lines is typical, 800 is the ceiling. `src/` is split by responsibility —
`components/`, `domain/`, `export/`, `storage/`, `hooks/`, `lib/`, `context/` — and new code belongs
in the module that owns that concern rather than in whichever file is already open.

**No components declared inside other components.** This one is enforced:
`react/no-unstable-nested-components` is an error in `eslint.config.cjs` and it will fail your
build. A component defined in another component's body is a new function identity on every render,
so React unmounts and remounts the whole subtree — state lost, inputs blurred mid-typing, effects
re-fired. Ten of them once lived inside `App()`: the sidebar search box lost focus after every
keystroke, the query editor discarded in-progress drafts whenever any background state changed, and
every `React.memo` wrapper was inert. Declare components at module scope and read shared state from
the context in `src/context/app.js`.

**Hooks run before any early return.** `react-hooks/rules-of-hooks` is also an error. A modal that
returns `null` when it is closed must still have called every `useState` above that return, or React
sees a different hook count between the two states and throws error #310.

**Comments explain why, not what.** The code says what it does. A comment earns its place by
recording the failure it prevents, the constraint it satisfies, or the alternative that was tried
and did not work. Banner comments (`// ---`, `# ---`) separate major sections in files long enough
to need them.

**American spelling in identifiers, British in prose.** The database column is `favorite`, the
metadata field is `license`, and CSS is `color`. Do not "correct" them: `favorite` is a schema
column name, and renaming it is a migration, not a tidy-up. Prose — comments, documentation, commit
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

**Accessibility is not optional.** New interactive UI carries an accessible name, a visible focus
indicator (`FOCUS_RING` from `src/components/a11y.jsx`) and keyboard operation, and a new dialog uses
the shared `Modal` rather than a fresh `div`. `src/components/__tests__/a11y.test.js` asserts zero
axe violations and will fail if you regress it — see [docs/accessibility.md](docs/accessibility.md).

**No stray debugging.** `console.error` in the API error handler is deliberate; a `console.log`
left in a component is not, and `npm run lint` will tell you.

## Before you open a pull request

- `npm test` passes at the root, the API suite passes under Node 22, and `npm run lint` is clean
  with no new suppressions. A new `eslint-disable` is a change that needs justifying in the PR, not
  a way to get green.
- Both images build: `docker build -t kqlstore:test .` and `docker build -t kqlstore-api:test ./api`.
- No secrets, tokens, or internal hostnames beyond the registry address already in `k8s/`.
- If you changed the schema, `api/db.js` carries an additive migration, `src/domain/migrate.js`
  carries the version step, `CURRENT_SCHEMA_VERSION` moved, and you have run the new code against a
  database created by the *previous* version. A migration that only works on an empty table is the
  failure that reaches the PVC.
- If you changed Kubernetes manifests, `kubectl apply -k k8s/ --dry-run=server` against a real
  cluster where the namespace already exists. A dry run cannot create the namespace, so on a
  genuinely clean cluster every other object reports `namespaces "kqlstore" not found` and tells
  you nothing.
- If you changed behaviour a document describes, that document changed too — the README, and
  whichever of `docs/schema.md`, `docs/api.md`, `docs/exports.md`, `docs/kql-linter.md`,
  `docs/accessibility.md` or `docs/starter-pack.md` covers it. Every command in those files is meant
  to be one you can paste and run.

The pull-request template covers the rest, and an honest "not tested" in it is more useful than a
ticked box that was not earned.

By contributing you agree that your work is licensed under the AGPL-3.0-only terms in
[LICENSE](LICENSE).
