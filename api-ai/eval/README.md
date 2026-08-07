# AI-assist eval harness

Measures KQL-generation quality of the `/api/ai/chat` serving path across models,
request options and prompt variants, against a fixed case set. Built for the
2026-08 quality-gap investigation (see
`docs/superpowers/specs/2026-08-06-ai-assist-quality-gap.md`); rerunnable any time.

The harness is faithful to `api-ai/routes/chat.js`: same message construction,
same draft redaction (`lib/fields.js`), the live `PROPOSE_TOOL` and
`systemPrompt()` from `lib/ollama.js`, `stream: true`, and the same NDJSON event
decode. Prompt variants are marker-spliced edits of the live prompt (the splice
throws if `systemPrompt()` changes shape).

Since the investigation's recommendations landed, **the production prompt is the
measured combo shape**, so `baseline` here means "what production sends today"
(including `temperature: 0.2`, which `routes/chat.js` now sets). The `legacy`
variant reconstructs the pre-combo prompt for old-vs-new comparisons. The
historical single-lever arms (fewshot/checklist/selfcheck/tooldesc/combo) were
merged into production and removed from `lib/variants.js`; their numbers live in
the investigation report.

## Setup

```bash
cd api-ai/eval

# 1. Schema ground truth (gitignored — carries curated notes that stay local):
kubectl -n kqlstore port-forward svc/kqlstore 18080:80 &
curl -s http://127.0.0.1:18080/api/schemas > schemas.json

# 2. The key, without echoing it:
kubectl -n kqlstore get secret kqlstore-ai -o jsonpath='{.data.OLLAMA_API_KEY}' | base64 -d > /tmp/.ollama_key
chmod 600 /tmp/.ollama_key
export OLLAMA_API_KEY_FILE=/tmp/.ollama_key
```

## Running

```bash
node run.js --config baseline               # all 11 cases once
node run.js --config baseline --repeat 2    # variance check
node run.js --config temp0 --cases new-detection-spray,event-time-trap
```

Configs live in `configs.json` (model, `options`, `think`, prompt variant);
variants in `lib/variants.js`; cases in `cases.json`. Results land in
`results/<config>/<case>.r<n>.json` (gitignored) with the full message text,
thinking size, raw `propose_query` arguments, Ollama's token/latency counters,
a mechanical unknown-column check (`lib/kqlcheck.js`, heuristic — a signal for
judges, not a verdict) and per-marker redaction-placeholder survival counts.

`node summary.js` tabulates every results directory.

## Cases

11 cases in `cases.json`, each with judge guidance under `expectations`:
new-detection (SigninLogs spray), grounding on an untrainable table (ZTSGraph),
performance rewrite with planted violations, cross-table adaptation
(SigninLogs → DeviceLogonEvents), metadata-only fill-in (EmailEvents),
redaction-placeholder rewrite (real `redactFields` markers), event-time trap,
join hygiene, dynamic-column access (AuditLogs), absent-column honesty
(IdentityLogonEvents), and a no-schema table-pointer case.

Cases reference tables by name only; columns resolve from `schemas.json` at run
time, so the store's curated notes never enter version control.
