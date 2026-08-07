// Convert the frontier workflow's returned answers into the same result-file
// shape run.js writes, so summary.js and the judges treat every config alike.
const fs = require('fs');
const path = require('path');
const EVAL = '/home/pure/Documents/github/KQLStore/api-ai/eval';
const { checkColumns } = require(path.join(EVAL, 'lib/kqlcheck'));

const answers = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const schemaDump = JSON.parse(fs.readFileSync(path.join(EVAL, 'schemas.json'), 'utf8'));
const allNames = new Set(schemaDump.map((s) => s.name));
const columnsByTable = new Map(schemaDump.map((s) => [s.name, new Set(s.columns.map((c) => c.name))]));
const cases = new Map(JSON.parse(fs.readFileSync(path.join(EVAL, 'cases.json'), 'utf8')).map((c) => [c.id, c]));

const outDir = path.join(EVAL, 'results', 'frontier');
fs.mkdirSync(outDir, { recursive: true });

for (const a of answers) {
  const kase = cases.get(a.caseId);
  if (!kase) { console.error(`unknown case ${a.caseId}`); continue; }
  const bundle = JSON.parse(fs.readFileSync(path.join(__dirname, 'frontier', `${a.caseId}.json`), 'utf8'));
  const proposal = a.madeProposal && a.proposal ? a.proposal : null;

  let columnCheck = null;
  if (proposal && typeof proposal.query === 'string') {
    const cleaned = proposal.query.replace(/<[A-Z0-9_]+>/g, '""');
    columnCheck = checkColumns(cleaned, columnsByTable, allNames);
  }
  const blob = JSON.stringify(proposal || {}) + '\n' + (a.text || '');
  const placeholders = bundle.appliedMarkers.map(({ rule, marker }) => ({
    rule, marker, inOutput: blob.split(marker).length - 1,
  }));

  const result = {
    caseId: a.caseId,
    rep: 1,
    config: { id: 'frontier', model: 'claude-fable-5', variant: 'baseline', think: null, options: null },
    request: { promptChars: bundle.system.length, estPromptTokens: Math.ceil(bundle.system.length / 4), schemaTables: kase.schemaTables, knownTableCount: 263 },
    error: null,
    attempts: 1,
    response: {
      text: a.text,
      thinkingChars: 0,
      toolCallCount: proposal ? 1 : 0,
      toolNames: proposal ? ['propose_query'] : [],
      proposal,
      counters: null,
      wallMs: null,
    },
    columnCheck,
    placeholders,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, `${a.caseId}.r1.json`), JSON.stringify(result, null, 2));
  console.log(`${a.caseId}: proposal=${!!proposal} unknownCols=${columnCheck ? columnCheck.unknownColumns.length : '-'}`);
}
