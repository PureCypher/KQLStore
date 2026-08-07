# Closing the KQL-generation gap: deepseek-v4-flash vs frontier (investigation)

**Date:** 2026-08-06/07 · **Status:** findings + recommendations, no production changes
**Serving path under test:** `api-ai/routes/chat.js` → Ollama Cloud, prompt/tool from
`api-ai/lib/ollama.js` · **Eval harness:** `api-ai/eval/` (rerun instructions in its README)

## TL;DR

The gap is real but it is **not mostly "worse KQL."** On everyday generation and
rewriting, deepseek-v4-flash lands close to the frontier reference; blinded judges
scored it within a point of frontier on schema fidelity and validity for most cases.
Three specific failure modes account for the distance, in order of impact:

1. **Empty replies.** Ollama Cloud sometimes terminates the stream abnormally after
   the model's thinking phase: no content, no tool call, and **no `done` event** on
   the wire (raw-stream verified; not a JSON-decode drop on either side). The
   operator sees a blank assistant turn. Observed in 6 of 174 captured runs (3.4%),
   always with thinking on, never with `think:false`.
2. **Silent proposals.** Thinking is ON by default for this model. In roughly half
   of runs the model puts its entire explanation into `message.thinking` — which
   `chat.js` discards — and emits a tool call with **zero message text**. The
   proposal card appears with no reasoning next to it. No prompt variant fixed
   this; `think:false` fixes it completely but costs quality elsewhere (see §4).
3. **Hard-case honesty.** Where a requested column does not exist, flash guesses
   (`AdditionalFields.LogonProcessName`, a speculative `SubStatus`); where no
   schema was provided, it proposes anyway with mostly-plausible-but-partly-invented
   columns. The frontier model says "that column is not in this table" and, with no
   schema in hand, points at the table instead of proposing. Prompt levers shrink
   but do not close this class — and the two residual invention shapes
   (dynamic-key guesses, no-schema fabrication) are exactly the ones a
   column-list validator cannot catch, because the root column exists.

**Recommended sequence:**

| # | Change | Type | Expected effect | Cost |
|---|--------|------|-----------------|------|
| 1 | Ship the fixed `combo` prompt (few-shot worked example with real newlines + checklist rules + self-check + query-param rules) — `eval/lib/variants.js` is the exact text | prompt-only | measured: 100% tool-call rate, metadata 11/11, house style 10/11, 0 schema-visible inventions, 0 lost markers, ~2× faster than baseline | +~610 prompt tokens/turn (~+17%) |
| 2 | Add `options: { temperature: 0.2 }` in `chat.js` | one line | small free gain: judges +0.4 total, house style 18/20 vs 14/20, −18% latency, fewer fabrications | none |
| 3 | Harden the serving path: retry once when the stream ends with no content, no tool call and no `done` event; emit a fixed one-line notice when a proposal arrives with empty text | ~20 lines in `chat.js` | removes the blank-turn mode (3.4%) and makes silent proposals honest; the only fix for these — prompts demonstrably cannot reach them | none at runtime |
| 4 | Keep `deepseek-v4-flash`; do not swap | — | see §5 — `deepseek-v4-pro` judged best of the alternatives (+1.7 vs baseline) but regresses tool discipline, is the heaviest silent-proposer (3/11 with text), mangled a redaction marker, and burns the subscription's GPU-time quota ~10× faster; the combo prompt on flash reaches similar judged territory for free | — |
| 5 | Only if 1–3 underdeliver on honesty: server-side unknown-column check → one re-prompt (prototype: `eval/lib/kqlcheck.js`) | structural | targets residual inventions; note its blind spot: dynamic-key guesses pass the root-column check | +1 model round-trip on violation; buffering surgery in `routes/chat.js` |

## 1. Platform facts, re-verified empirically (2026-08-06)

The constraints in code comments (last verified 2026-08-02) have drifted. Refresh
them next time `api-ai/lib/ollama.js` is touched:

