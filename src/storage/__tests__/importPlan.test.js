// ---------------------------------------------------------------------------
// planImport / diffQueryFields — the classification the import preview shows.
//
// Import used to answer "Duplicate ID" to every incoming query it already held, which is
// why a shared detection pack could be received once and never updated. These tests pin
// the three-way split that replaces it — update, older, identical — and the field-level
// diff behind it, because a bulk overwrite the user cannot inspect first is one they will
// not agree to.
//
// The timestamp rules deliberately mirror isNewer() in api/routes/queries.js. If the two
// ever disagree the preview promises a change the server then refuses, which is a worse
// failure than no preview at all.
// ---------------------------------------------------------------------------
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { planImport, readImportFile, diffQueryFields, DIFF_FIELDS } from '../useKQLStorage.js';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';

/** A stored row in the shape the API and validateQuery both produce. */
function stored(overrides = {}) {
  return {
    id: ID_A,
    name: 'Encoded PowerShell',
    query: 'DeviceProcessEvents | where ProcessCommandLine has "-enc"',
    description: 'Finds encoded command lines',
    category: 'Detection',
    table: 'DeviceProcessEvents',
    tags: ['powershell'],
    favorite: false,
    usageCount: 7,
    severity: 'Medium',
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** An incoming record, newer than the stored one unless told otherwise. */
function incoming(overrides = {}) {
  return stored({ updated: '2026-06-01T00:00:00.000Z', usageCount: 0, ...overrides });
}

const statusOf = (plan, index) => plan.byIndex.get(index).status;

describe('classifying an id collision', () => {
  it('calls a newer incoming copy an update and names the fields that move', () => {
    const plan = planImport([incoming({ name: 'Encoded PowerShell v2', severity: 'High' })], [stored()]);

    expect(plan.counts).toMatchObject({ update: 1, older: 0, identical: 0, add: 0 });
    expect(plan.byIndex.get(0).changedFields).toEqual(['name', 'severity']);
    expect(plan.byIndex.get(0).reason).toBe('Changes: name, severity');
  });

  it('calls it older when the stored copy is the newer one', () => {
    const plan = planImport(
      [incoming({ name: 'Renamed', updated: '2025-01-01T00:00:00.000Z' })],
      [stored()],
    );

    expect(plan.counts).toMatchObject({ older: 1, update: 0 });
    expect(plan.byIndex.get(0).reason).toBe('Stored copy is newer');
    // The fields are still reported: knowing what would have changed is what tells the
    // user whether to go and re-export from the other side.
    expect(plan.byIndex.get(0).changedFields).toEqual(['name']);
  });

  it('calls it identical when nothing would change, however new the timestamp is', () => {
    const plan = planImport([incoming({ updated: '2030-01-01T00:00:00.000Z' })], [stored()]);

    expect(plan.counts).toMatchObject({ identical: 1, update: 0, older: 0 });
    expect(plan.byIndex.get(0).changedFields).toEqual([]);
  });

  it('treats an equal timestamp as not newer, matching the server', () => {
    const plan = planImport([incoming({ name: 'Renamed', updated: stored().updated })], [stored()]);

    expect(statusOf(plan, 0)).toBe('older');
  });

  it('never lets an unparseable incoming timestamp win', () => {
    const plan = planImport([incoming({ name: 'Renamed', updated: 'last tuesday' })], [stored()]);

    expect(statusOf(plan, 0)).toBe('older');
  });

  it('lets a parseable incoming timestamp beat an unparseable stored one', () => {
    const plan = planImport([incoming({ name: 'Renamed' })], [stored({ updated: 'corrupt' })]);

    expect(statusOf(plan, 0)).toBe('update');
  });

  it('compares instants, so an offset timestamp does not lose to a Z one', () => {
    // 09:00+01:00 is 08:00Z — later than 07:00Z, though it sorts earlier as a string.
    const plan = planImport(
      [incoming({ name: 'Renamed', updated: '2026-02-01T09:00:00+01:00' })],
      [stored({ updated: '2026-02-01T07:00:00.000Z' })],
    );

    expect(statusOf(plan, 0)).toBe('update');
  });

  it('merges like the server does: stored created wins, usage count takes the maximum', () => {
    const plan = planImport(
      [incoming({ name: 'Renamed', created: '2026-05-05T00:00:00.000Z', usageCount: 2 })],
      [stored({ usageCount: 7 })],
    );

    expect(plan.byIndex.get(0).sanitized.created).toBe('2026-01-01T00:00:00.000Z');
    expect(plan.byIndex.get(0).sanitized.usageCount).toBe(7);
  });
});

describe('classifying everything that is not a collision', () => {
  it('adds an unseen query', () => {
    const plan = planImport([incoming({ id: ID_B, query: 'SigninLogs | take 1' })], [stored()]);

    expect(plan.counts).toMatchObject({ add: 1, update: 0 });
    expect(plan.byIndex.get(0).sanitized.id).toBe(ID_B);
  });

  it('flags a new id carrying a query body that already exists', () => {
    const plan = planImport([incoming({ id: ID_B })], [stored()]);

    expect(plan.counts).toMatchObject({ duplicate: 1, add: 0 });
    expect(plan.byIndex.get(0).reason).toBe('Duplicate query body');
  });

  it('does not mistake a resend of a known query for a duplicate body', () => {
    // Same id and same body: this is version 2 of a rule we hold, not a copy of it. The
    // body-hash check has to stand down or the update is unreachable.
    const plan = planImport([incoming({ description: 'Rewritten' })], [stored()]);

    expect(plan.counts.duplicate).toBe(0);
    expect(statusOf(plan, 0)).toBe('update');
  });

  it('reports an invalid record with the validator\'s own reason', () => {
    const plan = planImport([{ id: ID_B, name: '', query: '' }], [stored()]);

    expect(plan.counts.error).toBe(1);
    expect(plan.byIndex.get(0).reason).toMatch(/name must be a string/);
  });

  it('keeps indexes stable across a mixed file so the preview rows line up', () => {
    const plan = planImport([
      incoming({ id: ID_B, query: 'SigninLogs | take 1' }),
      { id: ID_C, name: '', query: '' },
      incoming({ name: 'Renamed' }),
    ], [stored()]);

    expect([statusOf(plan, 0), statusOf(plan, 1), statusOf(plan, 2)]).toEqual(['add', 'error', 'update']);
    expect(plan.counts.total).toBe(3);
  });

  it('catches a file that repeats an id inside itself', () => {
    // Two rows with one id would otherwise both be written to local state, and React
    // renders that as a single row flickering between two records.
    const plan = planImport([
      incoming({ id: ID_B, query: 'SigninLogs | take 1' }),
      incoming({ id: ID_B, name: 'Second copy', query: 'SigninLogs | take 2' }),
    ], [stored()]);

    expect([statusOf(plan, 0), statusOf(plan, 1)]).toEqual(['add', 'duplicate']);
    expect(plan.byIndex.get(1).reason).toBe('Repeated id in this file');
  });

  it('catches a file that repeats a query body inside itself', () => {
    const plan = planImport([
      incoming({ id: ID_B, query: 'SigninLogs | take 1' }),
      incoming({ id: ID_C, query: 'SigninLogs | take 1' }),
    ], [stored()]);

    expect([statusOf(plan, 0), statusOf(plan, 1)]).toEqual(['add', 'duplicate']);
    expect(plan.byIndex.get(1).reason).toBe('Duplicate query body');
  });

  it('returns an empty plan for anything that is not an array', () => {
    expect(planImport(null, [stored()]).counts.total).toBe(0);
    expect(planImport(undefined, undefined).items).toEqual([]);
  });
});

describe('diffQueryFields', () => {
  it('reports fields in a fixed order rather than object order', () => {
    const fields = diffQueryFields(
      { ...stored(), severity: 'High', name: 'Other', tags: ['a'] },
      stored(),
    );

    expect(fields).toEqual(['name', 'tags', 'severity']);
  });

  it('sees into the nested detection block', () => {
    const fields = diffQueryFields(
      { ...stored(), attack: { tactics: ['execution'], techniques: ['T1059.001'] } },
      { ...stored(), attack: { tactics: ['execution'] } },
    );

    expect(fields).toEqual(['attack']);
  });

  it('ignores key order inside a nested object', () => {
    const fields = diffQueryFields(
      { ...stored(), attack: { techniques: ['T1059'], tactics: ['execution'] } },
      { ...stored(), attack: { tactics: ['execution'], techniques: ['T1059'] } },
    );

    expect(fields).toEqual([]);
  });

  it('treats the several spellings of "not set" as the same', () => {
    const fields = diffQueryFields(
      { ...stored(), tags: [], description: '', attack: { tactics: [] }, references: null },
      { ...stored(), tags: undefined, description: undefined, attack: undefined, references: [] },
    );

    expect(fields).toEqual([]);
  });

  it('does not report bookkeeping fields as content changes', () => {
    // created and updated always differ on a re-export, and usageCount is a local counter
    // the server merges by taking the larger value. Reporting either would mark every
    // single row as changed and the diff would stop being read.
    const fields = diffQueryFields(
      { ...stored(), created: '2020-01-01T00:00:00.000Z', updated: '2030-01-01T00:00:00.000Z', usageCount: 999 },
      stored(),
    );

    expect(fields).toEqual([]);
  });

  it('does report a favourite flag, which an upsert would overwrite', () => {
    expect(diffQueryFields({ ...stored(), favorite: true }, stored())).toEqual(['favorite']);
  });

  it('returns nothing when either side is missing', () => {
    expect(diffQueryFields(null, stored())).toEqual([]);
    expect(diffQueryFields(stored(), undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DIFF_FIELDS is a hand-maintained list, and the upsert path is the one place in the app
// where one record silently replaces another. A field that validateQuery stores but
// DIFF_FIELDS does not compare is invisible twice over: the preview will not warn that it
// moves, and a row differing only in that field is classified `identical` and never
// offered as an update at all. Schema v4 added seventeen fields in one commit; v5 will add
// more, and nothing else in the suite would notice one being missed.
//
// The list is recovered from the validator's source rather than from a fixture on purpose:
// a fixture only exercises the fields somebody remembered to put in it, which is the same
// omission this guard exists to catch.
// ---------------------------------------------------------------------------
describe('DIFF_FIELDS covers everything the validator stores', () => {
  // Bookkeeping, deliberately never diffed. `id` is the join key, `created`/`updated` are
  // facts about the row rather than its content, and `usageCount` is a local counter both
  // sides merge by taking the larger value.
  const BOOKKEEPING = ['id', 'created', 'updated', 'usageCount'];

  /** Every key validateQuery can write, read off the assignments in its own source. */
  function fieldsWrittenByValidator() {
    const source = readFileSync(
      fileURLToPath(new URL('../../domain/validate.js', import.meta.url)),
      'utf8',
    );
    const found = new Set();
    // `sanitized.name = ...` and `out.attack = ...` — the direct assignments. The trailing
    // [^=] keeps `===` comparisons out of the match.
    for (const m of source.matchAll(/\b(?:sanitized|out)\.([A-Za-z][A-Za-z0-9]*)\s*=[^=]/g)) found.add(m[1]);
    // `set('severity', ...)` — the detection block's conditional writer.
    for (const m of source.matchAll(/\bset\(\s*'([A-Za-z][A-Za-z0-9]*)'/g)) found.add(m[1]);
    // `for (const field of ['author', 'license'])` — written through a computed key, so
    // the field names only exist in the loop's array literal.
    for (const m of source.matchAll(/for \(const field of \[([^\]]+)\]\)/g)) {
      for (const f of m[1].matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g)) found.add(f[1]);
    }
    return found;
  }

  it('diffs every stored field that is not bookkeeping', () => {
    const written = fieldsWrittenByValidator();
    // A sanity check on the extraction itself: if this trips, the regexes have stopped
    // matching how validate.js is written and the assertion below proves nothing.
    expect(written.size).toBeGreaterThan(20);

    const shouldDiff = [...written].filter((f) => !BOOKKEEPING.includes(f)).sort();

    expect([...DIFF_FIELDS].sort()).toEqual(shouldDiff);
  });

  it('names no field the validator would never store', () => {
    const written = fieldsWrittenByValidator();

    expect(DIFF_FIELDS.filter((f) => !written.has(f))).toEqual([]);
  });
});

describe('readImportFile', () => {
  it('accepts a bare array', () => {
    expect(readImportFile(JSON.stringify([stored()])).queries).toHaveLength(1);
  });

  it('accepts a versioned blob and runs it through the migration chain', () => {
    const file = readImportFile(JSON.stringify({
      schemaVersion: 3,
      queries: [{ ...stored(), tags: ['t1059.001', 'powershell'] }],
    }));

    // v3 -> v4 promotes an ATT&CK technique smuggled into a tag.
    expect(file.queries[0].attack).toEqual({ techniques: ['T1059.001'] });
    expect(file.queries[0].tags).toEqual(['powershell']);
  });

  it('refuses a file from a newer build instead of downgrading it', () => {
    const file = readImportFile(JSON.stringify({ schemaVersion: 99, queries: [stored()] }));

    expect(file.queries).toBeUndefined();
    expect(file.error).toMatch(/newer version of KQL Store \(schema v99\)/);
  });

  it('reports invalid JSON verbatim', () => {
    expect(readImportFile('{ not json').error).toMatch(/^Invalid JSON:/);
  });

  it('rejects a document that holds no queries array', () => {
    expect(readImportFile(JSON.stringify({ hello: 'world' })).error).toMatch(/Expected an array of queries/);
  });
});
