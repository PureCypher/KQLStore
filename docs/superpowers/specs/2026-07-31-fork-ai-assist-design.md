# Query forking, AI-assisted authoring, and the schema store

Design for three related additions: forking a query with recorded lineage, an AI assistant that can
rewrite a fork and document it, and a schema store that gives the model the column-level knowledge
the app does not currently hold.

Written 2026-07-31. Nothing here is implemented yet.

## Why these three together

Forking is useful on its own — the store has no way to say "this Okta rule started life as the Entra
one" and no way to find the four things you derived from a rule you are about to change. The AI
assistant is what makes forking cheap rather than clerical. The schema store exists because the
assistant cannot write correct KQL against tables it has never seen, and because table knowledge
currently lives in [`src/constants.js`](../../../src/constants.js) as a build-time constant, so
changing it means rebuilding an image and rolling a Deployment.

They ship in that order and **the first two are useful with no AI at all**. That is deliberate: if
the assistant stalls — on egress, on model quality, or on your own judgement about sending detection
logic to a third party — the work done up to that point is not wasted.

## Decisions taken

Recorded here because the reasoning matters more than the conclusions, and because the obvious
alternative was reasonable in each case.

| Decision | Chosen | Rejected, and why |
| --- | --- | --- |
| Where the model runs | Ollama Cloud, `deepseek-v4-flash:cloud` | An in-cluster model preserves zero external egress entirely, at a cost in output quality and hardware. Revisit if the provider relationship sours. |
| How it is reached | A third Deployment, `kqlstore-ai` | Calling from the browser means relaxing CSP `connect-src`. Calling from the API pod means giving network access to the one pod holding the store. Both are worse than a new pod. |
| What leaves the cluster | Redacted by default, per-request preview, per-request override | Verbatim is better model input and was rejected as a silent default, not on principle — the override exists precisely because some queries are benign. |
| AI scope | Writes KQL *and* documents it, conversationally | A document-only assistant is lower risk but does not do the thing that makes forking cheap. |
| Conversation retention | A bounded provenance record | Full transcripts contain un-redacted query text, need retention policy on a 1Gi volume, and give three backup CronJobs a new data class to redact. |
| Schema store scope | Additive; existing table constants untouched | Making the store authoritative means [`tables.js:113`](../../../src/domain/tables.js) and [`lint.js:132`](../../../src/domain/lint.js) rebuild their regexes at runtime, and six modules need data loaded before render. Worth doing later, as its own spec. |
| Schema entry | Paste `getschema` output | An external extraction script becomes a thing maintained outside this repo with its own workspace credentials. Bundled schemas go stale and will not know your custom tables. |

## What the provider actually supports