| Claim in code | Status today | Evidence |
|---|---|---|
| `format` JSON-schema param → 400 | **Silently ignored** (200, plain text back, schema not applied) | probe |
| `oneOf`/`anyOf` in tool schema → 400 | **Accepted** (200, tool call parsed) | probe |
| No `options` sent | `temperature`, `num_ctx` **accepted** | probe |
| — (undocumented) | **Thinking ON by default**; `think:false` honored; `think:"low"` accepted but measurably identical to default (390–9,195 thinking chars across 6 runs) | probes + runs |
| — (undocumented) | Model is 158B FP8, **1,048,576-token context**. No truncation at production payload sizes: `prompt_eval_count` 3,598 > char-estimate 3,061 | `/api/show` + counters |
| Default model | Production deploys `OLLAMA_MODEL=deepseek-v4-flash:0731-cloud` (pinned), not the code default `deepseek-v4-flash:cloud` | deployment env |

The `format` change does **not** reopen structured outputs — ignored is not
enforced — so the client review gate (`src/domain/proposal.js`) stays the safety
net, exactly as designed.

## 2. Eval set and methodology

11 cases (`api-ai/eval/cases.json`) over real store schemas resolved at run time
(gitignored dump — curated notes stay out of version control): new detection
(SigninLogs spray), grounding on an untrainable table (`ZTSGraph`), performance
rewrite with planted violations, cross-table adaptation, metadata-only fill-in,
redaction-placeholder rewrite (markers made by the real `redactFields`),
event-time trap, join hygiene, dynamic-column access, absent-column honesty, and
a no-schema table-pointer case.

The harness (`api-ai/eval/run.js`) mirrors `routes/chat.js`: live
`systemPrompt()`/`PROPOSE_TOOL`, real draft redaction, `stream: true`, identical
NDJSON decode. ~200 live captures across 15 configs. Prompt variants are
marker-spliced edits of the live prompt (they throw if `systemPrompt()` changes
shape), so each config differs by exactly one lever.

Scoring: **blinded comparative judging.** Per case, all outputs (deepseek configs
plus a frontier reference produced by Claude Fable 5 under the identical prompt
and tool JSON) were shuffled and labeled A/B/C…; a judge agent scored five 0–3
dimensions (schema fidelity, best practices, validity, logic, tool discipline)
with mandatory evidence quotes and a fixed failure-tag vocabulary; an
**adversarial verifier** per case then re-checked every claim and hunted for
missed defects. Judges never saw provenance. Pipeline: `api-ai/eval/analysis/`.

Robustness: the round-1 comparison was judged **three independent times**
(a directory-routing bug turned two later runs into accidental replicates — see
§7). Config means were stable to ±0.35 of 15 and the ordering never changed.
Self-judging caveat: judges and the frontier reference share a model family;
blinding is the mitigation, and the verifier layer demonstrably worked — it
caught the frontier's own defects (two unbounded final queries) that judges let
stand, correcting a suspicious 15.00 to ≈14.7.

## 3. The measured gap (production shape vs frontier)

Mean of three judge passes (0–3 per dimension, 15 max; baseline/temp0 n=22 per pass):

| Config | Judge total (3 passes) | Blinded wins |
|---|---|---|
| frontier (Fable 5) | 15.00, 15.00, 15.00 (verifier-adjusted ≈14.7) | 33/33 |
| think-off | 12.27, 12.45, 11.91 | 0 |
| temp0 | 11.73, 12.05, 11.73 | 0 |
| baseline | 11.36, 11.50, 11.14 | 0 |

**Baseline failure tags** (per-pass counts, 22 runs): house-style-miss ≈6,
logic-error 5–7, no-early-project 3–4, invented-column 3, semantic-drift 3,
ambiguity-unaddressed 2–3, empty-response 2, invalid-args 1–2, join-explosion 2.

