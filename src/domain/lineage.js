// ============================================================
// Fork lineage
//
// Lineage is stored one generation deep — a query knows its parent and nothing else.
// Everything below works with that single generation directly: nothing here walks a
// parent chain, so there is no multi-generation cycle to guard against. (A prior version
// of this module had a bounded ancestry walker for that; it had no production caller and
// was removed rather than kept as unused API surface — see git history if a future task
// needs multi-generation ancestry again.)
// ============================================================

/**
 * Build a fork of `parent`. Pure — it neither mutates the parent nor touches storage.
 *
 * A fork inherits every field from its parent (including schema v4 detection metadata like
 * severity, attack tactics, dataSources, etc.), then overrides the following:
 *   - id: the newId argument (a brand-new fork must have a brand-new identity)
 *   - created / updated: the nowIso argument (fork timestamp, not parent's)
 *   - usageCount: 0 (usage stats are facts about the original; a fresh fork has no history)
 *   - favorite: false (favoriting is a personal preference on the original)
 *   - parentId: parent.id (fork records who it came from)
 *   - parentName: parent.name (snapshot of parent's name at fork time, in case parent is renamed)
 *   - tags: a fresh array (never alias the parent's array)
 *
 * The deep copy ensures that nested objects (e.g. attack.tactics) do not get aliased,
 * so mutating the fork's metadata does not corrupt the parent.
 */
export function makeFork(parent, newId, nowIso) {
  // Deep copy to prevent aliasing of nested objects. structuredClone handles complex
  // objects (arrays, objects, Dates, Maps, etc.) and is safe for our data shapes.
  const fork = structuredClone(parent);

  // Override the fields that define a new fork's identity and state.
  fork.id = newId;
  fork.created = nowIso;
  fork.updated = nowIso;
  fork.usageCount = 0;
  fork.favorite = false;
  fork.parentId = parent.id;
  fork.parentName = parent.name;
  // tags was already deep-copied, so this is safe.
  fork.tags = [...(parent.tags || [])];

  return fork;
}

/** id → query. */
export function indexById(queries) {
  return new Map(queries.map((q) => [q.id, q]));
}

/** parent id → child ids, in the order given. Parents with no forks are absent. */
export function childrenOf(queries) {
  const map = new Map();
  for (const q of queries) {
    if (!q.parentId) continue;
    const bucket = map.get(q.parentId);
    if (bucket) bucket.push(q.id);
    else map.set(q.parentId, [q.id]);
  }
  return map;
}

/** A fork whose parent is no longer in the store. Never a fork-less query. */
export function isOrphan(query, byId) {
  return Boolean(query.parentId) && !byId.has(query.parentId);
}

/**
 * Predicate for the sidebar's lineage filter. `null` means no filter and passes
 * everything, so the caller does not need a special case.
 */
export function matchesLineageFilter(query, filter, forkIndex, byId) {
  if (!filter) return true;
  if (filter === 'forks') return Boolean(query.parentId);
  if (filter === 'parents') return (forkIndex.get(query.id) || []).length > 0;
  if (filter === 'orphans') return isOrphan(query, byId);
  return true;
}
