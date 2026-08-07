# Judging & analysis pipeline

The record of how the 2026-08 quality-gap numbers were produced, kept for rerunning.
`run.js` captures are plain Node against Ollama Cloud; everything in this directory
runs inside a Claude Code session because the reference answers and the judging are
done by Claude agents (the Workflow tool).

Paths: these scripts were run from a session scratchpad; each has its working
directory or `EVAL` constant near the top — adjust to your checkout before rerunning.

Order of operations:

1. `mkbundles.js` — export per-case prompt bundles (exact system prompt + user
   messages + tool JSON) for the frontier-reference agents.
2. Frontier workflow (see the report's appendix) — 11 Claude agents answer the
   bundles under the production prompt; returns `{caseId, text, madeProposal, proposal}`.
3. `ingest-frontier.js <answers.json>` — writes those answers into
   `results/frontier/` in the same shape `run.js` produces.
4. `mkjudge.js <config>[@maxrep]...` — builds BLINDED comparative judge inputs
   (outputs labeled A/B/C…, provenance in `_mapping.json` which judges never see).
   `OUT=<dir>` overrides the output directory.
5. `judge-workflow.js` — Workflow script: one comparative judge per case scoring
   five dimensions (0–3) with evidence quotes and a fixed failure-tag vocabulary,
   then one adversarial verifier per case re-checking every claim and hunting for
   missed defects. Pass `args: {dir}` to point at the judge-inputs directory.
6. `aggregate.js <journal.jsonl> <judge-inputs-dir> <out.json>` — unblinds via
   `_mapping.json`, tabulates per-config means, tags, wins, and every verifier
   adjustment.

`probe-raw.js` — captures the raw NDJSON stream for the flaky case, to separate
"model never emitted the tool call / stream cut early" from "malformed line dropped
by the decoder". This is how the abnormal-termination finding was established.
