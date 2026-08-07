#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Standalone eval harness for the AI assist serving path.
//
// Faithful to api-ai/routes/chat.js on purpose: same message construction, same
// draft redaction (lib/fields), same tool, stream:true with the same NDJSON
// decode, tool-call arguments taken as Ollama sends them. Differs only in what
// it adds around the call: prompt variants, request options, capture of
// counters, and a mechanical schema-fidelity check on the proposal.
//
//   OLLAMA_API_KEY or OLLAMA_API_KEY_FILE must be set. The key is never printed.
//
//   node run.js --config baseline [--cases id1,id2] [--repeat 2] [--concurrency 3]
//
// Results land in results/<config>/<case>.r<n>.json (gitignored).
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { collectSecrets, redactFields } = require('../lib/fields');
const { OLLAMA_URL } = require('../lib/ollama');
const { buildVariant } = require('./lib/variants');
const { checkColumns } = require('./lib/kqlcheck');

const EVAL_DIR = __dirname;
const REQUEST_TIMEOUT_MS = 300_000;
const RETRY_DELAYS_MS = [5_000, 20_000];
const RATE_LIMIT_PAUSE_MS = 45_000;

function readKey() {
  if (process.env.OLLAMA_API_KEY) return process.env.OLLAMA_API_KEY.trim();
  const file = process.env.OLLAMA_API_KEY_FILE;
  if (file && fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  console.error('Set OLLAMA_API_KEY or OLLAMA_API_KEY_FILE.');
  process.exit(1);
}

function parseArgs(argv) {
  const args = { config: null, cases: null, repeat: 1, concurrency: 3 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--config') args.config = argv[++i];
    else if (a === '--cases') args.cases = argv[++i].split(',');
    else if (a === '--repeat') args.repeat = Number(argv[++i]) || 1;
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]) || 3;
    else { console.error(`unknown argument: ${a}`); process.exit(1); }
  }
  if (!args.config) { console.error('--config <id> is required'); process.exit(1); }
  return args;
}

function loadJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(EVAL_DIR, rel), 'utf8'));
}

/** Same event framing as routes/chat.js readEvents. */
async function* readEvents(body) {
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      if (evt) yield evt;
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callOllama(key, payload) {
  const started = Date.now();
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) {
    const err = new Error(`upstream ${res.status}`);
    err.status = res.status;
    throw err;
  }
  let text = '';
  let thinking = '';
  const toolCalls = [];
  let counters = null;
  for await (const evt of readEvents(res.body)) {
    if (typeof evt?.message?.content === 'string') text += evt.message.content;
    if (typeof evt?.message?.thinking === 'string') thinking += evt.message.thinking;
    if (Array.isArray(evt?.message?.tool_calls)) {
      for (const call of evt.message.tool_calls) {
        if (call?.function) toolCalls.push({ name: call.function.name, arguments: call.function.arguments });
      }
    }
    if (evt?.done) {
      counters = {
        total_duration_ms: evt.total_duration != null ? Math.round(evt.total_duration / 1e6) : null,
        load_duration_ms: evt.load_duration != null ? Math.round(evt.load_duration / 1e6) : null,
        prompt_eval_count: evt.prompt_eval_count ?? null,
        prompt_eval_duration_ms: evt.prompt_eval_duration != null ? Math.round(evt.prompt_eval_duration / 1e6) : null,
        eval_count: evt.eval_count ?? null,
        eval_duration_ms: evt.eval_duration != null ? Math.round(evt.eval_duration / 1e6) : null,
      };
      break;
    }
  }
  return { text, thinking, toolCalls, counters, wallMs: Date.now() - started };
}

/** Parse tool-call arguments the way chat.js does: string or object both accepted. */
function parseProposal(args) {
  let parsed = args;
  if (typeof args === 'string') {
    try { parsed = JSON.parse(args); } catch { return null; }
  }
  return parsed && typeof parsed === 'object' ? parsed : null;
}