What does **not** account for the gap: redaction-placeholder handling (0 markers
mangled across every flash config when the field was rewritten), metadata
discipline (table/category/falsePositives set in 20/20 baseline proposals),
prompt truncation (§1), and the 264-name `knownTables` list (stripping it saved
~1,650 tokens and changed nothing — including the honesty failure, which
persisted 2/2).

### 3a. The empty-reply mode, on the wire

Raw NDJSON of the most-provoking case (4 attempts, `analysis/probe-raw.js`):

```
attempt 1: lines=256 unparseable=0 toolCallLines=1 contentChars=645 done_reason=stop
attempt 2: lines=159 unparseable=0 toolCallLines=0 contentChars=0   done_reason=NONE  ← stream cut
attempt 3: lines=25  unparseable=0 toolCallLines=1 contentChars=0   done_reason=stop  ← silent proposal
attempt 4: lines=33  unparseable=0 toolCallLines=1 contentChars=0   done_reason=stop  ← silent proposal
```

Attempt 2 is the smoking gun: zero unparseable lines, no tool call, **no
`done:true` event** — upstream cut the stream after thinking. The captured
thinking of such runs ends mid-intention ("Let me propose.") *with a correct
query already worked out inside it*: the model solved the task and the transport
lost the answer. On this case the model also never writes message text even when
it succeeds (0 chars in 10/10 runs across configs) — the silent-proposal mode at
its purest. `chat.js` renders both modes as the same blank turn and retries
nothing; hence recommendation 3.

## 4. Levers, one at a time

Mechanical signals (11 cases; "inv" = runs with real invented columns after
join-rename/alias false positives are removed; "style" = descriptions matching
the exact house shape `prose\n\nUse Case:\n- …`):

| Config | tool% | text | style | inv runs | markers lost | prompt tok | out tok med | wall med |
|---|---|---|---|---|---|---|---|---|
| baseline | 91% | 6/11 | 14/20 | 2 | 0 | 3,598 | 2,650 | 21.3s |
| temp0 | 91% | ~6/11 | 18/20 | 1 | 0 | 3,598 | 1,878 | 17.5s |
| think-off | 91% | **11/11** | 3/8 | 1¹ | 0¹ | 3,598 | 938 | **8.6s** |
| fewshot (fixed²) | **100%** | 6/11 | 10/11 | 1 | 0 | 4,008 | 1,551 | 26.3s |
| checklist | 91% | 6/11 | 7/10 | 0 | 0 | 3,605 | 2,278 | 17.2s |
| selfcheck | 91% | 8/11 | 4/10 | 0 | 0 | 3,718 | 1,973 | 18.7s |
| tooldesc | **100%** | 5/11 | 5/11 | 1 | 0 | 3,673 | 2,115 | 20.1s |
| **combo (fixed²)** | **100%** | 6/11 | **10/11** | 1³ | 0 | 4,210 | 1,732 | **11.3s** |

¹ think-off's honesty-case run invented two columns (double the baseline rate on
that case) and left a stale description behind (proposal omitted the field).
² First captures of `fewshot`/`combo` had a self-inflicted defect: the worked
example showed its description/query as JSON-encoded strings, and the model
copied **literal `\n`** into 9/11 and 8/11 descriptions. Rewritten with real
newlines (`variants.js`), the defect went to 0/11 and house style rose from
2–3/11 to 10/11. Lesson worth keeping: *show the model field contents, not JSON
encodings of them.*
³ The one remaining invention is the no-schema case (fabricated `UserId`-style
columns in an otherwise-real CloudAppEvents sketch) — see honesty note below.

Judge scores, full blinded pass over all nine round-2 arms (n=11 each; baseline
scored 11.55 in this pass, consistent with its 11.1–11.5 replicate band; the
`fewshot`/`combo` rows carry the literal-`\n` artifact in their discipline
column — mechanically corrected rows above are the fairer read of those two):

