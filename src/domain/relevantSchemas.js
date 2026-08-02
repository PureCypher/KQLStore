// ============================================================
// Which stored schemas accompany an AI chat request.
//
// The store holds hundreds of tables (~half a megabyte with columns and notes), and the
// panel used to send all of them on every turn — most of it never relevant to the
// conversation. A table earns its full schema by being NAMED: in the draft's table field,
// its query text, or any chat message. Everything else contributes only its name, which
// the AI service renders as a compact known-tables line so the model can still answer
// "which table should I use?" by name — naming one in the next message pulls in its
// columns.
// ============================================================

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {Array<{name: string}>} schemas the full schema store
 * @param {{name?: string, description?: string, query?: string, table?: string}|null} draft
 * @param {Array<{content?: string}>|undefined} messages the conversation so far
 * @returns {{relevant: Array<object>, otherNames: string[]}} store order is preserved
 */
export function selectRelevantSchemas(schemas, draft, messages) {
  if (!Array.isArray(schemas) || schemas.length === 0) return { relevant: [], otherNames: [] };

  const blob = [
    draft?.table, draft?.query, draft?.name, draft?.description,
    ...(Array.isArray(messages) ? messages.map((m) => m?.content) : []),
  ].filter((s) => typeof s === 'string' && s).join('\n');

  const relevant = [];
  const otherNames = [];
  for (const schema of schemas) {
    if (typeof schema?.name !== 'string' || !schema.name) continue;
    // Custom boundaries instead of \b: table names legally contain underscores and
    // hyphens ("meraki_CL", dotted JSON imports), and \b splits on those.
    const pattern = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegex(schema.name)}($|[^A-Za-z0-9_-])`, 'i');
    if (pattern.test(blob)) relevant.push(schema);
    else otherNames.push(schema.name);
  }
  return { relevant, otherNames };
}
