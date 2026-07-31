# KQL Store

A self-hosted manager for the KQL queries you have already written for Microsoft Sentinel and
Defender XDR. It gives them a home: a searchable, taggable, syntax-highlighted store that lives on
your own infrastructure instead of in a wiki page, a OneNote tab, or forty browser bookmarks. Since
schema v4 it also holds the metadata that makes a query a *detection* — ATT&CK mapping, severity,
entity mappings, false positives, tuning notes — and can export the result as Sentinel analytics
rules or an ATT&CK Navigator layer.

**It is still not a content feed.** There is no upstream to sync from, no rule packs and no
connection to Microsoft. Beyond the 15-query [starter pack](docs/starter-pack.md), which is a set of
worked examples rather than validated detections, everything in it will be something you or your
team put there.

![The KQL Store interface: a sidebar of categories, tables and tags with per-item counts, beside a
list of query cards. Each card shows a title, a collapsible code block and its table, category and
last-updated badges. Query titles, descriptions and KQL bodies appear as grey placeholder bars
because this is a live instance and its contents are redacted.](kqlstore-v4-deployed.png)

*A running instance, not a mock-up — hence the 48 queries and the populated sidebar counts. The
titles, descriptions and query bodies are redacted: this is somebody's real detection library, and
publishing it would say as much about what it does not cover as what it does. The starter pack in
`content/` is the content you get on a fresh install.*

## Architecture

Two images, two Deployments. The SPA is bundled at image build time by esbuild and Tailwind and
served as static assets by nginx; nginx also reverse-proxies `/api/` to an Express service that
owns a SQLite database on a PersistentVolumeClaim. Nothing is fetched from a third-party origin
at runtime, which is what makes the strict Content-Security-Policy in `nginx.conf` possible.

```
                 Cloudflare Access   (authentication happens here, at the edge)
                          │
                          ▼
  ┌────────────────────────────────────────────┐
  │ Deployment: kqlstore          (2 replicas) │
  │   nginx :8080                              │
  │     /       → index.html, app.js, app.css  │  static bundle
  │     /api/   → proxy_pass ──────────────┐   │
  └────────────────────────────────────────┼───┘
                                           │  ClusterIP, NetworkPolicy-restricted
                                           ▼
  ┌────────────────────────────────────────────┐
  │ Deployment: kqlstore-api       (1 replica) │
  │   Express :3000 → better-sqlite3           │
  │                     /data/kqlstore.db      │
  └───────────────────────┬────────────────────┘
                          │
          ┌───────────────┴────────────────┐
          ▼                                ▼
  PVC kqlstore-api-data          CronJob kqlstore-api-backup
  (1Gi, ReadWriteOnce)           nightly → PVC kqlstore-api-backup
```

The API Deployment is single-replica with a `Recreate` strategy and **must never be scaled above
one**: the store is a single SQLite file on a ReadWriteOnce volume, which binds to one node and
tolerates exactly one writer. Scaling out means replacing SQLite, not adding replicas.