async function runCase(ctx, kase, rep) {
  const { key, config, schemasByName, allNames, columnsByTable } = ctx;

  const schemas = kase.schemaTables.map((t) => {
    const s = schemasByName.get(t);
    if (!s) throw new Error(`case ${kase.id}: table ${t} not in schema dump`);
    return s;
  });
  const knownTables = [...allNames].filter((n) => !kase.schemaTables.includes(n))
    .slice(0, config.knownTablesCap ?? 1000);

  const secrets = collectSecrets(kase.draft);
  if (secrets.length > 0) throw new Error(`case ${kase.id}: draft trips the secret scanner — fix the case`);
  const { redacted, applied } = redactFields(kase.draft);

  const { system, tool } = buildVariant(config.variant, schemas, knownTables);
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: kase.instruction },
    {
      role: 'user',
      content: `Current draft:\nName: ${redacted.name}\nDescription: ${redacted.description}\nQuery:\n${redacted.query}`,
    },
  ];

  const payload = { model: config.model, messages, tools: [tool], stream: true };
  if (config.think !== undefined) payload.think = config.think;
  if (config.options) payload.options = config.options;

  const promptChars = JSON.stringify(messages).length;
  let outcome = null;
  let attempts = 0;
  let lastError = null;
  while (attempts <= RETRY_DELAYS_MS.length) {
    attempts += 1;
    try {
      outcome = await callOllama(key, payload);
      break;
    } catch (err) {
      lastError = String(err && err.message ? err.message : err);
      if (err && err.status === 429) await sleep(RATE_LIMIT_PAUSE_MS);
      else if (attempts <= RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempts - 1]);
    }
  }

  const proposals = outcome ? outcome.toolCalls.map((c) => parseProposal(c.arguments)).filter(Boolean) : [];
  const proposal = proposals[0] || null;

  // Mechanical column check on the proposed KQL, with redaction markers blanked
  // first so <EMAIL_OR_UPN_1> does not read as an identifier.
  let columnCheck = null;
  if (proposal && typeof proposal.query === 'string') {
    const cleaned = proposal.query.replace(/<[A-Z0-9_]+>/g, '""');
    columnCheck = checkColumns(cleaned, columnsByTable, allNames);
  }

  // Placeholder survival: every marker applied to the draft, counted in the raw
  // proposal JSON and the message text.
  const blob = JSON.stringify(proposal || {}) + '\n' + (outcome ? outcome.text : '');
  const placeholders = applied.map(({ rule, marker }) => ({
    rule,
    marker,
    inOutput: blob.split(marker).length - 1,
  }));

  return {
    caseId: kase.id,
    rep,
    config: {
      id: config.id, model: config.model, variant: config.variant,
      think: config.think ?? null, options: config.options ?? null,
    },
    request: { promptChars, estPromptTokens: Math.ceil(promptChars / 4), schemaTables: kase.schemaTables, knownTableCount: knownTables.length },
    error: outcome ? null : lastError,
    attempts,
    response: outcome ? {
      text: outcome.text,
      thinking: outcome.thinking,
      thinkingChars: outcome.thinking.length,
      toolCallCount: outcome.toolCalls.length,
      toolNames: outcome.toolCalls.map((c) => c.name),
      proposal,
      counters: outcome.counters,
      wallMs: outcome.wallMs,
    } : null,
    columnCheck,
    placeholders,
    generatedAt: new Date().toISOString(),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const key = readKey();

  const configs = loadJson('configs.json');
  const config = configs[args.config];
  if (!config) { console.error(`config ${args.config} not in configs.json`); process.exit(1); }
  config.id = args.config;

  const schemaFile = process.env.SCHEMAS_FILE || path.join(EVAL_DIR, 'schemas.json');
  const schemaDump = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
  const schemasByName = new Map(schemaDump.map((s) => [s.name, s]));
  const allNames = new Set(schemaDump.map((s) => s.name));
  const columnsByTable = new Map(schemaDump.map((s) => [s.name, new Set(s.columns.map((c) => c.name))]));

  let cases = loadJson('cases.json');
  if (args.cases) cases = cases.filter((c) => args.cases.includes(c.id));
  if (cases.length === 0) { console.error('no cases matched'); process.exit(1); }

  const outDir = path.join(EVAL_DIR, 'results', args.config);
  fs.mkdirSync(outDir, { recursive: true });

  const ctx = { key, config, schemasByName, allNames, columnsByTable };
  const jobs = [];
  for (const kase of cases) for (let r = 1; r <= args.repeat; r += 1) jobs.push({ kase, rep: r });

  let active = 0; let idx = 0; let failed = 0;
  await new Promise((resolve) => {
    const pump = () => {
      if (idx >= jobs.length && active === 0) return resolve();
      while (active < args.concurrency && idx < jobs.length) {
        const { kase, rep } = jobs[idx++];
        active += 1;
        runCase(ctx, kase, rep)
          .then((result) => {
            const file = path.join(outDir, `${kase.id}.r${rep}.json`);
            fs.writeFileSync(file, JSON.stringify(result, null, 2));
            const ok = result.error ? `ERROR ${result.error}` : `${result.response.toolCallCount} tool-call(s), ${result.response.counters?.eval_count ?? '?'} tokens, ${result.response.wallMs}ms`;
            if (result.error) failed += 1;
            console.log(`[${args.config}] ${kase.id} r${rep}: ${ok}`);
          })
          .catch((err) => { failed += 1; console.log(`[${args.config}] ${kase.id} r${rep}: HARNESS ERROR ${err.message}`); })
          .finally(() => { active -= 1; pump(); });
      }
    };
    pump();
  });

  console.log(`done: ${jobs.length - failed}/${jobs.length} succeeded → ${outDir}`);
  process.exit(failed > 0 ? 2 : 0);
}

main();
