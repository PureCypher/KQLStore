#!/usr/bin/env node
// Tabulate every results/<config>/ directory: tool-call rate, unknown columns,
// placeholder survival, thinking share, token and latency medians.
const fs = require('fs');
const path = require('path');

const resultsRoot = path.join(__dirname, 'results');
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

const rows = [];
for (const config of fs.readdirSync(resultsRoot).sort()) {
  const dir = path.join(resultsRoot, config);
  if (!fs.statSync(dir).isDirectory()) continue;
  const runs = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  if (!runs.length) continue;
  const ok = runs.filter((r) => !r.error);
  const withTool = ok.filter((r) => r.response.toolCallCount > 0);
  const withQuery = ok.filter((r) => r.response.proposal && typeof r.response.proposal.query === 'string');
  const unknownCols = ok.filter((r) => r.columnCheck).map((r) => r.columnCheck.unknownColumns.length);
  const placeholderRuns = ok.filter((r) => r.placeholders.length > 0);
  const lostMarkers = placeholderRuns.flatMap((r) => r.placeholders.filter((p) => p.inOutput === 0));
  rows.push({
    config,
    runs: runs.length,
    errors: runs.length - ok.length,
    'tool%': ok.length ? Math.round((withTool.length / ok.length) * 100) : 0,
    'meta(t/c/fp)': withQuery.length
      ? ['table', 'category', 'falsePositives'].map((f) => withTool.filter((r) => r.response.proposal[f] != null).length).join('/')
      : '-',
    'unkCols med': median(unknownCols),
    'unkCols>0': unknownCols.filter((n) => n > 0).length,
    'markersLost': placeholderRuns.length ? `${lostMarkers.length}` : '-',
    'think med': median(ok.map((r) => r.response.thinkingChars)),
    'ptok med': median(ok.map((r) => r.response.counters?.prompt_eval_count).filter((n) => n != null)),
    'etok med': median(ok.map((r) => r.response.counters?.eval_count).filter((n) => n != null)),
    'wall med (s)': (median(ok.map((r) => r.response.wallMs)) / 1000).toFixed(1),
  });
}
console.table(rows);