| Config | schemaFid | bestPract | validity | logic | discipline | total |
|---|---|---|---|---|---|---|
| m-deepseek-pro | 3.00 | 2.36 | 3.00 | 2.36 | 2.55 | 13.27 |
| m-kimi-code | 2.73 | 2.45 | 2.64 | 2.55 | 2.73 | 13.09 |
| fewshot (\n-artifact) | 2.82 | 2.64 | 2.82 | 2.64 | 2.00 | 12.91 |
| tooldesc | 2.82 | 2.45 | 2.82 | 2.82 | 1.91 | 12.82 |
| combo (\n-artifact) | 2.82 | 2.45 | 3.00 | 2.36 | 2.00 | 12.64 |
| m-qwen | 2.82 | 2.27 | 2.64 | 2.09 | 2.82 | 12.64 |
| selfcheck | 2.91 | 2.45 | 2.45 | 2.55 | 1.82 | 12.18 |
| checklist | 2.64 | 2.36 | 2.45 | 2.09 | 2.27 | 11.82 |
| baseline | 2.45 | 2.45 | 2.27 | 2.18 | 2.18 | 11.55 |

Per-lever verdicts:

- **fewshot** — the strongest single lever: 100% tool-call rate (including the
  case that failed at baseline), halved thinking, −40% output tokens, and with
  the newline fix, 10/11 house style. The example gives the model a shape to fill.
- **checklist / selfcheck** — each drove schema-visible inventions to zero;
  selfcheck also produced the frontier-like behavior on the no-schema case when
  standalone (declined to propose, guided instead). Both mildly *hurt* house
  style standalone — extra instruction mass crowds out format care.
- **tooldesc** — 100% tool rate, worst style; keep only inside combo.
- **combo** — the levers compose: best all-round flash config, ~2× faster than
  baseline. Honesty residue: it still guesses dynamic keys on the absent-column
  case (invisible to a column checker — the root `AdditionalFields` exists) and,
  unlike selfcheck standalone, still proposes on the no-schema case.
- **temp0** — mildly positive everywhere, negative nowhere. Take it.
- **think-off** — a trade, not a win: fixes both reliability modes and is 2.5×
  faster, but doubles invention on the honesty case, drops house style, skips
  descriptions. Superseded by recommendation 3, which keeps thinking's benefits.
- **think:"low"**, **stripping knownTables** — measured no-ops. Dead ends.

## 5. Model alternatives on Ollama Cloud

Same prompt, same cases. Ollama Cloud bills subscription + GPU time, so a bigger
model spends the tier's quota faster rather than billing per token; open-market
per-token rates are shown only as a relative-cost signal.

| Model | Size | Judge total | tool% | text | style | Notable regressions | wall med | Market rate/1M |
|---|---|---|---|---|---|---|---|---|
| deepseek-v4-flash:0731 (current) | 158B FP8 | 11.55 | 91% | 6/11 | 14/20 | — (the baseline) | 21.3s | $0.14 / $0.28 |
| deepseek-v4-pro | 1.6T FP8 | **13.27** | 82% | **3/11** | 9/9 | refused to propose on the metadata-only case (prose instead); heaviest silent mode; 1 marker mangled; 4 unbounded queries | 20.3s | $2.10 / $4.40 |
| kimi-k2.7-code | 1T INT4 | 13.09 | 100% | 5/11 | 11/11 | `TimeGenerated` on Defender tables; fabricated columns on the no-schema case | 26.0s | ≈$1.20 / $4.50 |
| qwen3.5:397b | 397B BF16 | 12.64 | 100% | 4/11 | 11/11 | worst logic tags (7); invented `LogonProcessName`; `TimeGenerated` on Defender tables | 21.9s | — |

Notable: **every alternative follows the description house style perfectly**
(flash is the outlier), and **none** escapes the silent-proposal mode — it is a
thinking-channel behavior of the serving stack, not of one model.

