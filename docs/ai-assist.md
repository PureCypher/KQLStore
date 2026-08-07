# AI-assisted authoring

An analyst forks a detection query, then rewrites and documents it in conversation with a model on
Ollama Cloud, with the stored table schemas as ground truth for what columns exist. The model's
proposals are never applied directly — every field is validated and reviewed before it reaches the
draft, and a save records exactly which fields the operator accepted.

This is a feature you can switch off completely and lose nothing: `kubectl -n kqlstore scale
deploy/kqlstore-ai --replicas=0` hides the assist toggle and leaves forking, schema editing and
manual authoring fully working.

## The shape of the system

```
            browser
               │  /api/ai/*  (same origin, connect-src 'self')
               ▼
           nginx
               │
               ▼
     Deployment: kqlstore-ai   (stateless, no PVC, no database)
               │  redacted query text, HTTPS 443
               ▼
     Ollama Cloud — deepseek-v4-flash:cloud
```

Three properties do the work, and each is a deliberate trade:

- **The pod that holds the query store (`kqlstore-api`) has no egress at all.** The AI service is a
  separate pod so the data pod's `egress: []` stays intact.
- **The browser never talks to a third party.** nginx keeps `connect-src 'self'` in its CSP; every
  `/api/ai/` call goes to the app's own origin and nginx proxies it.
- **The AI pod holds nothing.** No database, no volume, no session state. Conversation history
  lives in the SPA's React state and is replayed each turn, so there is nothing on the AI service to
  back up and nothing to leak.

Two turn shapes the upstream produces are handled so the panel never renders a silently blank
turn: a stream that dies before yielding anything usable is retried once (then becomes the fixed
error message), and a proposal that arrives without any explanation text is prefixed with a fixed
notice line. Requests are sent at low temperature. The prompt's worked example, rule checklist and
pre-proposal self-check — and the measurements behind all of these choices — are documented in
[the quality-gap investigation](superpowers/specs/2026-08-06-ai-assist-quality-gap.md).

## What is sent, and what is not

**Sent:** the query's `name`, `description` and `query`, redacted by default (see below); the
operator's chat messages; and the table schemas relevant to the conversation. A table earns its
full schema by being **named** — in the draft's table field, its query text, or any chat message
(`src/domain/relevantSchemas.js` decides); every other stored table travels as a bare name that the
system prompt lists so the model can still point at a table it was not given columns for, and
naming it in the next message pulls its schema in. Schemas carry column names, types and the
free-text `notes` — which is the part that makes the difference between plausible KQL and correct
KQL. The system prompt tells the model to use only columns that appear in the supplied schemas and
to say so plainly when a needed column is absent rather than inventing one.

The filtering is why a turn is cheap: with a ~264-table store, a measured chat request carries
about 7 KB of schema payload, against the ~519 KB the panel sent per turn when it shipped the
entire store. If the model seems not to know a table's columns, the fix is conversational, not
configuration: name the table in a message and its schema travels with the next turn.

**Not sent:** the marker→original mapping (it stays on the client for the conversation), the API
key, and anything that scans as a credential.

**Not retained:** no transcripts. The only record kept is a bounded provenance entry on the saved
query — model, timestamp, whether redaction was applied or overridden, the operator's instruction,
and the list of fields the operator **accepted** (never what was merely proposed). See
[docs/schema.md](schema.md#ai-provenance) for the field's bounds and why `fields` records acceptance
rather than proposal.

## Redaction: two rule classes, two behaviours

The scanner is the same one the GitHub backup CronJob uses, extracted into `api/lib/redact.js` so
there is one definition of "sensitive" rather than two that drift. The two classes are treated
differently, and the difference is the point:

| Class | Backup job | AI service |
| --- | --- | --- |
| **SECRET** — a credential | Fails, publishes nothing | **Refuses the request.** No placeholder, no override, no way through. |
| **DISCLOSURE** — operational detail (watchlist names, internal addresses, emails, GUIDs, UNC paths) | Replaced with a marker | Replaced with a marker; the request proceeds |

A credential gets a rejection rather than a placeholder because there is no correct version of
"send the credential anyway", and because the operator's next move is to remove it from the query.
A disclosure gets a marker because the value is operational detail that could help an adversary map
the estate — but the request itself is worth making.

The redaction preview is shown on **every** send, not just the first. A conversation that started
benign can drift into pasting a watchlist name three turns later. The per-request override ("send
verbatim") exists for queries that are genuinely benign; it is never the default, and a secret is
refused even under it.

### Why typed placeholders, not HMAC fingerprints

The backup job needs `REDACTED-<8 hex>` because stability across runs is what keeps an unchanged
query from producing a changed commit. The AI service needs the opposite property: `<EMAIL_1>` and
`<WATCHLIST_NAME_2>` tell the model what kind of thing was removed, so it keeps the value in a
string comparison instead of mangling it, and typed placeholders survive the model moving them
around when it rewrites the surrounding KQL. Un-redaction on the return path is a substitution over
the model's response.

## House style for a description

A proposed `description` follows the convention the library already uses: a prose paragraph
saying what the query detects and how, a blank line, a line reading exactly `Use Case:`, then one
`- ` bullet per use case, each written as a full sentence. The system prompt states the rule and
shows an example, and the `propose_query` tool schema repeats it on the `description` field — the
model reads both.

The convention was counted, not invented: of the stored descriptions carrying such a heading,
`Use Case:` was the clear majority, against a handful of `Use case:`, `Use Cases:` and one
`User Case:`. Nothing enforces the format — like every other proposed field it is reviewed before
it reaches the draft, and the validator only bounds the length.

## Why proposals are reviewed, never applied

Ollama Cloud does not support structured outputs (re-verified 2026-08-02 — the docs still say so,
and the GitHub issues tracking it remain open). The `format` JSON-schema parameter that would make
malformed metadata structurally impossible is unavailable, so the model will return `T1078.9`, it
will return severities that are not in the vocabulary, and it will occasionally return an empty
query.

Every proposed field therefore runs through the same `validateQuery` the save path uses. A field
that survives is offered **pre-accepted**; a field that does not is offered **pre-rejected with the
validator's own message attached** — *"attack.techniques contains an invalid entry: T1078.9"*.
Accepting an invalid field requires an explicit tick, and nothing is auto-applied, including the
KQL. The weakness is visible, not hidden. If Ollama Cloud gains structured outputs later, the gate
stays; it becomes redundant rather than wrong.

## Switching it off

```bash
kubectl -n kqlstore scale deploy/kqlstore-ai --replicas=0
```

The SPA probes `/api/ai/health` once on mount. When the service is unreachable, the assist toggle
is hidden — not disabled — and nothing in the editor depends on the AI service. Forking, schema
editing and manual authoring are untouched. Scale back to 1 to re-enable. For the wider operational
picture — egress, key rotation, the cross-node NetworkPolicy hazard — see
[docs/maintenance/ai-service.md](maintenance/ai-service.md).
