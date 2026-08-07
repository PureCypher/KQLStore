// Export per-case prompt bundles for the frontier-reference agents: the exact
// system prompt, user instruction, draft message and tool JSON the production
// path would send, so a frontier model answers under identical conditions.
const fs = require('fs');
const path = require('path');
const EVAL = '/home/pure/Documents/github/KQLStore/api-ai/eval';
const { redactFields, collectSecrets } = require(path.join(EVAL, '../lib/fields'));
const { buildVariant } = require(path.join(EVAL, 'lib/variants'));

const outDir = path.join(__dirname, 'frontier');
fs.mkdirSync(outDir, { recursive: true });

const schemaDump = JSON.parse(fs.readFileSync(path.join(EVAL, 'schemas.json'), 'utf8'));
const schemasByName = new Map(schemaDump.map((s) => [s.name, s]));
const allNames = schemaDump.map((s) => s.name);
const cases = JSON.parse(fs.readFileSync(path.join(EVAL, 'cases.json'), 'utf8'));

for (const kase of cases) {
  if (collectSecrets(kase.draft).length) throw new Error(`${kase.id}: secret in draft`);
  const schemas = kase.schemaTables.map((t) => schemasByName.get(t));
  const knownTables = allNames.filter((n) => !kase.schemaTables.includes(n)).slice(0, 1000);
  const { redacted, applied } = redactFields(kase.draft);
  const { system, tool } = buildVariant('baseline', schemas, knownTables);
  const bundle = {
    caseId: kase.id,
    system,
    userMessages: [
      kase.instruction,
      `Current draft:\nName: ${redacted.name}\nDescription: ${redacted.description}\nQuery:\n${redacted.query}`,
    ],
    tool,
    appliedMarkers: applied.map(({ rule, marker }) => ({ rule, marker })),
  };
  fs.writeFileSync(path.join(outDir, `${kase.id}.json`), JSON.stringify(bundle, null, 2));
  console.log(`${kase.id}: system ${system.length} chars, markers ${applied.length}`);
}