| Path | What it is |
| --- | --- |
| `src/` | The SPA — `components/`, `domain/` (highlighter, linter, validation, migration), `export/`, `storage/`, `hooks/`, `lib/`, `context/` |
| `content/` | `starter-pack.json`, 15 example queries, validated in CI |
| `index.html` | Entry point; loads the bundle, no inline script |
| `nginx.conf` | Static serving, `/api/` proxy, CSP and security headers |
| `Dockerfile` | esbuild + Tailwind build stage → `nginx:1.31-alpine` runtime |
| `api/` | Express app, SQLite schema, request validation, `api/test/` |
| `k8s/` | Namespace, Deployments, Services, PVCs, NetworkPolicies, backup CronJob |
| `docs/` | The reference pages listed at the [end of this file](#documentation) |
| `docs/local/` | Configuration used only when running outside Kubernetes |
| `docs/maintenance/` | Manifests applied by hand for backup and restore, never deployed |
| `.github/` | CI, issue and pull-request templates |

## Quickstart with Docker

Build both images, then run them on a user-defined network so the frontend can resolve the API
by container name.

```bash
docker build -t kqlstore-api:local ./api
docker build -t kqlstore:local .

docker network create kqlstore-local
docker volume create kqlstore-data

docker run -d --name kqlstore-api-local \
  --network kqlstore-local -p 3000:3000 \
  -v kqlstore-data:/data \
  kqlstore-api:local

docker run -d --name kqlstore-web-local \
  --network kqlstore-local -p 8080:8080 \
  -v "$PWD/docs/local/nginx.local.conf:/etc/nginx/nginx.conf:ro" \
  kqlstore:local
```

The mounted config is not optional. The shipped `nginx.conf` proxies to
`kqlstore-api.kqlstore.svc.cluster.local` and resolves that name once at startup; off-cluster the
name does not exist, so nginx aborts with `host not found in upstream` and the container never
serves a byte. `docs/local/nginx.local.conf` is the same configuration — same CSP, same headers —
with the upstream pointed at the API's container name. **That name is `kqlstore-api-local`**, so
keep it if you rename anything else, or edit the `proxy_pass` line to match.

Check it came up:

```bash
curl -s http://localhost:8080/api/health
# {"status":"ok","writable":true,"timestamp":"2026-07-26T13:02:46.337Z"}
```

Then open <http://localhost:8080/>. The store starts empty; see
[First run](#first-run-the-starter-pack) below.

Tear down:

```bash
docker rm -f kqlstore-web-local kqlstore-api-local
docker network rm kqlstore-local
docker volume rm kqlstore-data      # this destroys the query store
```

## First run: the starter pack

[`content/starter-pack.json`](content/starter-pack.json) is 15 queries across 8 tables, 10 ATT&CK
tactics and 16 techniques, each carrying the full v4 metadata block. Load it through the app's
**Import** button, or post it straight at the API — the file can go over the wire as-is:

```bash
curl -s -X POST http://localhost:8080/api/queries/import \
  -H 'Content-Type: application/json' \
  --data-binary @content/starter-pack.json
# {"mode":"insert","total":15,"imported":15,"inserted":15,"updated":0,
#  "skippedOlder":0,"skippedExisting":0,"results":[…],"rejected":[]}
```

The ids are stable, so importing it twice adds nothing the second time.

**These are starting points, not validated detections.** None of them has been run against a real
tenant, every one needs baselining against your own estate before it becomes an analytics rule, and
each carries the `falsePositives` and `tuningNotes` that say what to baseline. The full detail is in
[docs/starter-pack.md](docs/starter-pack.md).

## Deploy to Kubernetes

The manifests reference `192.168.1.100:5000`, a registry on the maintainer's own network. **Change
the image references to your own registry before applying** — in `k8s/deployment.yaml`,
`k8s/api-deployment.yaml` and `k8s/api-backup-cronjob.yaml`, which deliberately runs the same
image as the API.

`k8s/api-backup-offsite-config.yaml` is the same kind of file: `OFFSITE_ENDPOINT` and
`OFFSITE_BUCKET` name the maintainer's own storage, so **change them before applying** and create
the credential Secret, which is deliberately not in this repository. See
[docs/maintenance/offsite-backup.md](docs/maintenance/offsite-backup.md). Applied unchanged it
does not quietly do nothing — the job cannot reach an endpoint that is not on your network, so the
Job goes red — but it fails with a connection error rather than the preflight naming the value you
did not set.

```bash
docker build -t <your-registry>/kqlstore:latest .
docker build -t <your-registry>/kqlstore-api:latest ./api
docker push <your-registry>/kqlstore:latest
docker push <your-registry>/kqlstore-api:latest
```

Deploy with kustomize. `k8s/kustomization.yaml` exists precisely so a first apply converges:
kustomize sorts its output by kind, which puts the Namespace and the claims ahead of the
workloads that need them.

```bash
kubectl apply -k k8s/
kubectl -n kqlstore rollout status deploy/kqlstore-api
kubectl -n kqlstore rollout status deploy/kqlstore
```

Do not use `kubectl apply -f k8s/`. It fails twice over: it tries to submit
`kustomization.yaml` itself as a resource (`no matches for kind "Kustomization"`), and it reads
the rest of the directory in lexical order, so on a clean cluster `api-backup-cronjob.yaml` is
admitted before `namespace.yaml` has created the namespace and everything after it fails with
`namespaces "kqlstore" not found`.

Both PVCs request `storageClassName: local-path`. Change them in `k8s/api-pvc.yaml` and
`k8s/api-backup-pvc.yaml` if your cluster provisions storage differently, or the claims sit
`Pending` forever and the API pod never schedules.

There is no Ingress in this repository, by design. **Cloudflare Access fronts the application and
performs all user authentication at the edge**; the API itself has no authentication. See
[SECURITY.md](SECURITY.md) for why, and for the obligation that comes with it. Expose
`svc/kqlstore` through whatever tunnel or ingress your Access policy covers, and nothing else.

`k8s/api-networkpolicy.yaml` admits only the frontend pods to the API and denies the API all
egress; the frontend may reach the API and kube-dns and nothing more. The backup Job carries its
own deny-all policy alongside the CronJob.

## Detection metadata

A query record carries an optional, validated detection block: `queryType`, `severity`,
`confidence`, `platform`, `attack.tactics` and `attack.techniques`, `dataSources`, `entityMappings`,
`falsePositives`, `tuningNotes`, `references`, `lookback`, `version`, `lastValidated`, `author` and
`license`.

Tactics are checked against the 14 ATT&CK Enterprise tactics, techniques against `Txxxx[.yyy]` —
so `T1059.01` is rejected rather than stored — `lookback` against KQL timespan syntax, references
must be `http`/`https`, and an entity mapping must name a real Sentinel entity type. Everything is
optional, so a record written before v4 still validates untouched and the fields can be filled in
over time.

**The full field table, with types, bounds and accepted values, is in
[docs/schema.md](docs/schema.md)**, along with the migration chain and the exact semantics of a
validation failure.

## Exports

Three formats, from the **Export** button:

- **JSON (native)** — the round-trip format, carrying a schema envelope so a file exported today can
  still be migrated when it is imported into a later build.
- **Sentinel scheduled analytics rules (YAML)** — one `kind: Scheduled` rule per query in the shape
  Sentinel's content repository uses, ready for a content repo or a deployment pipeline. It has to
  default the fields the store does not carry — severity, query period, entity mappings — and it
  **reports every one of those defaults as a warning**, listed by rule name, so nobody ships an
  unmapped rule believing it was mapped.
- **ATT&CK Navigator layer** — technique coverage scored by how many queries cover each technique,
  with the contributing query names in each cell's comment.

What each is for, what it maps, and what it cannot do: [docs/exports.md](docs/exports.md).

## The KQL linter

`src/domain/lint.js` checks a query for the mistakes that cost a Sentinel or Defender analyst real
money and real detections — `contains` where `has` would do, no time bound, leading wildcards, an
unscoped `search`, a `join` with no `kind=`, `take` with nothing ordering the rows first. It is a
lexer and a set of shape checks, not a parser: it never tells you whether your query runs, and it
deliberately stays silent whenever the intent is ambiguous, because a linter that fires on correct
KQL gets switched off within a week.

The rules, their severities and what each deliberately does not fire on:
[docs/kql-linter.md](docs/kql-linter.md).

## Accessibility

The app is operable from the keyboard alone, dialogs carry real dialog semantics with a focus trap
and focus restoration, and axe-core reports zero violations across every shell component.

One behaviour is worth knowing before you meet it: **in the KQL editor, `Tab` inserts four spaces,
and `Escape` releases that capture instead of closing the dialog.** Press Escape once and Tab moves
to the next field; press it again and the dialog closes. Typing in the field again, or leaving and
returning to it, restores the indent. Without that release the field would be a keyboard trap.

Shortcuts, dialog behaviour and how it is tested: [docs/accessibility.md](docs/accessibility.md).

## Data model

SQLite on the PVC is the source of truth. `localStorage` (key `kql-store:data`) is a cache only:
it makes the first paint instant and keeps the UI readable if the API is briefly unavailable, but
every mutation goes to the API and the API's response is what wins on the next load. Clearing
site data loses nothing.

The schema is created and migrated by `api/db.js`:

```sql
CREATE TABLE IF NOT EXISTS queries (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  query       TEXT NOT NULL,
  description TEXT DEFAULT '',
  category    TEXT DEFAULT 'Utility',
  table_name  TEXT DEFAULT '',
  tags        TEXT DEFAULT '[]',            -- JSON array of strings
  favorite    INTEGER DEFAULT 0,            -- 0 | 1
  usage_count INTEGER NOT NULL DEFAULT 0,
  metadata    TEXT NOT NULL DEFAULT '{}',   -- JSON: the v4 detection block
  created     TEXT NOT NULL,                -- ISO 8601
  updated     TEXT NOT NULL                 -- ISO 8601
);
```

`usage_count` and `metadata` arrived after the table did, and `api/db.js` adds each with an
`ALTER TABLE` on startup if it is missing, so a database created by an older build is upgraded in
place.

The detection block is one JSON column rather than seventeen columns, on the same reasoning as
`tags`: it is optional, it is only ever read as a whole, and all filtering happens client-side once
the SPA has loaded the store. Over the wire it is flat — `toFrontend` spreads it back to the top
level, and the write path accepts it either way.

`category` is constrained by the API rather than the database, to one of Detection, Hunting,
Investigation, Monitoring, Reporting, Enrichment or Utility. Field bounds live in `api/validate.js`:
name 200 characters, query 50 000, description 1 000, table 200, up to 20 tags of 50 characters
each, a detection block of 20 000 characters serialised, 1 000 items per import and a maximum page
size of 1 000 on `GET /api/queries?limit=&offset=`. The API bounds the *size* of the detection block
and nothing else — the vocabularies above are enforced in the SPA, so a direct API caller can store
a technique ID the UI would have rejected. See [docs/api.md](docs/api.md) for the endpoints, the
import modes and the optional concurrency check on `PUT`.

### Backups

`k8s/api-backup-cronjob.yaml` runs a nightly online backup at 03:17 Europe/London, keeping 14
days on a separate `kqlstore-api-backup` claim. Each run takes a consistent snapshot through
SQLite's online backup API, takes the copy out of WAL mode so it is one self-contained file,
verifies it with `integrity_check` and a row count, and only then prunes anything older than the
retention window.

```bash
kubectl -n kqlstore get cronjob kqlstore-api-backup
kubectl -n kqlstore create job --from=cronjob/kqlstore-api-backup backup-now
kubectl -n kqlstore logs job/backup-now
```

**Those backups do not leave the node.** `local-path` is node-local storage and the CronJob is
pinned to the API's node, so both copies share one disk and one machine. It protects you against
a mistake, not against hardware.

`k8s/api-backup-offsite-cronjob.yaml` closes that gap: at 03:47 it takes whatever the local job
last wrote, refuses it if it is older than 26 hours, and pushes it to an S3-compatible endpoint —
then, with `OFFSITE_VERIFY_ROUNDTRIP` left on as it ships, reads the object back and proves the
copy restores to a working database before reporting success. It
ships pointed at the maintainer's storage and must be repointed at yours — see
[docs/maintenance/offsite-backup.md](docs/maintenance/offsite-backup.md).

To pull copies by hand as well, or instead, use the maintenance pod in `docs/maintenance/` — the
API pod does not mount the backup claim, and the CronJob's own pods exit too quickly to copy from:

```bash
kubectl apply -f docs/maintenance/backup-shell.yaml
kubectl -n kqlstore wait --for=condition=ready pod/kqlstore-maint --timeout=120s
kubectl -n kqlstore cp kqlstore-maint:/backup ./kqlstore-backups
kubectl -n kqlstore delete pod kqlstore-maint
```

For a portable, human-readable copy, use the export endpoint instead — every record carries its
detection metadata, and the app's own Import accepts the file. It runs from a frontend pod because
the NetworkPolicy admits nothing else to the API:

```bash
kubectl -n kqlstore exec deploy/kqlstore -- \
  curl -s http://kqlstore-api:3000/api/queries/export \
  > kqlstore-export-$(date -I).json
```

This is the backup to keep in version control: it survives schema changes and re-imports into an
empty instance. Note that the endpoint's envelope still says `schemaVersion: 3` while the records
inside it are v4; re-importing is safe, but do not read that number as the truth about the contents.

If you ever take a file-level copy by hand, do not simply copy `kqlstore.db`. The database runs in
WAL mode, so **copying that file on its own gives you an empty database** — the committed rows are
still in the `-wal` sidecar, and the failure is silent: you get a valid SQLite file with no
`queries` table in it. Use `VACUUM INTO`, which writes one consistent file while the API carries
on serving:

```bash
kubectl -n kqlstore exec deploy/kqlstore-api -- node -e "
  const Database = require('/app/node_modules/better-sqlite3');
  const db = new Database(process.env.DB_PATH || '/data/kqlstore.db', { readonly: true });
  db.prepare('VACUUM INTO ?').run('/data/manual-backup.db');
"
```

`/data` is the only writable path in that pod — the root filesystem is read-only — so the
temporary file has to live beside the database. Delete it afterwards.

### Restoring

Restoring the JSON export needs no downtime: use the app's Import button, or POST the file to
`/api/queries/import`. The default mode is `insert`, which is `INSERT OR IGNORE` keyed on `id` and
will not touch a query that already exists; `{"mode": "upsert", "queries": [...]}` overwrites a
stored row when the incoming one is newer. Either way the response accounts for every item —
`total`, `imported`, `inserted`, `updated`, `skippedOlder`, `skippedExisting`, a per-item
`results` array and `rejected`, in which each rejection carries its index and its reason rather
than being silently dropped.

Restoring a database file does need downtime, and the `-wal`/`-shm` sidecars must be deleted along
with the old database or SQLite replays them over your restored copy. The same maintenance pod
mounts both claims:

```bash
kubectl apply -f docs/maintenance/backup-shell.yaml
kubectl -n kqlstore wait --for=condition=ready pod/kqlstore-maint --timeout=120s
kubectl -n kqlstore exec kqlstore-maint -- ls /backup

kubectl -n kqlstore scale deploy/kqlstore-api --replicas=0
kubectl -n kqlstore wait --for=delete pod -l app=kqlstore-api --timeout=120s
kubectl -n kqlstore exec kqlstore-maint -- sh -c '
  rm -f /data/kqlstore.db /data/kqlstore.db-wal /data/kqlstore.db-shm &&
  cp /backup/kqlstore-YYYY-MM-DDTHH-MM-SSZ.db /data/kqlstore.db'
kubectl -n kqlstore scale deploy/kqlstore-api --replicas=1
kubectl -n kqlstore rollout status deploy/kqlstore-api

kubectl -n kqlstore delete pod kqlstore-maint
```

Scaling to zero first is not optional: two processes with the same SQLite file open, one of them
replacing it underneath the other, is how a store gets corrupted.

## Configuration

Every environment variable the API code reads. All are optional; the defaults are what the shipped
manifests run with.

| Variable | Default | Read by | Meaning |
| --- | --- | --- | --- |
| `DB_PATH` | `/data/kqlstore.db` | `api/db.js` | SQLite file path; the parent directory is created if missing. Must be on the PVC — anywhere else and the store is lost on restart, because the root filesystem is read-only. |
| `PORT` | `3000` | `api/server.js` | TCP port the API listens on. Changing it means changing the Service, the probes and nginx's `proxy_pass` upstream as well. |
| `CORS_ORIGIN` | *(unset)* | `api/app.js` | Comma-separated list of permitted origins. When unset the CORS middleware is not mounted at all, which is correct for the shipped topology where nginx makes the browser same-origin. Set it only for split-origin development. |
| `API_TOKEN` | *(unset)* | `api/app.js` | Optional shared-secret bearer token on `/api/queries`; `/api/health` stays exempt so kubelet probes work. **Deliberately unset** — Cloudflare Access is the authentication layer. Setting it without also making nginx inject the header locks the SPA out entirely, because the browser sends no `Authorization` header. See the comment in `k8s/api-deployment.yaml`. |
| `HEALTH_WRITE_TTL_MS` | `30000` | `api/routes/health.js` | How long a writability result is cached. The health check writes one row to prove the PVC is not full or read-only; this stops a 10-second probe interval from costing a WAL frame per probe. |

The backup CronJob reads three more: `DB_PATH`, `BACKUP_DIR` (`/backup`) and `RETENTION_DAYS`
(`14`). The API Deployment and that CronJob also set `NODE_OPTIONS=--max-old-space-size=96`, which
is not application configuration but a necessity — V8 does not derive its heap ceiling from the
cgroup limit, so without it the pod is OOMKilled instead of collecting. Raise it and the memory
limit together or neither. The frontend Deployment has no equivalent: it runs nginx, and no Node
process survives past its image build.

## Limitations

Stated plainly, so none of it is a surprise later.

- **KQL is never parsed.** The linter is a lexer and a set of shape checks; the highlighter colours
  tokens. Neither knows whether a query runs, whether a column exists, or whether the logic is
  right. A query that will not run in Sentinel saves perfectly happily.
- **The Sentinel export is a starting point, not a deployment.** It defaults the fields the store
  does not carry, sets `queryFrequency` equal to `queryPeriod`, alerts on any result, and emits no
  incident configuration, grouping or suppression. It is also one-way: nothing imports Sentinel YAML
  back in.
- **ATT&CK coverage means "a query claims this technique".** It is not evidence that the query
  fires, that the data source is onboarded, or that the rule is enabled anywhere.
- **No connection to Microsoft at all.** Nothing is fetched from a workspace and nothing is pushed
  to one. It is an offline catalogue; getting a query into production is still your pipeline's job.
- **No audit trail.** `author` is a self-declared metadata field, not attribution: the server
  records no history, and behind Access you know who *can* reach the app, not who changed what.
- **The API validates the size of the detection block, not its contents.** Vocabulary checking
  happens in the SPA, so a direct API caller can store metadata the UI would have refused.
- **Single writer.** One API replica on a ReadWriteOnce volume, and it must stay that way.
- **Backups are node-local by default.** The nightly CronJob protects you from mistakes, not from
  losing the node. Copying them off the box is left to you.

## Documentation

| | |
| --- | --- |
| [docs/schema.md](docs/schema.md) | Every field, its type, its bounds and its accepted values; how the record is stored; the migration chain |
| [docs/api.md](docs/api.md) | Endpoints, bounds, import modes, optimistic concurrency, error shapes |
| [docs/exports.md](docs/exports.md) | The three export formats, what they map and what they cannot do |
| [docs/kql-linter.md](docs/kql-linter.md) | Every lint rule, its severity, and what it deliberately ignores |
| [docs/accessibility.md](docs/accessibility.md) | Keyboard shortcuts, dialog behaviour, the editor's Tab capture, how it is tested |
| [docs/starter-pack.md](docs/starter-pack.md) | What is in the pack, how to load it, and why it is not a set of finished detections |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Running it locally, the test commands, commit convention, code style |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability, and the deployment's security posture |
| [CHANGELOG.md](CHANGELOG.md) | What changed and when |

## Licence

Licensed under the **GNU Affero General Public License v3.0 only** — see [LICENSE](LICENSE).

AGPL rather than GPL because this is network-served software, which is precisely what AGPL
section 13 was written for: run a modified version and let others use it over a network, and they
are entitled to your source. That obligation is the point. Self-hosting a tool that holds your
detection logic should not be a route to someone else taking it private.

The starter pack is separately licensed **CC0-1.0**, stated in the file and on every record in it,
so a query you take from it carries no obligation with it.