Verdict: **stay on flash.** pro's +1.7 judged points are real but arrive with
tool-discipline regressions the UI cannot absorb (a metadata request answered in
prose is a dead turn), the worst silent-proposal rate, the investigation's only
mangled redaction marker, and ~10× quota burn. The fixed combo prompt on flash
reaches comparable judged territory as a pure config change. If the residual
honesty gap matters after recommendations 1–3 ship, benchmark **combo-on-pro**
(one `OLLAMA_MODEL` flip + this harness) before deciding — that combination was
not measured here.

## 6. Structural options (only if §4–5 underdeliver)

1. **Empty-stream retry** *(promoted into recommendation 3 — cheap and prompt-unreachable).*
   Gate on "nothing written to the client yet", retry the upstream call once.
2. **Silent-proposal notice** *(also recommendation 3).* When tool calls arrive
   with no content, emit one fixed `{type:"text"}` line so the turn is honest.
   Relaying raw thinking instead is not recommended: verbose, and it bypasses the
   redaction-reviewed message path.
3. **Unknown-column validator + single re-prompt.** After the tool call, check the
   proposal's KQL identifiers against the schemas already in hand
   (`eval/lib/kqlcheck.js` is a working prototype); on violation, one corrective
   turn before responding. Honest limits: it cannot catch dynamic-key guesses
   (`AdditionalFields.Whatever` — root column exists) or no-schema fabrication
   (nothing to check against), which are precisely the residual invention shapes
   after combo. It would have caught 2 of the 4 baseline invention runs. Requires
   buffering the first response — real surgery on the streaming flow. Hold.
4. **Two-pass generate→critique** — measured unnecessary at combo's fidelity
   level; revisit only if the validator fires often in production.

## 7. Methodology notes (bugs found and kept honest)

- **Workflow args-as-string bug:** the judging workflow's input directory was
  passed via orchestrator args that arrived as a JSON-encoded string; the script
  silently fell back to the round-1 directory, so two "round-2" runs re-judged
  round-1 outputs — detectable because every judge returned exactly six
  judgments for nine-output inputs. Re-mapped correctly, those runs became the
  replicate passes in §3. The fixed run (paths hardcoded, judgment count pinned
  by schema `minItems`) produced §4's table with 9/9 coverage per case.
- **Few-shot `\n` artifact:** described in §4. Both the defect and the fix are
  measurable in the results dirs (`fewshot`/`combo` vs `fewshot2`/`combo2`).
- Two of 22 verifier agents in the final round hit a session limit; 11/11 judges
  and 9/11 verifiers completed. The two unverified cases (`absent-column`,
  `known-tables-pointer`) have mechanical checks corroborating the judgments.

## 8. Rerunning

```bash
cd api-ai/eval
kubectl -n kqlstore port-forward svc/kqlstore 18080:80 &
curl -s http://127.0.0.1:18080/api/schemas > schemas.json
kubectl -n kqlstore get secret kqlstore-ai -o jsonpath='{.data.OLLAMA_API_KEY}' | base64 -d > /tmp/.ollama_key && chmod 600 /tmp/.ollama_key
OLLAMA_API_KEY_FILE=/tmp/.ollama_key node run.js --config combo2 --repeat 2
node summary.js
```

Configs: `configs.json` (note `fewshot2`/`combo2` are the fixed-example arms —
the ones to trust). Variants: `lib/variants.js`. Judging pipeline: `analysis/`
(runs inside a Claude Code session; see its README). Captured results and the
schema dump are gitignored; the API key never touches the repo.

## Sources

- Ollama Cloud subscription/GPU-time model and open-market per-token comparisons:
  [yage.ai inference buying guide](https://yage.ai/share/ollama-cloud-vs-api-vs-subscriptions-en-20260428.html),
  [morphllm LLM API comparison](https://www.morphllm.com/llm-api),
  [Together.ai rates via AI Pricing Guru](https://www.aipricing.guru/together-pricing/)
- KQL best-practice ground truth: the prompt's distillation of
  learn.microsoft.com/kusto/query/best-practices (2025-06-09 revision)
