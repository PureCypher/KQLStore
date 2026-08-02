import { describe, it, expect } from 'vitest';
import { validateQuery } from '../validate.js';
import { migrateData } from '../migrate.js';
import { detectTableFromQuery, getTableGroup, getTableDisplayName } from '../tables.js';
import { simpleHash } from '../hash.js';
import { safeJsonParse, stripDangerousKeys } from '../../lib/json.js';
import { CURRENT_SCHEMA_VERSION } from '../../constants.js';

const uuid = () => '3f2b1c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d';
const valid = (over = {}) => ({
  id: uuid(), name: 'Test', query: 'SigninLogs | take 5', table: 'SigninLogs', ...over,
});

describe('validateQuery', () => {
  it('accepts a well-formed query and reports no errors', () => {
    const r = validateQuery(valid());
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.sanitized.name).toBe('Test');
  });

  it('rejects a non-UUID id', () => {
    const r = validateQuery(valid({ id: 'not-a-uuid' }));
    expect(r.valid).toBe(false);
    expect(r.sanitized).toBeNull();
  });

  it('drops unknown fields rather than storing them', () => {
    const r = validateQuery(valid({ evil: 'payload', __proto__: { polluted: true } }));
    expect(r.sanitized).not.toHaveProperty('evil');
  });

  it('caps tags at 20 and drops non-strings', () => {
    const r = validateQuery(valid({ tags: [...Array(50).keys()].map(String).concat([1, null]) }));
    expect(r.sanitized.tags.length).toBe(20);
    expect(r.sanitized.tags.every((t) => typeof t === 'string')).toBe(true);
  });

  it('coerces an unknown category to Utility and flags it', () => {
    const r = validateQuery(valid({ category: 'Nonsense' }));
    expect(r.sanitized.category).toBe('Utility');
    expect(r.valid).toBe(false);
  });

  it('rejects an over-long query body', () => {
    expect(validateQuery(valid({ query: 'x'.repeat(50001) })).sanitized).toBeNull();
  });
});

describe('stripDangerousKeys', () => {
  it('removes prototype-polluting keys at every depth, including through arrays', () => {
    const parsed = JSON.parse('{"a":{"__proto__":{"x":1},"b":[{"constructor":1},{"prototype":2}]}}');
    const clean = stripDangerousKeys(parsed);
    expect(JSON.stringify(clean)).not.toContain('__proto__');
    expect(JSON.stringify(clean)).not.toContain('constructor');
    expect(JSON.stringify(clean)).not.toContain('prototype');
  });

  it('does not pollute Object.prototype via a crafted payload', () => {
    safeJsonParse('{"__proto__":{"polluted":"yes"}}');
    expect({}.polluted).toBeUndefined();
  });
});

describe('safeJsonParse', () => {
  it('reports failure rather than throwing on malformed JSON', () => {
    const r = safeJsonParse('{not json');
    expect(r.ok).toBe(false);
    expect(r.data).toBeNull();
  });

  it('rejects a non-object payload', () => {
    expect(safeJsonParse('"a string"').ok).toBe(false);
  });
});

