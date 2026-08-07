// Build blinded comparative judge inputs: for each case, every captured output
// across the configs given on argv, shuffled and labeled A, B, C... The
// label->run mapping is written separately so judges never see provenance.
//
//   node mkjudge.js baseline temp0 think-off frontier
const fs = require('fs');
const path = require('path');
const EVAL = '/home/pure/Documents/github/KQLStore/api-ai/eval';

// "name@1" caps that config to rep <= 1. OUT env overrides the output dir.
const configs = process.argv.slice(2).map((a) => {
  const [name, cap] = a.split('@');
  return { name, cap: cap ? Number(cap) : Infinity };
});
if (!configs.length) { console.error('usage: node mkjudge.js <config>[@maxrep]...'); process.exit(1); }

const schemaDump = JSON.parse(fs.readFileSync(path.join(EVAL, 'schemas.json'), 'utf8'));
const schemasByName = new Map(schemaDump.map((s) => [s.name, s]));
const cases = JSON.parse(fs.readFileSync(path.join(EVAL, 'cases.json'), 'utf8'));

// The rule text judges score against — read from the live prompt builder so the
// rubric can never drift from what the model was actually told.
const { systemPrompt } = require(path.join(EVAL, '../lib/ollama'));
const promptText = systemPrompt([], []);
const bpStart = promptText.indexOf('KQL best practices');
const bpEnd = promptText.indexOf('\nAvailable table schemas:');
const BEST_PRACTICES = promptText.slice(bpStart, bpEnd).trim();
const HOUSE_STYLE = 'Description house style: a prose paragraph, then a blank line, then a line reading exactly "Use Case:", then one "- " bullet per use case, each a full sentence.';

const outDir = process.env.OUT ? path.resolve(process.env.OUT) : path.join(__dirname, 'judge-inputs');
fs.mkdirSync(outDir, { recursive: true });
const mapping = {};

// Deterministic shuffle per case (no Math.random in workflows; none needed here
// either — a simple rotation by case index de-correlates label order from config
// order without randomness).
for (const [caseIdx, kase] of cases.entries()) {
  const outputs = [];
  for (const { name: config, cap } of configs) {
    const dir = path.join(EVAL, 'results', config);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.startsWith(`${kase.id}.r`) || !f.endsWith('.json')) continue;
      const rep = Number((f.match(/\.r(\d+)\.json$/) || [])[1]);
      if (rep > cap) continue;
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (r.error) continue;
      outputs.push({
        runRef: `${config}/${f}`,
        text: r.response.text,
        proposal: r.response.proposal,
        toolCallCount: r.response.toolCallCount,
        mechanicalUnknownColumns: r.columnCheck ? r.columnCheck.unknownColumns : null,
        placeholders: r.placeholders,
      });
    }
  }
  if (!outputs.length) continue;
  const rot = caseIdx % outputs.length;
  const rotated = [...outputs.slice(rot), ...outputs.slice(0, rot)];
  const labeled = rotated.map((o, i) => ({ label: String.fromCharCode(65 + i), ...o }));
  mapping[kase.id] = Object.fromEntries(labeled.map((o) => [o.label, o.runRef]));

  const judgeInput = {
    caseId: kase.id,
    instruction: kase.instruction,
    draft: kase.draft,
    schemas: kase.schemaTables.map((t) => {
      const s = schemasByName.get(t);
      return { name: s.name, columns: s.columns.map((c) => `${c.name}:${c.type}`), notes: s.notes };
    }),
    expectations: kase.expectations,
    bestPractices: BEST_PRACTICES,
    houseStyle: HOUSE_STYLE,
    outputs: labeled.map(({ label, text, proposal, toolCallCount, mechanicalUnknownColumns, placeholders }) => ({
      label, text, proposal, toolCallCount, mechanicalUnknownColumns, placeholders,
    })),
  };
  fs.writeFileSync(path.join(outDir, `${kase.id}.json`), JSON.stringify(judgeInput, null, 2));
  console.log(`${kase.id}: ${labeled.length} outputs`);
}
fs.writeFileSync(path.join(outDir, '_mapping.json'), JSON.stringify(mapping, null, 2));
console.log('mapping written (do not show to judges)');
