// Capture the RAW NDJSON stream for the flaky case, to distinguish "model never
// emitted a tool call" from "tool call arrived malformed and was dropped".
const fs = require('fs');
const path = require('path');
const EVAL = '/home/pure/Documents/github/KQLStore/api-ai/eval';
const { redactFields } = require(path.join(EVAL, '../lib/fields'));
const { OLLAMA_URL } = require(path.join(EVAL, '../lib/ollama'));
const { buildVariant } = require(path.join(EVAL, 'lib/variants'));

const key = fs.readFileSync(process.env.OLLAMA_API_KEY_FILE, 'utf8').trim();
const schemaDump = JSON.parse(fs.readFileSync(path.join(EVAL, 'schemas.json'), 'utf8'));
const schemasByName = new Map(schemaDump.map((s) => [s.name, s]));
const allNames = schemaDump.map((s) => s.name);
const kase = JSON.parse(fs.readFileSync(path.join(EVAL, 'cases.json'), 'utf8'))
  .find((c) => c.id === 'event-time-trap');

const schemas = kase.schemaTables.map((t) => schemasByName.get(t));
const knownTables = allNames.filter((n) => !kase.schemaTables.includes(n)).slice(0, 1000);
const { redacted } = redactFields(kase.draft);
const { system, tool } = buildVariant('baseline', schemas, knownTables);
const payload = {
  model: 'deepseek-v4-flash:0731-cloud',
  messages: [
    { role: 'system', content: system },
    { role: 'user', content: kase.instruction },
    { role: 'user', content: `Current draft:\nName: ${redacted.name}\nDescription: ${redacted.description}\nQuery:\n${redacted.query}` },
  ],
  tools: [tool],
  stream: true,
};

(async () => {
  for (let i = 1; i <= 4; i += 1) {
    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(180000),
    });
    let raw = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body) raw += decoder.decode(chunk, { stream: true });
    fs.writeFileSync(path.join(__dirname, `raw-ett-${i}.ndjson`), raw);
    const lines = raw.split('\n').filter(Boolean);
    let bad = 0; let toolLines = 0; let contentChars = 0; let doneReason = null;
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        if (evt?.message?.tool_calls) toolLines += 1;
        if (typeof evt?.message?.content === 'string') contentChars += evt.message.content.length;
        if (evt?.done) doneReason = evt.done_reason ?? '(none)';
      } catch { bad += 1; }
    }
    console.log(`attempt ${i}: lines=${lines.length} unparseable=${bad} toolCallLines=${toolLines} contentChars=${contentChars} done_reason=${doneReason}`);
  }
})();