Verified 2026-07-31 against [Ollama's structured outputs
documentation](https://docs.ollama.com/capabilities/structured-outputs) and the
[`deepseek-v4-flash` model page](https://ollama.com/library/deepseek-v4-flash). Both facts below
shape the design and neither should be assumed to hold indefinitely.

**Ollama Cloud does not support structured outputs.** The docs state it plainly: *"Ollama's Cloud
currently does not support structured outputs."* The `format` JSON-schema parameter — which would
make malformed metadata structurally impossible — is unavailable. This is a limitation of the hosted
service, not of the model.

The consequence is that **the validation gate is load-bearing rather than a safety net**. See
[Proposal review](#proposal-review). If Ollama Cloud gains structured-output support later, the gate
stays; it becomes redundant rather than wrong.

**Listed capabilities are `tools thinking cloud`.** Function calling is available, so structured
field proposals come back as tool calls rather than as JSON scraped out of prose. The model has
three reasoning modes (none, thinking, max thinking).

**Context window is 1M tokens.** Large enough that schema selection is an optimisation, not a
requirement — the whole schema store fits in a prompt with room to spare.
[`detectTableFromQuery`](../../../src/domain/tables.js) is still worth using to keep prompts focused
and cheap, but nothing breaks if it guesses wrong.

## Architecture

A third Deployment. No PVC, no database access, no mounts beyond its Secret. Its entire job is to
accept a request from nginx, redact, call Ollama Cloud, and return the response.

```
                 Cloudflare Access
                          │
                          ▼
  ┌────────────────────────────────────────────┐
  │ Deployment: kqlstore          (2 replicas) │
  │   nginx :8080                              │
  │     /          → static bundle             │
  │     /api/      → proxy_pass ───────────┐   │
  │     /api/ai/   → proxy_pass ───────┐   │   │
  └────────────────────────────────────┼───┼───┘
                                       │   │
              ┌────────────────────────┘   └──────────┐
              ▼                                       ▼
  ┌────────────────────────────┐    ┌────────────────────────────────┐
  │ Deployment: kqlstore-ai    │    │ Deployment: kqlstore-api       │
  │   Express :3001            │    │   Express :3000                │
  │   no volumes, no state     │    │   better-sqlite3 → PVC         │
  │   egress: ollama.com:443   │    │   egress: []      (UNCHANGED)  │
  └─────────────┬──────────────┘    └────────────────────────────────┘
                ▼
       Ollama Cloud — deepseek-v4-flash:cloud
```

Three properties this preserves, each of which the simpler alternatives break:

- [`k8s/api-networkpolicy.yaml:29`](../../../k8s/api-networkpolicy.yaml) stays `egress: []`. The pod
  holding the SQLite store still cannot reach the network, so its comment — *"a compromised
  dependency cannot exfiltrate the query store"* — remains true.
- [`nginx.conf:108`](../../../nginx.conf) keeps `connect-src 'self'`. The browser talks only to its
  own origin.
- The AI pod never sees the database. It receives query text in a request body and returns text. A
  compromise of it yields what is in flight, not the library.

The Ollama API key lives in a Secret mounted only into `kqlstore-ai`, following the pattern in
[`docs/maintenance/github-backup-secret.example.yaml`](../../maintenance/github-backup-secret.example.yaml).

The pod needs **no new npm dependency**. Node 24 has `fetch` built in and Ollama's API is plain
HTTP, so it is Express and nothing else — consistent with the reasoning in the GitHub backup
CronJob about not adding a second image to the supply chain.

### Two costs, stated plainly

**Egress to `ollama.com` cannot be pinned to a CIDR.** Provider addresses move, so the NetworkPolicy
will read as "443 to anywhere outside RFC1918". That is meaningfully weaker than `egress: []`, and it
is the actual price of this feature. Confining it to a pod with no data access is what makes the
price acceptable.

**The nginx → `kqlstore-ai` ingress rule needs a `from: podSelector`, and that construct is
unreliable on this cluster.** Cross-node SNAT erases pod identity, so such rules permit or deny
depending on where the scheduler places pods. The existing `kqlstore → kqlstore-api` rule has the
same shape and works, which establishes that current placement is favourable — not that the pattern
is sound. Plan a namespace-selector fallback, and verify the deny path deliberately with forced
scheduling during build step 3, before any UI depends on it.

### Streaming

The `/api/ai/` location needs `proxy_buffering off`. Without it nginx buffers the whole response and
streaming degrades silently to a long blank pause, which with a reasoning model is easily 30 seconds
of dead interface.

Conversational text streams. Structured field proposals arrive as a block at the end. Splitting them
avoids trying to render a half-parsed tool call.

## Data model

Three additions, all following the additive `pragma_table_info` guard already used twice in
[`api/db.js`](../../../api/db.js) for `usage_count` and `metadata`.

### Lineage

```sql
ALTER TABLE queries ADD COLUMN parent_id   TEXT DEFAULT NULL;
ALTER TABLE queries ADD COLUMN parent_name TEXT DEFAULT '';
```

**No foreign key, despite `foreign_keys = ON`.** A FK forces a choice between blocking a parent's
deletion and cascading it, and both are wrong: deleting the Entra query you forked from should
neither delete the Okta fork nor prevent the deletion. Orphanhood is a display state, not an
integrity violation. SQLite also restricts `REFERENCES` in `ADD COLUMN`, so this is the pragmatic
path as well as the correct one.

**Not in the `metadata` blob**, even though schema v4 established that pattern for optional fields.
`toFrontend` in [`api/routes/queries.js`](../../../api/routes/queries.js) spreads that blob to the
top level and it feeds the Sentinel YAML export, where lineage would appear in exported analytics
rules and mean nothing. Keeping the blob meaning strictly "v4 detection metadata" is worth a column.

**`parent_name` is a snapshot, not a cache.** It records the parent's name at fork time, so an
orphaned fork still reads *"forked from 'Entra risky sign-in'"* rather than *"forked from a query
that no longer exists"*. It is a historical fact; going stale is correct behaviour, not a bug.

Forking copies every field, then sets a new `id`, fresh `created`/`updated`, `usage_count` reset to
0, `favorite` cleared, and `parent_id`/`parent_name` populated. Lineage is one generation deep in
storage — ancestry is walked client-side from the store the SPA already holds, so depth is free.

### AI provenance

```sql
ALTER TABLE queries ADD COLUMN ai_provenance TEXT NOT NULL DEFAULT '[]';
```

Parsed like `metadata` but **not spread to the top level** — returned as a nested `aiProvenance`, so
it stays out of the exports and out of the detection validators.

```json
[{
  "model": "deepseek-v4-flash:cloud",
  "generatedAt": "2026-07-31T14:02:11Z",
  "redaction": "applied",
  "instruction": "make this detect Okta instead of Entra",
  "fields": ["query", "name", "description", "tags"]
}]
```

| Field | Bounds |
| --- | --- |
| `model` | ≤ 100 characters. |
| `generatedAt` | ISO 8601, same rules as `created`. |
| `redaction` | `applied` or `overridden`. |
| `instruction` | ≤ 1 000 characters, truncated not rejected. |
| `fields` | Names of query fields the model authored **and you accepted**. |

`fields` is the part that earns its keep. The audit question a detection library gets asked is not
"was AI involved" but **"did a model write this detection logic, or only the description?"** — and
that list answers it precisely.

**It records what was accepted, not what was proposed.** If the model rewrote the KQL and you
rejected it, `fields` must not claim a model authored your detection logic. Anything else makes the
trail actively misleading, which is worse than having none.

Append-only, capped at the 10 most recent entries with the oldest dropped. Last-wins would lose the
fact that the KQL was AI-authored three edits ago, which is exactly the fact worth keeping.

### Schema store

A new table, entirely independent of `queries`:

```sql
CREATE TABLE IF NOT EXISTS table_schemas (
  name    TEXT PRIMARY KEY,
  columns TEXT NOT NULL DEFAULT '[]',
  notes   TEXT DEFAULT '',
  source  TEXT DEFAULT 'getschema',
  updated TEXT NOT NULL
);
```

| Field | Bounds |
| --- | --- |
| `name` | 1–200 characters. Free text, not an enum — it must hold custom and ASIM tables. |
| `columns` | JSON array of `{ name, type }`, at most 500 entries, each name ≤ 200 characters. |
| `notes` | ≤ 5 000 characters. |
| `source` | `getschema`, `manual`, or `import`. |
| `updated` | ISO 8601. |

`notes` matters more than it looks. A `getschema` paste gives column names and types; it cannot say
*"`AdditionalFields` is only populated when the DCR is v2"* or *"this custom table has 30-day
retention, do not write 90-day lookbacks"*. That knowledge is the difference between plausible KQL
and correct KQL, and there is nowhere else in the system to put it.

Routes are `GET /api/schemas`, `GET /api/schemas/:name`, `PUT /api/schemas/:name`, and
`DELETE /api/schemas/:name`, following the shape and error handling of
[`api/routes/queries.js`](../../../api/routes/queries.js). JSON export and import reuse the existing
[`ImportPreviewModal`](../../../src/components/ImportPreviewModal.jsx) pipeline.

### The validation tax

Every field above needs a validator in **both** [`src/domain/validate.js`](../../../src/domain/validate.js)
and [`api/validate.js`](../../../api/validate.js), each with tests. That duplication is pre-existing
and this design does not attempt to fix it, but it roughly doubles validation work across three new
field groups and is the largest hidden cost here. Anyone estimating this work should account for it
explicitly rather than discovering it.

## Fork and chat flow

### The central idea

**There is one draft object. The form and the chat are two views of it.**

This is what makes closing the chat and continuing by hand fall out for free rather than becoming a
state-synchronisation problem. The chat never owns the query; it proposes changes to a draft the
form is already editing. Closing the panel removes a view, not a source of truth.

### Steps

1. **Fork** — an action on [`QueryCard`](../../../src/components/QueryCard.jsx). Builds a draft in
   memory with `parent_id`/`parent_name` set and opens the editor. **Nothing is written to the
   database.** An abandoned fork leaves no trace; the row appears on save like any other new query.
2. **Assist** — a toggle opens the chat panel beside the form, in the same modal.
3. **Send** — the redaction preview shows exactly what will leave the cluster, with the override.
   Shown on **every** send, not only the first: a conversation that started benign can drift into
   pasting a watchlist name three turns later.
4. **Respond** — conversational text streams; structured proposals arrive as a block at the end.
5. **Review** — proposals land as a layer *over* the form, each changed field showing old → new with
   accept/reject. Nothing is auto-applied, including the KQL.
6. **Close** — the panel collapses; the form holds what was accepted. Ordinary editing from here.
7. **Save** — existing validators run as they do today, and provenance is appended.

### Redaction

**The scanner is not currently a module.** It is inlined in
[`k8s/api-backup-github-cronjob.yaml`](../../../k8s/api-backup-github-cronjob.yaml) inside the
job's `node -e` script, so it exists nowhere that another caller can import and has never been
unit-tested. Reuse therefore begins with extracting it to `api/lib/redact.js` without changing the
backup job's behaviour — the job's committed output must stay byte-identical, or every backed-up
query looks modified on the next run.

Its existing allowlist behaviour carries over: the four AD extended-rights schema GUIDs documented
in [`k8s/api-backup-github-config.yaml`](../../../k8s/api-backup-github-config.yaml) must **not** be
redacted, since doing so breaks the query while protecting nothing.

**The two rule classes map onto two different behaviours**, and the distinction is the useful part
of reusing this code rather than writing something new:

| Class | Backup job | AI service |
| --- | --- | --- |
| `SECRET` — a credential | Fails, publishes nothing | **Refuses the request.** No placeholder, no override. There is no correct version of "send the credential anyway", and the operator's next move is to remove it from the query. |
| `DISCLOSURE` — operational detail | Replaced with a marker | Replaced with a marker; the request proceeds |

**Markers are typed placeholders, not HMAC fingerprints.** The backup job needs
`REDACTED-<8 hex>` because stability across runs is what keeps an unchanged query from producing a
changed commit. The AI service needs the opposite property: `<EMAIL_1>` and `<WATCHLIST_NAME_2>`
tell the model what kind of thing was removed, so it keeps the value in a string comparison instead
of mangling it, and they survive being moved around when the model rewrites the surrounding KQL.
The marker scheme is therefore injected by the caller rather than owned by the module.

One marker namespace is shared across `name`, `description` and `query` in a single request: a
watchlist name appearing in two fields must become the same placeholder in both, or the model
treats them as two different things and writes a query that does too.

Marker → original mapping is held client-side for the conversation and never sent. Un-redaction on
the return path is a substitution over the model's response, which must survive the model having
rewritten the KQL around the marker.

The existence of this control is not incidental. The backup job already refuses to send query text
verbatim to a *private repository you own*, on the grounds that a scan of the maintainer's 48
queries found the full inventory of Sentinel watchlist names including honeytoken and RC4-exception
lists. Sending that same text to a third-party inference provider, repeatedly, across a multi-turn
conversation, is a strictly larger exposure. Redaction by default keeps the two controls consistent.

### Proposal review

**The validator runs before the review layer, not after.** Because Ollama Cloud cannot constrain
output, the model will return `T1078.9` and severities outside `SEVERITIES`. Every proposal goes
through `validateDetectionMetadata` first; invalid ones are shown **rejected by default with the
reason visible** — *"T1078.9 is not a valid technique ID"*.

Never silently dropped, never silently accepted. The absence of structured outputs becomes a visible
failure mode rather than a hidden one.

### Lineage in the interface

A badge on `QueryCard` reading *"fork of Entra risky sign-in"* or *"3 forks"*, both navigable. A
sidebar filter for forks and parents alongside the existing category, table and tag filters. Orphans
render as *"forked from 'Entra risky sign-in' (deleted)"* using the snapshot name.

### Statelessness

Because retention is provenance-only, conversation history lives in React state and is replayed with
each turn. The AI pod holds nothing between requests — no session store, no cache, nothing to back
up and nothing to leak. The storage decision and the isolation decision reinforce each other.

### Component structure

[`QueryEditorModal.jsx`](../../../src/components/QueryEditorModal.jsx) is 231 lines. A chat panel,
redaction preview and proposal review layer would take it well past anything reasonable, so they
land as their own components — approximately `AIChatPanel`, `ProposalReview` and `RedactionPreview`
— with the modal wiring them to the shared draft. This follows `DetectionMetadataFields` being split
out at 340 lines rather than inlined.

## Testing

Existing patterns cover most of it. [`src/storage/__tests__/fetchStub.js`](../../../src/storage/__tests__/fetchStub.js)
already stubs `fetch` and is directly reusable for the AI endpoint;
[`api/test/schema-version.test.js`](../../../api/test/schema-version.test.js) is the precedent for
testing an additive migration. The 80% coverage floor applies as everywhere else.

Targets, ordered by how likely they are to be wrong:

**The `getschema` parser.** The only real parser in this work, and it consumes untrusted human
paste. Table-driven over the portal's rendered grid, tab-separated output, CSV, truncated paste, and
input that is not schema output at all. It must fail loudly rather than produce three plausible
columns.

**The redaction gate.** A watchlist name is redacted; the four allowlisted AD GUIDs are not; the
un-redaction round-trip survives the model rewriting surrounding KQL.

**The proposal validation gate.** Known-bad model output — invalid technique IDs, out-of-vocabulary
severities, a malformed `attack` object — each arriving rejected-by-default with its reason
attached. This test protects the entire no-structured-outputs compromise.

**Lineage helpers.** Ancestry walk, orphan detection, and cycle safety. A parent chain can loop via
import, and an unguarded walk hangs the interface.

**The AI proxy route.** Ollama stubbed; redaction runs before egress; the API key never appears in a
response; an override is recorded in provenance.

**Focus management.** [`dialog.test.js`](../../../src/components/__tests__/dialog.test.js) is 506
lines, so this is already taken seriously. A chat panel inside the existing modal changes tab order
and adds a second focusable region inside an established focus trap.

### What the suite cannot reach

Stated plainly, because it is the risky half:

- **The NetworkPolicy deny path.** Cross-node SNAT behaviour only manifests with pods on different
  nodes. Needs deliberate verification with forced scheduling.
- **Streaming through nginx.** `proxy_buffering off` either works against the real proxy or it does
  not.
- **Model output quality.** Whether `deepseek-v4-flash` writes decent KQL against these schemas is
  empirical and untestable here.

The parts most likely to hurt are precisely the parts the suite cannot see. That is the argument for
the build order below.

## Build order

**1 — Fork and lineage, no AI.** Data model, both validators, `QueryCard` badge, sidebar filter, the
export decision. Ships alone, useful alone, and proves the additive migration against the real
database.

**2 — Schema store and tab.** Parser, `/api/schemas`, new view. Also useful with no AI: an editable,
searchable schema reference beats a browser tab open on Microsoft's documentation. This step
introduces the first top-level view switch — [`App.jsx`](../../../src/App.jsx) is 615 lines with no
router and a single view, so "a tab" is a genuine if small structural change.

**3 — The `kqlstore-ai` pod, with no interface at all.** Deployment, NetworkPolicy, Secret, nginx
location, health endpoint. Verify egress reaches Ollama and probe the podSelector hazard here, while
nothing depends on it. Ship it doing something trivial.

**4 — Redaction on the outbound path.** Scanner plus preview API, tested before it is user-facing.

**5 — Chat and proposal review.** The large interface step, landing on proven infrastructure.

**6 — Provenance.** Last, once real use has shown which fields actually get accepted.

### Delivery

Steps 1–2 and steps 3–6 are delivered as two separate implementation plans, because the split is
also where the risk profile changes: everything up to step 2 is application work with no
infrastructure change and no external dependency, and everything after it needs cluster changes, a
Secret, and a network path that cannot be fully tested from a unit suite.

- [`plans/2026-07-31-fork-lineage-and-schema-store.md`](../plans/2026-07-31-fork-lineage-and-schema-store.md) — steps 1–2, 12 tasks
- [`plans/2026-07-31-ai-assisted-authoring.md`](../plans/2026-07-31-ai-assisted-authoring.md) — steps 3–6, 10 tasks

The second plan depends on the first and states so; do not begin its Task 5 without the schema
store in place.

## Out of scope

Named explicitly so they are not assumed:

- **Migrating the six modules that consume `SENTINEL_TABLES`/`DEFENDER_TABLES` onto the schema
  store.** A separate project with its own spec.
- **Deduplicating validation** between the SPA and the API.
- **Multi-user attribution.** Authentication happens at Cloudflare Access and the API has no user
  concept; provenance records what a model did, not who asked it.
- **Syncing a fork with its parent.** Lineage records ancestry. There is no diff-against-parent and
  no merge.
- **Automated schema extraction** from a Log Analytics workspace.

## Risks

| Risk | Handling |
| --- | --- |
| NetworkPolicy `from: podSelector` denies by node placement | Verified at build step 3 with forced scheduling; namespace-selector fallback ready. |
| Ollama Cloud changes or withdraws capabilities | Capabilities verified 2026-07-31 and recorded above. The validation gate holds regardless. |
| Model writes plausible but wrong KQL | Human review of every proposal; nothing auto-applied. Detection logic is never saved unreviewed. |
| Redaction degrades output quality below usefulness | Per-request override exists. If it is used every time, that is evidence the feature needs rethinking, not that the override is working. |
| Un-redaction fails when the model rewrites surrounding KQL | Explicit test target. Typed markers rather than opaque fingerprints make this substantially less likely. Failure is visible in review, not silent. |
| Extracting the scanner changes the backup job's output | The job's HMAC marker scheme stays with the job; only the rule tables move. Verified by comparing committed output before and after. |
| Provenance overstates AI involvement | Records accepted fields only, not proposed. |
| 1Gi PVC growth | Schema store is small and bounded; provenance is capped at 10 entries per query; no transcripts are stored. |
