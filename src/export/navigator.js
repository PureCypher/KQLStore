// ============================================================
// MITRE ATT&CK Navigator layer export.
//
// This is the artefact that answers "what is my coverage?" — the question a detection
// library exists to answer and that this tool previously could not, because technique IDs
// lived in unvalidated free-text tags. Drop the file into the Navigator to see the store
// projected onto the matrix.
// ============================================================

const LAYER_VERSION = '4.5';
const NAVIGATOR_VERSION = '4.9.0';
const ATTACK_VERSION = '14';

/**
 * Build a Navigator layer from the store.
 *
 * Score is the number of queries mapped to each technique, so the heat map reads as depth
 * of coverage rather than a flat yes/no. The comment lists the contributing query names,
 * which is what makes a hot cell actionable when you click it.
 */
function toNavigatorLayer(queries, { name = 'KQL Store coverage', description } = {}) {
  const byTechnique = new Map();

  for (const q of queries) {
    for (const id of q?.attack?.techniques ?? []) {
      if (!byTechnique.has(id)) byTechnique.set(id, []);
      byTechnique.get(id).push(q.name);
    }
  }

  const techniques = [...byTechnique.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([techniqueID, names]) => ({
      techniqueID,
      score: names.length,
      comment: names.join('\n'),
      enabled: true,
    }));

  const maxScore = techniques.reduce((m, t) => Math.max(m, t.score), 0);

  return {
    name,
    versions: { attack: ATTACK_VERSION, navigator: NAVIGATOR_VERSION, layer: LAYER_VERSION },
    domain: 'enterprise-attack',
    description:
      description
      ?? `Generated from KQL Store: ${techniques.length} technique(s) across ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}.`,
    filters: { platforms: platformsIn(queries) },
    sorting: 3,
    layout: { layout: 'side', showID: true, showName: true },
    hideDisabled: false,
    techniques,
    // A single-stop gradient renders every covered cell identically, which hides depth.
    gradient: {
      colors: ['#a1d99b', '#31a354'],
      minValue: maxScore > 0 ? 1 : 0,
      maxValue: Math.max(maxScore, 1),
    },
    legendItems: [
      { label: 'Covered by at least one query', color: '#a1d99b' },
      { label: 'Covered by several queries', color: '#31a354' },
    ],
    showTacticRowBackground: true,
    tacticRowBackground: '#205b8f',
    selectTechniquesAcrossTactics: true,
  };
}

/** Navigator's platform filter uses its own vocabulary; map only what we can state truthfully. */
const PLATFORM_TO_NAVIGATOR = {
  Windows: 'Windows',
  Linux: 'Linux',
  macOS: 'macOS',
  Azure: 'Azure AD',
  AWS: 'IaaS',
  GCP: 'IaaS',
  Office365: 'Office 365',
  Identity: 'Azure AD',
  Network: 'Network',
};

function platformsIn(queries) {
  const out = new Set();
  for (const q of queries) {
    for (const p of q?.platform ?? []) {
      const mapped = PLATFORM_TO_NAVIGATOR[p];
      if (mapped) out.add(mapped);
    }
  }
  // An empty filter list means "no platforms", not "all", so omit the filter entirely
  // by returning the full default set when the store says nothing.
  return out.size > 0
    ? [...out].sort()
    : ['Windows', 'Linux', 'macOS', 'Azure AD', 'Office 365', 'IaaS', 'Network'];
}

/** Techniques referenced by the store, for a quick coverage summary in the UI. */
function coverageSummary(queries) {
  const techniques = new Set();
  const tactics = new Set();
  let mapped = 0;
  for (const q of queries) {
    const t = q?.attack?.techniques ?? [];
    const ta = q?.attack?.tactics ?? [];
    if (t.length || ta.length) mapped++;
    t.forEach((x) => techniques.add(x));
    ta.forEach((x) => tactics.add(x));
  }
  return {
    totalQueries: queries.length,
    mappedQueries: mapped,
    unmappedQueries: queries.length - mapped,
    uniqueTechniques: techniques.size,
    uniqueTactics: tactics.size,
  };
}

export { toNavigatorLayer, coverageSummary, PLATFORM_TO_NAVIGATOR };
