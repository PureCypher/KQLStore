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
