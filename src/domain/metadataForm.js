import { TECHNIQUE_REGEX } from '../constants.js';

// ============================================================
// Translation between the detection metadata schema and the shapes a form can edit.
//
// The schema stores arrays and nested objects; a form edits strings. Keeping the
// conversion here rather than in the component means the editor never has to know the
// schema's shape, and the round trip is unit-testable without rendering anything.
// ============================================================

const linesToArray = (text) =>
  (text || '').split('\n').map((s) => s.trim()).filter(Boolean);

const arrayToLines = (arr) => (Array.isArray(arr) ? arr.join('\n') : '');

const commasToArray = (text) =>
  (text || '').split(',').map((s) => s.trim()).filter(Boolean);

/** Schema shape -> form shape. */
function metadataToForm(query) {
  const q = query || {};
  return {
    queryType: q.queryType || '',
    severity: q.severity || '',
    confidence: q.confidence || '',
    platform: Array.isArray(q.platform) ? q.platform : [],
    tactics: Array.isArray(q.attack?.tactics) ? q.attack.tactics : [],
    techniques: Array.isArray(q.attack?.techniques) ? q.attack.techniques.join(', ') : '',
    lookback: q.lookback || '',
    lastValidated: q.lastValidated || '',
    falsePositives: arrayToLines(q.falsePositives),
    tuningNotes: q.tuningNotes || '',
    references: arrayToLines(q.references),
    entityMappings: Array.isArray(q.entityMappings) ? q.entityMappings : [],
  };
}

/**
 * Form shape -> schema shape.
 *
 * Only emits keys the user actually filled in. A blank field must be absent rather than an
 * empty string, because validateQuery treats a present-but-invalid value as an error while
 * an absent one is simply optional — emitting '' everywhere would make every untouched
 * query fail validation.
 *
 * Invalid technique IDs are dropped here as well as flagged in the form, so a typo cannot
 * reach the validator and fail the whole save.
 */
function formToMetadata(form) {
  const out = {};
  const f = form || {};

  for (const key of ['queryType', 'severity', 'confidence', 'lookback', 'lastValidated']) {
    if (f[key]) out[key] = f[key];
  }
  if (f.tuningNotes && f.tuningNotes.trim()) out.tuningNotes = f.tuningNotes.trim();
  if (Array.isArray(f.platform) && f.platform.length) out.platform = f.platform;

  const tactics = Array.isArray(f.tactics) ? f.tactics : [];
  const techniques = commasToArray(f.techniques).filter((t) => TECHNIQUE_REGEX.test(t));
  if (tactics.length || techniques.length) {
    out.attack = {};
    if (tactics.length) out.attack.tactics = tactics;
    if (techniques.length) out.attack.techniques = techniques;
  }

  const fps = linesToArray(f.falsePositives);
  if (fps.length) out.falsePositives = fps;

  const refs = linesToArray(f.references).filter((r) => /^https?:\/\//i.test(r));
  if (refs.length) out.references = refs;

  const entities = (Array.isArray(f.entityMappings) ? f.entityMappings : [])
    .filter((m) => m && m.entityType && m.columnName && m.columnName.trim())
    .map((m) => ({
      entityType: m.entityType,
      identifier: (m.identifier || '').trim(),
      columnName: m.columnName.trim(),
    }));
  if (entities.length) out.entityMappings = entities;

  return out;
}

export { metadataToForm, formToMetadata };
