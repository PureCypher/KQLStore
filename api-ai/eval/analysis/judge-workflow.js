export const meta = {
  name: 'judge-eval-outputs',
  description: 'Blinded comparative judging of AI-assist eval outputs, with adversarial verification',
  phases: [
    { title: 'Judge', detail: 'one comparative judge per case, blinded labels' },
    { title: 'Verify', detail: 'adversarial re-check of every judgment against the evidence' },
  ],
}

// Hardcoded on purpose: args reached this script as a JSON-encoded string in
// earlier runs, silently falling back to the round-1 directory. Do not trust args.
const DIR = '/tmp/claude-1000/-home-pure-Documents-github-KQLStore/46758413-5120-4eb8-906b-8aa4c3e3892d/scratchpad/judge-inputs-r2'
const CASES = args && args.cases ? args.cases : [
  'new-detection-spray', 'grounding-ztsgraph', 'rewrite-performance', 'adapt-table',
  'metadata-only', 'redaction-placeholders', 'event-time-trap', 'join-hygiene',
  'dynamic-column', 'absent-column', 'known-tables-pointer',
]

const TAGS = 'invented-column | wrong-table-column-mix | hallucinated-table | contains-vs-has | case-fold-tolower | time-range-wrong-column | time-filter-late | no-early-project | filter-on-calculated | dynamic-no-prefilter | join-explosion | join-unfiltered-side | join-order-wrong | missing-table-field | missing-category | missing-false-positives | vague-false-positives | house-style-miss | placeholder-mangled | empty-response | no-tool-call-when-needed | invalid-args | empty-query | semantic-drift | unbounded-exploration | logic-error | ambiguity-unaddressed'

// Number of outputs per case; the judgments array must cover every label.
const EXPECTED = 9

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    caseId: { type: 'string' },
    judgments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          scores: {
            type: 'object',
            properties: {
              schemaFidelity: { type: 'integer', minimum: 0, maximum: 3 },
              bestPractices: { type: 'integer', minimum: 0, maximum: 3 },
              validity: { type: 'integer', minimum: 0, maximum: 3 },
              logic: { type: 'integer', minimum: 0, maximum: 3 },
              discipline: { type: 'integer', minimum: 0, maximum: 3 },
            },
            required: ['schemaFidelity', 'bestPractices', 'validity', 'logic', 'discipline'],
          },
          failureTags: { type: 'array', items: { type: 'string' } },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              properties: { claim: { type: 'string' }, quote: { type: 'string' } },
              required: ['claim', 'quote'],
            },
          },
        },
        required: ['label', 'scores', 'failureTags', 'evidence'],
      },
    },
    bestLabel: { type: 'string' },
    gapNotes: { type: 'string', description: 'What separates the best output from the worst, concretely' },
  },
  required: ['caseId', 'judgments', 'bestLabel', 'gapNotes'],
}
if (EXPECTED) {
  JUDGE_SCHEMA.properties.judgments.minItems = EXPECTED
  JUDGE_SCHEMA.properties.judgments.maxItems = EXPECTED
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    caseId: { type: 'string' },
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          rejectedClaims: { type: 'array', items: { type: 'string' }, description: 'judge claims the evidence does not support, with why' },
          missedIssues: { type: 'array', items: { type: 'string' }, description: 'real defects in this output the judge failed to tag' },
          scoreAdjustments: { type: 'string', description: 'e.g. "B schemaFidelity 3->1: query references RiskScore which is not in the schema"; empty if none' },
        },
        required: ['label', 'rejectedClaims', 'missedIssues', 'scoreAdjustments'],
      },
    },
  },
  required: ['caseId', 'verdicts'],
}

function judgePrompt(id) {
  return `Read ${DIR}/${id}.json. It contains one eval case for a KQL-writing assistant (Microsoft Sentinel / Defender XDR): the user instruction, the draft, the table schemas (ground truth for which columns exist), case-specific expectations written by the eval author, the best-practices rules the assistant was given, the description house style, and several BLINDED outputs labeled A, B, C, ... Each output has the assistant's message text, its propose_query arguments (or none), a mechanical unknown-column signal (heuristic — may false-positive on aliases; verify against the schemas yourself), and redaction-placeholder survival counts.

Score EVERY output on five dimensions, 0-3 each:
- schemaFidelity: 3 = every referenced column exists in the schemas for the table it is read from; 0 = multiple invented columns or wrong-table columns. For outputs that assert a needed column is absent: that is CORRECT behavior when true (score 3), a failure when the column exists.
- bestPractices: against the provided rules — filter placement/order, has vs contains, case-sensitivity, event-time split (RANGE on TimeGenerated/Timestamp, analysis on the semantic event-time column), early project, dynamic pre-filter, join hygiene, let/materialize, bounded exploration.
- validity: would the KQL parse and run (operator syntax, summarize/by shapes, join syntax, function arity).
- logic: does it do what the user asked, including the case's traps (read expectations.notes).
- discipline: proposal fields — valid arg shapes, description in exact house style (prose, blank line, "Use Case:", "- " bullets as full sentences), table/category set correctly, falsePositives 2+ and concrete, placeholders verbatim, no fields changed that the user forbade, tool call present when one was needed (or correctly absent).

An output with NO message text and NO tool call is an empty response: score 0 across logic and discipline and tag empty-response.

failureTags vocabulary (use exactly these strings): ${TAGS}

Every score below 3 needs at least one evidence entry quoting the offending fragment (or naming what is missing). Do not reward verbosity; a shorter correct query beats a longer padded one. Judge each output independently, then pick bestLabel.
${EXPECTED ? `\nThe file contains exactly ${EXPECTED} outputs (labels A through ${String.fromCharCode(64 + EXPECTED)}). Your judgments array MUST contain exactly ${EXPECTED} entries, one per label, in order — count them before returning. A response missing any label is invalid and wastes the whole run.` : ''}

Return via structured output.`
}

phase('Judge')
const results = await pipeline(
  CASES,
  (id) => agent(judgePrompt(id), { label: `judge:${id}`, phase: 'Judge', schema: JUDGE_SCHEMA }),
  (judgment, id) => judgment && agent(
    `Read ${DIR}/${id}.json (an eval case with blinded outputs A, B, C, ... and table schemas that are ground truth). Then adversarially verify this judgment of those outputs:

${JSON.stringify(judgment)}

For every judged label: (1) re-check each evidence claim against the actual output and schemas — reject claims the evidence does not support (typical judge errors: calling a column invented when it exists in the schema or is an alias defined in the query; flagging contains-vs-has where has is genuinely impossible because the value is a substring of a term; house-style complaints that misread the format). (2) Hunt for real defects the judge MISSED — especially invented columns (check every column reference against the schema line by line), the event-time split (range filter must be on TimeGenerated/Timestamp), semantic drift from the user's instruction, and placeholder mangling. (3) Propose score adjustments only where you found concrete evidence; state them precisely.

Be skeptical in both directions; the goal is that a human reading only your output could correct the judgment. Return via structured output.`,
    { label: `verify:${id}`, phase: 'Verify', schema: VERIFY_SCHEMA },
  ).then((v) => ({ judgment, verification: v })),
)

const ok = results.filter(Boolean)
log(`${ok.length}/${CASES.length} cases judged and verified`)
return ok