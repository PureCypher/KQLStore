// ============================================================
// The model output gate.
//
// Ollama Cloud does not support structured outputs (re-verified 2026-08-02), so nothing
// constrains what comes back — the tool schema in api-ai/lib/ollama.js is a request, not
// a guarantee. The model will return T1078.9, it will return severities that are not in
// the vocabulary, and it will occasionally return an empty query.
//
// So every proposed field is run through the same validateQuery the save path uses,
// applied to a copy of the draft with that one field changed. A field that survives is
// offered pre-accepted; a field that does not is offered pre-REJECTED with the validator's
// own message attached. Nothing is dropped silently and nothing is applied silently: the
// weakness becomes visible rather than hidden.
// ============================================================
import { validateQuery } from './validate.js';
import { ATTACK_TACTICS } from '../constants.js';

// Models write "Credential Access"; the vocabulary is 'credential-access'. Folding both
// sides to bare letters maps any spacing/casing of a real tactic onto its canonical form,
// while a name that is not in the vocabulary ("Credential Theft") passes through untouched
// and is rejected by the validator with its reason visible — normalization must never
// widen what validates, only re-spell it.
const TACTIC_BY_FOLDED = new Map(
  ATTACK_TACTICS.map((t) => [t.replace(/[^a-z]/gi, '').toLowerCase(), t]),
);

function normalizeAttack(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = { ...value };
  if (Array.isArray(value.tactics)) {
    out.tactics = value.tactics.map((t) => (typeof t === 'string'
      ? TACTIC_BY_FOLDED.get(t.replace(/[^a-z]/gi, '').toLowerCase()) ?? t
      : t));
  }
  if (Array.isArray(value.techniques)) {
    out.techniques = value.techniques.map((t) => (typeof t === 'string' ? t.trim().toUpperCase() : t));
  }
  return out;
}

// Fields the model may propose. id, usageCount, parentId, created and updated are
// deliberately absent — they are identity and history, not content, and a model has no
// business proposing them.
const PROPOSABLE = [
  'name', 'description', 'query', 'category', 'table', 'tags',
  'severity', 'confidence', 'queryType', 'platform', 'attack',
  'falsePositives', 'tuningNotes', 'references', 'entityMappings', 'lookback',
];

function unchanged(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The validator's complaint about one field, or '' if it did not complain about it. */
function reasonFor(errors, field) {
  const hit = errors.find((e) => e.toLowerCase().includes(field.toLowerCase()));
  return hit || errors[0] || '';
}

/**
 * @param {object} draft the query as it currently stands in the editor
 * @param {object} proposed the model's tool-call arguments
 * @returns {Array<{field: string, from: unknown, to: unknown, valid: boolean, reason: string}>}
 */
export function reviewProposal(draft, proposed) {
  if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) return [];

  const out = [];
  for (const field of PROPOSABLE) {
    if (!(field in proposed)) continue;
    const proposedValue = field === 'attack' ? normalizeAttack(proposed[field]) : proposed[field];
    if (unchanged(draft[field], proposedValue)) continue;

    const candidate = { ...draft, [field]: proposedValue };
    const { valid, errors, sanitized } = validateQuery(candidate);

    // Judge this field alone: a draft that was already invalid elsewhere must not cause
    // an unrelated proposal to be rejected.
    const complaint = errors.find((e) => e.toLowerCase().includes(field.toLowerCase()));
    const fieldValid = valid || !complaint;

    out.push({
      field,
      from: draft[field],
      to: fieldValid && sanitized ? sanitized[field] ?? proposedValue : proposedValue,
      valid: fieldValid,
      reason: fieldValid ? '' : reasonFor(errors, field),
    });
  }
  return out;
}

/**
 * One provenance entry for a save.
 *
 * `fields` lists what the operator ACCEPTED, never what the model proposed. A rejected
 * rewrite must not leave a record claiming a model authored the detection logic — that is
 * worse than no audit trail, because it is a trail that lies. The instruction is the
 * operator's own prompt, truncated like the API truncates it (never rejected).
 */
export function buildProvenanceRecord(accepted, { model, generatedAt, redaction, instruction }) {
  return {
    model,
    generatedAt,
    redaction,
    instruction: String(instruction || '').slice(0, 1000),
    fields: accepted.map((c) => c.field),
  };
}
