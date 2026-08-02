# API reference

Express, mounted at `/api`, backed by one SQLite file on a PersistentVolumeClaim. Routes are in
[`api/routes/`](../api/routes/) and every bound below is enforced by
[`api/validate.js`](../api/validate.js).

**There is no authentication.** Cloudflare Access authenticates at the edge and the API trusts
whatever reaches it — see [SECURITY.md](../SECURITY.md#authentication-happens-at-the-edge-and-only-at-the-edge)
for the obligation that creates. The examples below assume the local Docker stack from the
[README](../README.md#quickstart-with-docker), where nginx proxies `/api/` on port 8080.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness, and whether the database is writable |
| `GET` | `/api/health/ready` | The same check, but 503 when the database is not writable |
| `GET` | `/api/queries` | List every query, newest first; optional paging |
| `GET` | `/api/queries/:id` | One query |
| `POST` | `/api/queries` | Create |
| `PUT` | `/api/queries/:id` | Update, with optional optimistic concurrency |
| `DELETE` | `/api/queries/:id` | Delete |
| `POST` | `/api/queries/import` | Bulk load, `insert` or `upsert` |
| `GET` | `/api/queries/export` | Every query in one envelope |
| `GET` | `/api/schemas` | List every stored table schema |
| `GET` | `/api/schemas/:name` | One table schema |
| `PUT` | `/api/schemas/:name` | Create or overwrite, keyed on the path name |
| `DELETE` | `/api/schemas/:name` | Delete |
| `GET` | `/api/ai/health` | Whether the AI service is up and configured |
| `POST` | `/api/ai/redact` | Preview what would leave the cluster for a query |
| `POST` | `/api/ai/chat` | Stream a conversation with the model (NDJSON) |

Records are the flat shape described in [docs/schema.md](schema.md#how-it-is-stored): the v4
detection block is stored in one JSON column and spread to the top level on the way out.

## Health

```console
$ curl -s http://localhost:8080/api/health
{"status":"ok","writable":true,"timestamp":"2026-07-26T13:02:46.337Z"}
```

`writable` is a real write against the database, not a guess — the pod used to report Ready while
every write returned 500. The result is cached for `HEALTH_WRITE_TTL_MS` (30 s by default) so a
10-second probe interval does not cost a WAL frame per probe. The endpoint deliberately discloses
nothing else; it used to return the query count, which handed anyone who could reach the port the
size of the estate's detection library.

`/api/health` never fails on a read-only database — restarting the pod cannot remount a PVC, so a
non-200 there would only turn a degraded-but-serving API into a crash loop, and the `writable` flag
carries the bad news instead. `/api/health/ready` returns 503 in that state, so pointing a
readinessProbe at it takes the pod out of the Service rather than letting it accept saves that will
500. The liveness probe must stay on `/api/health`.

Both are exempt from the optional `API_TOKEN` check, because kubelet cannot be given a credential.

## Listing and paging

`GET /api/queries` returns the whole table ordered by `updated DESC, id ASC`, which is what the SPA
depends on — it holds the store in memory and filters client-side.

```console
$ curl -s 'http://localhost:8080/api/queries?limit=3&offset=10'      # three rows, from the 11th
$ curl -s 'http://localhost:8080/api/queries?limit=5000'
{"error":"\"limit\" must be between 1 and 1000"}
```

`limit` and `offset` are independent and both optional; an offset with no limit is honoured. `id`
is the tiebreaker in the sort so that paging over rows sharing an `updated` value cannot show one
row twice and skip another.

## Creating and updating

`POST /api/queries` requires `name` and `query`. Everything else is optional and defaulted.
Bounds, all from `api/validate.js`:

| Field | Bound |
| --- | --- |
| `name` | 200 characters, required, non-empty |
| `query` | 50 000 characters, required, non-empty |
| `description` | 1 000 characters |
| `table` (or `table_name`) | 200 characters |
| `category` | one of Detection, Hunting, Investigation, Monitoring, Reporting, Enrichment, Utility |
| `tags` | 20 entries, 50 characters each |
| `favorite` | boolean |
| `usageCount` | non-negative integer |
| detection block | 20 000 characters when serialised |
| `id` | 200 characters |
| `created` / `updated` | 64 characters |
| import batch | 1 000 items |
| `?limit=` | 1 000 |

A rejected payload comes back as HTTP 400 naming the field:

```console
$ curl -s -X POST http://localhost:8080/api/queries -H 'Content-Type: application/json' \
    -d '{"name":"x","query":"y","category":"Nope"}'
{"error":"\"category\" must be one of: Detection, Hunting, Investigation, Monitoring, Reporting, Enrichment, Utility"}
```

`PUT` is partial: every field is optional and anything absent coalesces against the stored row.

### Optimistic concurrency on PUT

Opt-in. Send the `updated` value your edit was based on, either as `expectedUpdated` in the body or
as the `X-Expected-Updated` header, and the write is refused if the row has moved on since you read
it. Two people editing the same query in two browsers otherwise clobber each other silently, last
save winning by accident of arrival. Callers that omit it — **including the SPA today** — are
unaffected and keep last-write-wins.

```console
$ curl -s -X PUT http://localhost:8080/api/queries/$ID -H 'Content-Type: application/json' \
    -d '{"name":"renamed once","expectedUpdated":"2026-07-26T00:00:00.000Z"}' -o /dev/null -w '%{http_code}\n'
200

$ curl -s -X PUT http://localhost:8080/api/queries/$ID -H 'Content-Type: application/json' \
    -d '{"name":"renamed twice","expectedUpdated":"2026-07-26T00:00:00.000Z"}'
{
  "error": "Query was modified by another client",
  "expectedUpdated": "2026-07-26T00:00:00.000Z",
  "currentUpdated": "2026-07-26T13:03:14.231Z",
  "current": { …the whole current row… }
}      # HTTP 409
```

The 409 hands back the current row so the caller can diff or re-base without a second round trip.
The comparison is **exact string equality, not a timestamp comparison**: any movement at all
invalidates the edit. That is the ETag semantic, and it avoids arguing about clocks and precision.
An empty or non-string precondition is a 400, not a silent no-op.

## Import

`POST /api/queries/import` takes `{"queries": [...]}` and an optional `mode`. A file exported by
the app, or [`content/starter-pack.json`](../content/starter-pack.json), can be posted as-is: the
extra `schemaVersion` and `meta` keys are ignored and `queries` is read out of it.

| Mode | Behaviour |
| --- | --- |
| `insert` *(default)* | An `id` that already exists is left alone. `INSERT OR IGNORE` semantics, reported per item as `skipped-existing`. |
| `upsert` | Overwrites a stored row **only when the incoming row's `updated` is strictly newer**. Otherwise the item is reported as `skipped-older`. |

An unknown mode is rejected rather than defaulted, because a typo in a sync client would otherwise
fall back silently to the mode that discards updates:

```console
$ curl -s -X POST http://localhost:8080/api/queries/import -H 'Content-Type: application/json' \
    -d '{"mode":"replace","queries":[]}'
{"error":"\"mode\" must be one of: insert, upsert"}
```

`upsert` exists because the SPA syncs offline work through this endpoint. Under insert semantics an
offline *edit* to a query that already existed on the server was silently dropped on reconnect: the
user's change vanished behind a success response. Arrival order decides nothing — the timestamps do,
compared as instants rather than lexically so that an exported file carrying a `+01:00` offset is
not mistaken for older than the same moment written as `Z`. A timestamp that cannot be parsed never
wins; refusing to overwrite is the recoverable outcome.

Two fields are treated as facts about the row rather than about the edit, and survive an upsert:
`created` keeps the stored value, and `usage_count` takes the larger of the two so increments made
on whichever side was offline are not reset.

Every item is accounted for in the response — nothing is silently dropped:

```console
$ curl -s -X POST http://localhost:8080/api/queries/import -H 'Content-Type: application/json' \
    --data-binary @content/starter-pack.json
{ "mode": "insert", "total": 15, "imported": 15, "inserted": 15, "updated": 0,
  "skippedOlder": 0, "skippedExisting": 0, "results": [ … ], "rejected": [] }

# the same file again
{ "mode": "insert", "inserted": 0, "updated": 0, "skippedExisting": 15 }

# and with {"mode":"upsert"} but unchanged timestamps
{ "mode": "upsert", "inserted": 0, "updated": 0, "skippedOlder": 15 }
```

`imported` is retained under its original name and meaning — rows written, so `inserted + updated` —
so callers that read it keep working. `results` carries one `{index, id, outcome}` per accepted
item; `rejected` carries `{index, reason}` for each item that failed validation, so a malformed
entry names itself instead of disappearing. The whole batch runs in one transaction.

## Export

`GET /api/queries/export` returns every row in an envelope. It is the portable backup — see the
README's [backup section](../README.md#backups) for pulling it out of a cluster. Note that the
envelope still declares `schemaVersion: 3` while the records inside carry v4 metadata; see
[docs/exports.md](exports.md#json-native).

## Table schemas

`table_schemas` is a second, independent SQLite table — nothing joins it to `queries`. It exists so
a schema pasted from `TableName | getschema` has somewhere to live and be searched; it does not
feed the linter, the table picker or any badge. See [docs/schemas.md](schemas.md) for what the
store is for and how to fill it in; this section is the endpoint reference.

```console
$ curl -s http://localhost:8080/api/schemas
[{"name":"SigninLogs","columns":[{"name":"TimeGenerated","type":"datetime"},…],
  "notes":"UserPrincipalName is null for service principal sign-ins.",
  "source":"getschema","updated":"2026-07-26T13:02:46.337Z"}]

$ curl -s http://localhost:8080/api/schemas/SigninLogs
{"name":"SigninLogs","columns":[…],"notes":"…","source":"getschema","updated":"…"}

$ curl -s http://localhost:8080/api/schemas/NoSuchTable
{"error":"Schema not found"}      # HTTP 404
```

`GET /api/schemas` returns every row, ordered by name. `GET /api/schemas/:name` returns one, or 404.

### `PUT /api/schemas/:name` — upsert, keyed on the path

```console
$ curl -s -X PUT http://localhost:8080/api/schemas/SigninLogs -H 'Content-Type: application/json' \
    -d '{"columns":[{"name":"TimeGenerated","type":"datetime"},{"name":"UserPrincipalName","type":"string"}],
         "notes":"90-day retention on this workspace.","source":"getschema"}'
{"name":"SigninLogs","columns":[…],"notes":"90-day retention on this workspace.",
 "source":"getschema","updated":"2026-08-02T09:14:03.112Z"}
```

The row's identity is the **path** segment, not any `name` in the body — a `name` in the body is
read, then thrown away, because the request is normalised to `{ ...body, name: <path name> }`
before validation runs. Two sources of truth for the same key is how you end up with a row nobody
can address by either name. The path name is also trimmed the same way on `GET`, `PUT` and
`DELETE`, so `PUT /api/schemas/%20SigninLogs%20` and `GET /api/schemas/SigninLogs` resolve to the
same row rather than one being unreachable.

There is no separate create vs. update route: a name that does not exist yet is inserted, one that
does is overwritten in full — `columns` and `notes` both replace what was stored, they do not merge
with it. Renaming a table's schema is not supported; there is only upsert-by-name, so moving a
schema to a new name means creating it under the new name and deleting the old one yourself.

Bounds, from `LIMITS` in [`api/validate.js`](../api/validate.js):

| Field | Bound |
| --- | --- |
| `name` (path segment) | 200 characters, required, non-empty after trimming |
| `columns` | 500 entries |
| `columns[].name` | 200 characters, required — a column with no name is rejected outright |
| `columns[].type` | Free text. **Missing or blank defaults to `unknown`** rather than being rejected: `getschema` output pasted from a clipped copy sometimes loses the type column, and a column list without types is still far more useful than no schema at all |
| `notes` | 5 000 characters |
| `source` | one of `getschema`, `manual`, `import` — defaults to `getschema` |

```console
$ curl -s -X PUT http://localhost:8080/api/schemas/SigninLogs -H 'Content-Type: application/json' \
    -d '{"columns":[{"type":"string"}]}'
{"error":"every column needs a \"name\""}      # HTTP 400
```

### `DELETE /api/schemas/:name`

```console
$ curl -s -X DELETE http://localhost:8080/api/schemas/SigninLogs
{"deleted":"SigninLogs"}

$ curl -s -X DELETE http://localhost:8080/api/schemas/SigninLogs
{"error":"Schema not found"}      # HTTP 404, already gone
```

Deleting a table's schema has no effect on any query — nothing references it. It only removes the
reference row itself; a query whose `table` field names the now-schema-less table still validates,
saves and exports exactly as before.

## AI assistant

The three `/api/ai/` routes are served by a **separate service**, `kqlstore-ai`, proxied by nginx
at `/api/ai/` — they are not routes of the API pod, which keeps its `egress: []` and never touches
the network. The AI service holds no database, no volume and no session state; the SPA replays
conversation history each turn. See [docs/ai-assist.md](ai-assist.md) for the data-flow and its
trade-offs, and [docs/maintenance/ai-service.md](maintenance/ai-service.md) for operations.

### `GET /api/ai/health`

```console
$ curl -s http://localhost:8080/api/ai/health
{"status":"ok","model":"deepseek-v4-flash:cloud","configured":false}
```

`configured` reports whether an API key is present — never what it is, so a probe cannot leak the
credential. `model` is the configured model (or the default). The SPA probes this once on mount and
hides the assist toggle when the service is unreachable, so scaling the service to zero degrades to
manual editing rather than erroring.

### `POST /api/ai/redact`

Body: `{ "fields": { "name": …, "description": …, "query": … } }`. Answers what a send would do
before anything leaves the cluster.

```console
$ curl -s http://localhost:8080/api/ai/redact \
  -H 'Content-Type: application/json' \
  -d '{"fields":{"query":"DeviceIP == \"10.1.2.3\""}}'
{"redacted":{"query":"DeviceIP == \"<PRIVATE_IPV4_1>\""},"applied":[{"rule":"Private IPv4","value":"10.1.2.3","marker":"<PRIVATE_IPV4_1>"}],"blocked":false}
```

`applied` is the marker mapping, returned so the client holds it; it never goes upstream. A request
carrying a credential is **refused** with `422` — the response names the rule that fired, never the
matched value:

```console
$ curl -s http://localhost:8080/api/ai/redact -H 'Content-Type: application/json' \
  -d '{"fields":{"query":"let k = \"AKIAIOSFODNN7EXAMPLE\";"}}'
{"blocked":true,"secrets":[{"rule":"AWS access key id","field":"query"}],"error":"This query appears to contain a credential. Remove it before using AI assistance."}
```

### `POST /api/ai/chat`

Body:

```json
{
  "messages": [{ "role": "user", "content": "make this detect Okta" }],
  "schemas": [{ "name": "OktaLogs", "columns": [{ "name": "eventType", "type": "string" }], "notes": "" }],
  "draft": { "name": "Entra risky sign-in", "description": "…", "query": "…" },
  "allowVerbatim": false
}
```

The draft is redacted before it reaches the model (unless `allowVerbatim`), and the model's
proposal is un-redacted before it comes back. A credential anywhere is refused with `422` even
under the override. The response is NDJSON — text chunks first, then either a `proposal` or an
`error` line:

```text
{"type":"text","value":"Here is a rewrite that keys on the Okta eventType…"}
{"type":"proposal","fields":{"name":"Okta risky sign-in","attack":{"tactics":["initial-access"]}}}
```

An upstream failure is always `{"type":"error","value":"The model service failed."}` — the service
never relays an Ollama error body, because Ollama can echo the request in one, and the request
contains query text.

## Errors

Every route funnels through [`api/middleware/errorHandler.js`](../api/middleware/errorHandler.js).
Deliberate 4xx keep their specific message; 5xx are generic, because the raw ones leaked SQLite
schema detail such as `UNIQUE constraint failed: queries.id`.

## Configuration

Environment variables are documented in the README's
[Configuration section](../README.md#configuration).
