// Unblind judge results and aggregate per config: mean scores per dimension,
// failure-tag frequencies, best-label wins, and every verifier adjustment
// resolved to its config for manual synthesis.
//
//   node aggregate.js <journal.jsonl> <judge-inputs-dir> <out.json>
const fs = require('fs');
const path = require('path');

const [journalPath, inputsDir, outPath] = process.argv.slice(2);
const lines = fs.readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const raw = lines.filter((l) => l.type === 'result' && l.result).map((l) => l.result);
const judgmentsByCase = new Map(raw.filter((r) => r.judgments).map((r) => [r.caseId, r]));
const verificationsByCase = new Map(raw.filter((r) => r.verdicts).map((r) => [r.caseId, r]));
const results = [...judgmentsByCase.values()].map((judgment) => ({
  judgment,
  verification: verificationsByCase.get(judgment.caseId) || null,
}));
const mapping = JSON.parse(fs.readFileSync(path.join(inputsDir, '_mapping.json'), 'utf8'));

const cfgOf = (runRef) => runRef.split('/')[0];
const byConfig = {};
const tagsByConfig = {};
const wins = {};
const adjustments = [];
const perCase = [];

for (const { judgment, verification } of results) {
  const caseMap = mapping[judgment.caseId] || {};
  const caseRow = { caseId: judgment.caseId, outputs: {} };
  for (const j of judgment.judgments) {
    const runRef = caseMap[j.label];
    if (!runRef) continue;
    const cfg = cfgOf(runRef);
    const total = Object.values(j.scores).reduce((a, b) => a + b, 0);
    (byConfig[cfg] ||= []).push({ caseId: judgment.caseId, runRef, ...j.scores, total });
    for (const t of j.failureTags) ((tagsByConfig[cfg] ||= {})[t] ||= []).push(judgment.caseId);
    caseRow.outputs[runRef] = { scores: j.scores, total, tags: j.failureTags };
  }
  const bestRef = caseMap[judgment.bestLabel];
  if (bestRef) (wins[cfgOf(bestRef)] ||= []).push(judgment.caseId);
  caseRow.best = bestRef;
  caseRow.gapNotes = judgment.gapNotes;
  perCase.push(caseRow);

  if (verification) {
    for (const v of verification.verdicts || []) {
      const runRef = caseMap[v.label];
      if ((v.scoreAdjustments && v.scoreAdjustments.trim()) || (v.missedIssues || []).length || (v.rejectedClaims || []).length) {
        adjustments.push({
          caseId: verification.caseId, runRef,
          config: runRef ? cfgOf(runRef) : null,
          scoreAdjustments: v.scoreAdjustments || '',
          missedIssues: v.missedIssues || [],
          rejectedClaims: v.rejectedClaims || [],
        });
      }
    }
  }
}

const summary = Object.entries(byConfig).map(([cfg, rows]) => {
  const mean = (k) => (rows.reduce((a, r) => a + r[k], 0) / rows.length).toFixed(2);
  return {
    config: cfg, n: rows.length,
    schemaFidelity: mean('schemaFidelity'), bestPractices: mean('bestPractices'),
    validity: mean('validity'), logic: mean('logic'), discipline: mean('discipline'),
    total: mean('total'),
    wins: (wins[cfg] || []).length,
  };
}).sort((a, b) => b.total - a.total);

const tagTable = {};
for (const [cfg, tags] of Object.entries(tagsByConfig)) {
  tagTable[cfg] = Object.fromEntries(Object.entries(tags).map(([t, cs]) => [t, cs.length]).sort((a, b) => b[1] - a[1]));
}

fs.writeFileSync(outPath, JSON.stringify({ summary, tagTable, wins, adjustments, perCase }, null, 2));
console.table(summary);
console.log('\nFailure tags by config:');
for (const [cfg, tags] of Object.entries(tagTable)) console.log(` ${cfg}: ${JSON.stringify(tags)}`);
console.log(`\n${adjustments.length} verifier adjustment entries → ${outPath}`);