describe('migrateData', () => {
  it('migrates a v1 blob to the current schema', () => {
    const r = migrateData({ schemaVersion: 1, queries: [{ id: 'a', name: 'n', query: 'SigninLogs | take 1', category: 'Threat Hunting' }] });
    expect(r.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(r.queries[0].category).toBe('Hunting');
    expect(r.queries[0]).not.toHaveProperty('severity');
  });

  it('is idempotent', () => {
    const once = migrateData({ schemaVersion: 1, queries: [{ id: 'a', name: 'n', query: 'Syslog | take 1' }] });
    const twice = migrateData(once);
    expect(twice.queries).toEqual(once.queries);
  });

  it('returns null for a non-object', () => {
    expect(migrateData(null)).toBeNull();
    expect(migrateData('nope')).toBeNull();
  });
});

describe('detectTableFromQuery', () => {
  it.each([
    ['SigninLogs\n| take 5', 'SigninLogs'],
    ['DeviceProcessEvents | where X == 1', 'DeviceProcessEvents'],
    ['// a comment\nSyslog | take 1', 'Syslog'],
    ['MyCustomLog_CL | take 1', 'Custom:MyCustomLog_CL'],
  ])('detects %s', (input, expected) => {
    expect(detectTableFromQuery(input)).toBe(expected);
  });

  it('falls back to Custom for empty or non-string input', () => {
    expect(detectTableFromQuery('')).toBe('Custom');
    expect(detectTableFromQuery(null)).toBe('Custom');
  });
});

describe('table helpers', () => {
  it('groups known tables by product', () => {
    expect(getTableGroup('SigninLogs')).toBe('sentinel');
    expect(getTableGroup('DeviceProcessEvents')).toBe('defender');
    expect(getTableGroup('Custom:Sysmon_CL')).toBe('custom');
    expect(getTableGroup(null)).toBe('custom');
  });

  it('strips the Custom: prefix for display', () => {
    expect(getTableDisplayName('Custom:Sysmon_CL')).toBe('Sysmon_CL');
    expect(getTableDisplayName('SigninLogs')).toBe('SigninLogs');
  });
});

describe('simpleHash', () => {
  it('is stable and differs for different inputs', () => {
    expect(simpleHash('abc')).toBe(simpleHash('abc'));
    expect(simpleHash('abc')).not.toBe(simpleHash('abd'));
  });
});

// ---------------------------------------------------------------------------
// Fork lineage.
//
// The SPA is deliberately stricter than the API here. The API bounds parentId at
// LIMITS.id and accepts any string, because it has no opinion about id formats. The SPA
// requires a UUID, because validateQuery already refuses a non-UUID `id` outright — so a
// non-UUID parentId could never resolve to a query in this store, and keeping it would
// render a fork badge pointing at something that cannot exist.
//
// A bad pointer is dropped rather than failing the record. The fork's own content is
// still valid and still worth storing, and an unusable pointer to an ancestor is exactly
// as recoverable as no pointer at all.
// ---------------------------------------------------------------------------
describe('lineage validation', () => {
  const parentUuid = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

  it('keeps a valid parentId and parentName', () => {
    const r = validateQuery(valid({ parentId: parentUuid, parentName: 'Entra risky sign-in' }));
    expect(r.valid).toBe(true);
    expect(r.sanitized.parentId).toBe(parentUuid);
    expect(r.sanitized.parentName).toBe('Entra risky sign-in');
  });

  it('defaults to null and an empty string when absent', () => {
    const r = validateQuery(valid());
    expect(r.sanitized.parentId).toBeNull();
    expect(r.sanitized.parentName).toBe('');
  });

  it('drops a non-UUID parentId without failing the record', () => {
    const r = validateQuery(valid({ parentId: 'not-a-uuid' }));
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.sanitized.parentId).toBeNull();
  });

  it('drops a non-string parentId', () => {
    expect(validateQuery(valid({ parentId: 42 })).sanitized.parentId).toBeNull();
    expect(validateQuery(valid({ parentId: { id: parentUuid } })).sanitized.parentId).toBeNull();
  });

  it('clears parentName when the pointer it belongs to was dropped', () => {
    // The two are a pair: the badge only renders when parentId is set, so a surviving
    // parentName would be invisible dead weight in every future round-trip.
    const r = validateQuery(valid({ parentId: 'not-a-uuid', parentName: 'Orphaned label' }));
    expect(r.sanitized.parentId).toBeNull();
    expect(r.sanitized.parentName).toBe('');
  });

  it('trims and truncates an over-long parentName rather than rejecting', () => {
    const r = validateQuery(valid({ parentId: parentUuid, parentName: `  ${'x'.repeat(300)}  ` }));
    expect(r.valid).toBe(true);
    expect(r.sanitized.parentName).toHaveLength(200);
  });

  it('accepts a parentId that resolves to nothing — resolvability is not its job', () => {
    const r = validateQuery(valid({ parentId: parentUuid, parentName: 'Deleted parent' }));
    expect(r.sanitized.parentId).toBe(parentUuid);
  });

  it('detection metadata cannot shadow lineage', () => {
    // Mirrors the same guard on the API's toFrontend: whatever else is merged into the
    // sanitized record, the lineage fields are written last and win.
    const r = validateQuery(valid({
      parentId: parentUuid, parentName: 'Real', severity: 'High',
    }));
    expect(r.sanitized.parentId).toBe(parentUuid);
    expect(r.sanitized.severity).toBe('High');
  });
});
