# Fork Lineage and Schema Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record which queries were forked from which, and add an editable, runtime-mutable store of table schemas — both without any AI involvement.

**Architecture:** Two additive SQLite columns (`parent_id`, `parent_name`) with no foreign key, plus one new independent table (`table_schemas`) and its REST routes. Lineage traversal is a pure client-side module over the store the SPA already holds. The existing table constants in `src/constants.js` and their six consumers are not touched.

**Tech Stack:** Express 5, better-sqlite3 13, React 19, esbuild, Tailwind 4. API tests run under `node --test`; SPA tests run under vitest.

## Global Constraints

- **No new npm dependencies** in either `package.json` or `api/package.json`. Node 24 has `fetch` and `crypto` built in.
- API runtime is `>=20 <25` (`api/package.json`). SPA engines floor is `>=20`.
- Every new query field needs a validator in **both** `src/domain/validate.js` and `api/validate.js`. This is a known duplication; do not attempt to unify it in this plan.
- Coverage thresholds are enforced in CI on `src/domain/**` and `src/lib/**` only: lines 80, functions 80, branches 75 (`vitest.config.js`). New pure modules land in `src/domain/` and must clear this bar.
- API tests are plain `node --test` with no test framework and no supertest — use `api/test/helpers.js` (`useTempDatabase`, `startServer`, `api`, `makeQuery`).
- `api/db.js` opens its database at `require()` time from `DB_PATH`, so `useTempDatabase()` must run **before** anything requires `../app`.
- SQLite migrations are additive only, guarded by a `pragma_table_info` count check. Never rewrite the `queries` table.
- `SCHEMA_VERSION` in `api/validate.js` must continue to track `CURRENT_SCHEMA_VERSION` in `src/constants.js`. Neither changes in this plan — lineage is not a schema version bump because it is not part of the exported query contract.
- Commit after every task. Conventional commit format (`feat:`, `fix:`, `docs:`, `test:`).

---

### Task 1: Lineage columns and migration

**Files:**
- Modify: `api/db.js:47-58` (after the existing `metadata` migration block)
- Test: `api/test/lineage-migration.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: columns `parent_id TEXT DEFAULT NULL` and `parent_name TEXT DEFAULT ''` on the `queries` table.

- [ ] **Step 1: Write the failing test**

```javascript
// api/test/lineage-migration.test.js
const test = require('node:test');
const assert = require('node:assert');
const { useTempDatabase } = require('./helpers');

useTempDatabase();

test('adds parent_id and parent_name columns', () => {
  const db = require('../db');
  const cols = db.prepare("SELECT name FROM pragma_table_info('queries')").all().map((c) => c.name);
  assert.ok(cols.includes('parent_id'), 'parent_id column missing');
  assert.ok(cols.includes('parent_name'), 'parent_name column missing');
});

test('parent_id defaults to NULL and parent_name to empty string', () => {
  const db = require('../db');
  db.prepare(`
    INSERT INTO queries (id, name, query, created, updated)
    VALUES ('t1', 'n', 'q', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
  `).run();
  const row = db.prepare('SELECT parent_id, parent_name FROM queries WHERE id = ?').get('t1');
  assert.strictEqual(row.parent_id, null);
  assert.strictEqual(row.parent_name, '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test test/lineage-migration.test.js`
Expected: FAIL — "parent_id column missing"

- [ ] **Step 3: Write minimal implementation**

Append to `api/db.js`, immediately after the existing `hasMetadata` block and before `module.exports`:

```javascript
// Fork lineage. Deliberately NOT a foreign key: deleting the query you forked from must
// neither cascade to the fork nor block the deletion, so an unresolvable parent_id is a
// display state ("forked from a query that no longer exists"), not an integrity error.
// SQLite also forbids REFERENCES in ALTER TABLE ADD COLUMN, so this is the only path.
//
// parent_name is a snapshot of the parent's name at fork time, not a cache. It is what
// lets an orphaned fork still say what it came from. Going stale is correct behaviour.
const lineageColumns = [
  ['parent_id', 'TEXT DEFAULT NULL'],
  ['parent_name', "TEXT DEFAULT ''"],
];
for (const [name, definition] of lineageColumns) {
  const present = db
    .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('queries') WHERE name = ?")
    .get(name).n > 0;
  if (!present) {
    db.prepare(`ALTER TABLE queries ADD COLUMN ${name} ${definition}`).run();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && node --test test/lineage-migration.test.js`
Expected: PASS, 2 tests

- [ ] **Step 5: Verify the migration is idempotent against an existing database**

Run: `cd api && node --test "test/**/*.test.js"`
Expected: PASS — every existing test creates its database through the same `db.js`, so a broken guard shows up as a failure across the whole suite rather than only here.

- [ ] **Step 6: Commit**

```bash
git add api/db.js api/test/lineage-migration.test.js
git commit -m "feat(api): add parent_id and parent_name columns for fork lineage"
```

---

### Task 2: Server-side lineage validation

**Files:**
- Modify: `api/validate.js` — `LIMITS` (line 23), `validateQueryPayload` (line 127)
- Test: `api/test/validate.test.js` (extend existing)

**Interfaces:**
- Consumes: `checkString`, `badRequest`, `LIMITS` from Task 1's untouched module.
- Produces: `validateQueryPayload` now returns `parentId` (string, ≤200) and `parentName` (string, ≤200) when present.

- [ ] **Step 1: Write the failing test**

Append to `api/test/validate.test.js`:

```javascript
test('accepts parentId and parentName', () => {
  const out = validateQueryPayload({
    name: 'n', query: 'q', parentId: 'abc-123', parentName: 'Entra risky sign-in',
  });
  assert.strictEqual(out.parentId, 'abc-123');
  assert.strictEqual(out.parentName, 'Entra risky sign-in');
});

test('omits lineage fields when absent', () => {
  const out = validateQueryPayload({ name: 'n', query: 'q' });
  assert.ok(!('parentId' in out));
  assert.ok(!('parentName' in out));
});

test('rejects a parentId over the id limit', () => {
  assert.throws(
    () => validateQueryPayload({ name: 'n', query: 'q', parentId: 'x'.repeat(201) }),
    /"parentId" exceeds 200 characters/,
  );
});

test('rejects a non-string parentId', () => {
  assert.throws(
    () => validateQueryPayload({ name: 'n', query: 'q', parentId: 42 }),
    /"parentId" must be a string/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test test/validate.test.js`
Expected: FAIL — `out.parentId` is `undefined`

- [ ] **Step 3: Write minimal implementation**

In `api/validate.js`, inside `validateQueryPayload`, immediately before the `metadata` block:

```javascript
  // Lineage. Bounded by LIMITS.id because parentId holds the same kind of value the id
  // column does, and by LIMITS.name for the snapshot, which mirrors a name.
  const parentId = checkString(body.parentId, 'parentId', LIMITS.id, { required: false });
  if (parentId !== undefined) out.parentId = parentId;

  const parentName = checkString(body.parentName, 'parentName', LIMITS.name, { required: false });
  if (parentName !== undefined) out.parentName = parentName;
```

No `LIMITS` change is needed — `LIMITS.id` is already 200 and `LIMITS.name` is already 200.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && node --test test/validate.test.js`
Expected: PASS

- [ ] **Step 5: Confirm lineage did not leak into the metadata blob**

Add to `api/test/validate.test.js`:

```javascript
test('lineage is not folded into the metadata document', () => {
  const out = validateQueryPayload({
    name: 'n', query: 'q', parentId: 'abc-123', severity: 'High',
  });
  const metadata = JSON.parse(out.metadata);
  assert.ok(!('parentId' in metadata), 'parentId must not enter the v4 metadata blob');
  assert.strictEqual(metadata.severity, 'High');
});
```

Run: `cd api && node --test test/validate.test.js`
Expected: PASS. If it fails, `collectMetadata` in `api/validate.js:93` is picking lineage up — add `parentId` and `parentName` to its exclusion set.

- [ ] **Step 6: Commit**

```bash
git add api/validate.js api/test/validate.test.js
git commit -m "feat(api): validate parentId and parentName on the write path"
```

---

### Task 3: Persist lineage through the API

**Files:**
- Modify: `api/routes/queries.js` — `toFrontend` (line ~44), POST insert (line ~293), PUT update (line ~354), import statements (line ~177)
- Test: `api/test/lineage.test.js` (create)

**Interfaces:**
- Consumes: `validateQueryPayload` returning `parentId`/`parentName` (Task 2).
- Produces: `GET /api/queries` returns `parentId` (string or `null`) and `parentName` (string) on every record.

- [ ] **Step 1: Write the failing test**

```javascript
// api/test/lineage.test.js
const test = require('node:test');
const assert = require('node:assert');
const { useTempDatabase, startServer, api, makeQuery } = require('./helpers');

useTempDatabase();
const app = require('../app');

let server;
test.before(async () => { server = await startServer(app); });
test.after(async () => { await server.close(); });

test('round-trips lineage through create and list', async () => {
  const parent = await api(server.url, '/api/queries', { method: 'POST', body: makeQuery() });
  assert.strictEqual(parent.status, 201);

  const fork = await api(server.url, '/api/queries', {
    method: 'POST',
    body: makeQuery({
      name: 'Okta variant',
      parentId: parent.body.id,
      parentName: parent.body.name,
    }),
  });
  assert.strictEqual(fork.status, 201);
  assert.strictEqual(fork.body.parentId, parent.body.id);
  assert.strictEqual(fork.body.parentName, 'Failed sign-ins');

  const list = await api(server.url, '/api/queries');
  const listed = list.body.find((q) => q.id === fork.body.id);
  assert.strictEqual(listed.parentId, parent.body.id);
});

test('a query with no parent reports parentId null', async () => {
  const res = await api(server.url, '/api/queries', { method: 'POST', body: makeQuery({ name: 'Standalone' }) });
  assert.strictEqual(res.body.parentId, null);
  assert.strictEqual(res.body.parentName, '');
});

test('deleting a parent leaves the fork intact and orphaned', async () => {
  const parent = await api(server.url, '/api/queries', { method: 'POST', body: makeQuery({ name: 'Doomed' }) });
  const fork = await api(server.url, '/api/queries', {
    method: 'POST',
    body: makeQuery({ name: 'Survivor', parentId: parent.body.id, parentName: 'Doomed' }),
  });

  const del = await api(server.url, `/api/queries/${parent.body.id}`, { method: 'DELETE' });
  assert.strictEqual(del.status, 200);

  const after = await api(server.url, `/api/queries/${fork.body.id}`);
  assert.strictEqual(after.status, 200, 'fork must survive its parent');
  assert.strictEqual(after.body.parentId, parent.body.id, 'dangling parentId is retained deliberately');
  assert.strictEqual(after.body.parentName, 'Doomed', 'snapshot name survives the parent');
});

test('lineage survives an import round-trip', async () => {
  const res = await api(server.url, '/api/queries/import', {
    method: 'POST',
    body: {
      queries: [makeQuery({
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Imported fork',
        parentId: '22222222-2222-4222-8222-222222222222',
        parentName: 'Imported parent',
      })],
    },
  });
  assert.strictEqual(res.status, 200);
  const got = await api(server.url, '/api/queries/11111111-1111-4111-8111-111111111111');
  assert.strictEqual(got.body.parentId, '22222222-2222-4222-8222-222222222222');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test test/lineage.test.js`
Expected: FAIL — `fork.body.parentId` is `undefined`

- [ ] **Step 3: Write minimal implementation**

In `api/routes/queries.js`, in `toFrontend`, after the `usageCount` line and **before** the `...parseMetadata(row.metadata)` spread (so a malformed metadata blob can never shadow lineage):

```javascript
    parentId: row.parent_id ?? null,
    parentName: row.parent_name ?? '',
```

In the import `INSERT` (line ~177) add the columns and bindings:

```javascript
      INSERT INTO queries (id, name, query, description, category, table_name, tags, favorite, usage_count, metadata, parent_id, parent_name, created, updated)
      VALUES (@id, @name, @query, @description, @category, @table_name, @tags, @favorite, @usage_count, @metadata, @parent_id, @parent_name, @created, @updated)
```

In the import `UPDATE` (line ~180) add:

```javascript
          parent_id   = @parent_id,
          parent_name = @parent_name,
```

Wherever the import builds its named-parameter object, add:

```javascript
      parent_id: v.parentId ?? null,
      parent_name: v.parentName ?? '',
```

In the POST `INSERT` (line ~293) add `parent_id, parent_name` to the column list, two more `?` placeholders in the same positions, and these two bindings immediately after the `metadata` binding:

```javascript
      v.parentId ?? null,
      v.parentName ?? '',
```

In the PUT `UPDATE` (line ~354) add to the `SET` clause after `metadata`:

```javascript
          parent_id   = ?,
          parent_name = ?,
```

and the matching bindings, following the `?? existing.` pattern the other fields use:

```javascript
      parentId ?? existing.parent_id ?? null,
      parentName ?? existing.parent_name ?? '',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && node --test test/lineage.test.js`
Expected: PASS, 4 tests

- [ ] **Step 5: Run the whole API suite for regressions**

Run: `cd api && node --test "test/**/*.test.js"`
Expected: PASS. The import and concurrency suites exercise the same statements — a mismatched placeholder count fails loudly here.

- [ ] **Step 6: Commit**

```bash
git add api/routes/queries.js api/test/lineage.test.js
git commit -m "feat(api): persist and return fork lineage on all query routes"
```

---

### Task 4: Client-side lineage validation

**Files:**
- Modify: `src/domain/validate.js` — `validateQuery` (line ~174)
- Test: `src/domain/__tests__/domain.test.js` (extend existing)

**Interfaces:**
- Consumes: nothing from earlier tasks — this is the SPA's independent implementation.
- Produces: `validateQuery(q).sanitized` carries `parentId` (string or `null`) and `parentName` (string).

- [ ] **Step 1: Write the failing test**

Append to `src/domain/__tests__/domain.test.js`:

```javascript
describe('lineage validation', () => {
  const base = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Fork', query: 'SigninLogs | take 1', table: 'SigninLogs',
  };

  it('keeps a valid parentId and parentName', () => {
    const { sanitized } = validateQuery({
      ...base,
      parentId: '22222222-2222-4222-8222-222222222222',
      parentName: 'Entra risky sign-in',
    });
    expect(sanitized.parentId).toBe('22222222-2222-4222-8222-222222222222');
    expect(sanitized.parentName).toBe('Entra risky sign-in');
  });

  it('defaults to null and empty string when absent', () => {
    const { sanitized } = validateQuery(base);
    expect(sanitized.parentId).toBeNull();
    expect(sanitized.parentName).toBe('');
  });

  it('drops a non-UUID parentId without failing the record', () => {
    const { valid, sanitized } = validateQuery({ ...base, parentId: 'not-a-uuid' });
    expect(sanitized.parentId).toBeNull();
    expect(valid).toBe(true);
  });

  it('truncates an over-long parentName rather than rejecting', () => {
    const { sanitized } = validateQuery({ ...base, parentName: 'x'.repeat(300) });
    expect(sanitized.parentName).toHaveLength(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/__tests__/domain.test.js`
Expected: FAIL — `sanitized.parentId` is `undefined`

- [ ] **Step 3: Write minimal implementation**

In `src/domain/validate.js`, inside `validateQuery`, after the `usageCount` block:

```javascript
  // Lineage. A malformed parent reference is dropped rather than failing the record: the
  // fork's own content is still valid and still worth storing, and an unusable pointer to
  // an ancestor is exactly as recoverable as no pointer at all.
  sanitized.parentId = typeof query.parentId === 'string' && UUID_REGEX.test(query.parentId)
    ? query.parentId
    : null;
  sanitized.parentName = typeof query.parentName === 'string'
    ? query.parentName.trim().slice(0, 200)
    : '';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/__tests__/domain.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain/validate.js src/domain/__tests__/domain.test.js
git commit -m "feat: validate fork lineage in the SPA domain layer"
```

---

### Task 5: Lineage domain helpers

**Files:**
- Create: `src/domain/lineage.js`
- Test: `src/domain/__tests__/lineage.test.js` (create)

**Interfaces:**
- Consumes: `validateQuery`'s sanitized shape (Task 4).
- Produces, all pure and exported:
  - `makeFork(parent, newId, nowIso)` → new query object
  - `indexById(queries)` → `Map<string, query>`
  - `childrenOf(queries)` → `Map<string, string[]>` keyed by parent id
  - `ancestryOf(query, byId, maxDepth = 50)` → `query[]`, nearest ancestor first, cycle-safe
  - `isOrphan(query, byId)` → boolean

- [ ] **Step 1: Write the failing test**

```javascript
// src/domain/__tests__/lineage.test.js
import { describe, it, expect } from 'vitest';
import { makeFork, indexById, childrenOf, ancestryOf, isOrphan } from '../lineage.js';

const q = (id, over = {}) => ({
  id, name: `q-${id}`, query: 'SigninLogs | take 1', description: 'd',
  category: 'Hunting', table: 'SigninLogs', tags: ['a'], favorite: true,
  usageCount: 7, parentId: null, parentName: '',
  created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z',
  ...over,
});

describe('makeFork', () => {
  const parent = q('p1', { name: 'Entra risky sign-in' });
  const fork = makeFork(parent, 'f1', '2026-07-31T10:00:00Z');

  it('records the parent id and a snapshot of its name', () => {
    expect(fork.parentId).toBe('p1');
    expect(fork.parentName).toBe('Entra risky sign-in');
  });

  it('takes the new id and timestamps', () => {
    expect(fork.id).toBe('f1');
    expect(fork.created).toBe('2026-07-31T10:00:00Z');
    expect(fork.updated).toBe('2026-07-31T10:00:00Z');
  });

  it('resets usage and favourite, which belong to the original', () => {
    expect(fork.usageCount).toBe(0);
    expect(fork.favorite).toBe(false);
  });

  it('copies the content fields verbatim', () => {
    expect(fork.query).toBe(parent.query);
    expect(fork.description).toBe(parent.description);
    expect(fork.tags).toEqual(['a']);
  });

  it('does not alias the parent tags array', () => {
    fork.tags.push('b');
    expect(parent.tags).toEqual(['a']);
  });

  it('forking a fork points at the immediate parent, not the root', () => {
    const second = makeFork(fork, 'f2', '2026-07-31T11:00:00Z');
    expect(second.parentId).toBe('f1');
  });
});

describe('childrenOf', () => {
  it('groups forks under their parent', () => {
    const map = childrenOf([q('p1'), q('a', { parentId: 'p1' }), q('b', { parentId: 'p1' }), q('c')]);
    expect(map.get('p1')).toEqual(['a', 'b']);
    expect(map.has('c')).toBe(false);
  });
});

describe('ancestryOf', () => {
  const queries = [q('root'), q('mid', { parentId: 'root' }), q('leaf', { parentId: 'mid' })];
  const byId = indexById(queries);

  it('returns ancestors nearest-first', () => {
    expect(ancestryOf(queries[2], byId).map((a) => a.id)).toEqual(['mid', 'root']);
  });

  it('returns empty for a query with no parent', () => {
    expect(ancestryOf(queries[0], byId)).toEqual([]);
  });

  it('stops at a missing ancestor rather than throwing', () => {
    const orphan = q('o', { parentId: 'gone' });
    expect(ancestryOf(orphan, indexById([orphan]))).toEqual([]);
  });

  it('terminates on a cycle instead of hanging', () => {
    const cyclic = [q('x', { parentId: 'y' }), q('y', { parentId: 'x' })];
    const map = indexById(cyclic);
    const walked = ancestryOf(cyclic[0], map);
    expect(walked.length).toBeLessThanOrEqual(2);
  });

  it('honours maxDepth on a long chain', () => {
    const chain = Array.from({ length: 100 }, (_, i) => q(`n${i}`, { parentId: i ? `n${i - 1}` : null }));
    expect(ancestryOf(chain[99], indexById(chain), 10)).toHaveLength(10);
  });
});

describe('isOrphan', () => {
  it('is true when parentId points at nothing', () => {
    const o = q('o', { parentId: 'gone' });
    expect(isOrphan(o, indexById([o]))).toBe(true);
  });

  it('is false for a resolvable parent', () => {
    const all = [q('p'), q('c', { parentId: 'p' })];
    expect(isOrphan(all[1], indexById(all))).toBe(false);
  });

  it('is false for a query that was never a fork', () => {
    const all = [q('p')];
    expect(isOrphan(all[0], indexById(all))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/__tests__/lineage.test.js`
Expected: FAIL — "Failed to resolve import ../lineage.js"

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/domain/lineage.js
// ============================================================
// Fork lineage
//
// Lineage is stored one generation deep — a query knows its parent and nothing else.
// Everything below reconstructs the rest client-side, which is free: the SPA already
// holds the whole store, so there is no reason to denormalise ancestry into the database
// and then have to keep it correct.
//
// Every walk here is bounded. A parent chain can contain a cycle: nothing in the schema
// prevents it, and an import of two queries that name each other as parent produces one
// without any single write looking wrong. An unguarded walk hangs the interface.
// ============================================================

/** Fields a fork inherits verbatim from its parent. */
const INHERITED = ['query', 'description', 'category', 'table'];

/**
 * Build a fork of `parent`. Pure — it neither mutates the parent nor touches storage.
 *
 * usageCount and favorite are deliberately reset. They are facts about how the original
 * has been used, and carrying them over would make a brand-new fork claim a history it
 * does not have.
 */
export function makeFork(parent, newId, nowIso) {
  const fork = {
    id: newId,
    name: parent.name,
    tags: [...(parent.tags || [])],
    favorite: false,
    usageCount: 0,
    parentId: parent.id,
    parentName: parent.name,
    created: nowIso,
    updated: nowIso,
  };
  for (const field of INHERITED) fork[field] = parent[field];
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

/**
 * Ancestors nearest-first. Stops at the first unresolvable parent, at a repeat visit
 * (cycle), or at maxDepth — whichever comes first.
 */
export function ancestryOf(query, byId, maxDepth = 50) {
  const out = [];
  const seen = new Set([query.id]);
  let current = query;
  while (out.length < maxDepth) {
    const parentId = current.parentId;
    if (!parentId || seen.has(parentId)) break;
    const parent = byId.get(parentId);
    if (!parent) break;
    out.push(parent);
    seen.add(parentId);
    current = parent;
  }
  return out;
}

/** A fork whose parent is no longer in the store. Never a fork-less query. */
export function isOrphan(query, byId) {
  return Boolean(query.parentId) && !byId.has(query.parentId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/__tests__/lineage.test.js`
Expected: PASS, 16 tests

- [ ] **Step 5: Verify coverage thresholds still hold**

Run: `npm run test:coverage`
Expected: PASS — `src/domain/lineage.js` must reach 80% lines, 80% functions, 75% branches.

- [ ] **Step 6: Commit**

```bash
git add src/domain/lineage.js src/domain/__tests__/lineage.test.js
git commit -m "feat: add pure lineage helpers with cycle-safe ancestry walking"
```

---

### Task 6: Fork action and lineage badge

**Files:**
- Modify: `src/components/QueryCard.jsx`
- Modify: `src/App.jsx` — add `forkQuery` and `lineage` to the context value
- Modify: `src/components/__tests__/harness.js` — add the two new context keys to `makeAppValue`
- Test: `src/components/__tests__/lineageCard.test.js` (create)

**Interfaces:**
- Consumes: `makeFork`, `childrenOf`, `indexById`, `isOrphan` from `src/domain/lineage.js` (Task 5); `generateId` from `src/lib/id.js`.
- Produces: two new keys on `AppContext` — `forkQuery(query)` and `lineage: { byId: Map, forkIndex: Map }`.

**Read this before writing the test.** `QueryCard` takes exactly one prop, `{ query }`, and reads
everything else from `useApp()` (see `src/components/QueryCard.jsx:10`). Lineage therefore arrives
through context like every other capability, not as props. Three further constraints come from the
existing suites and are not negotiable:

- **No JSX in test files.** `vitest.config.js` collects `src/**/__tests__/**/*.test.js` and Vite's
  esbuild loader will not parse JSX out of a `.js` file. Build trees with `h` from `harness.js`.
- **No `@testing-library/user-event` and no `@testing-library/jest-dom`** — neither is installed, and
  this plan forbids adding dependencies. Use `fireEvent`, and assert on DOM properties
  (`.checked`, `.textContent`) rather than `toBeChecked()` / `toHaveTextContent()`.
- Every component file needs the `// @vitest-environment jsdom` pragma on line 1 and an explicit
  `cleanup()` per test, matching `editorState.test.js`.

- [ ] **Step 1: Write the failing test**

```javascript
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, cleanup } from '@testing-library/react';
import { h, renderWithApp } from './harness.js';
import { QueryCard } from '../QueryCard.jsx';

const fork = {
  id: 'f1', name: 'Okta variant', query: 'OktaLogs | take 1', description: '',
  category: 'Hunting', table: 'Custom', tags: [], favorite: false, usageCount: 0,
  parentId: 'p1', parentName: 'Entra risky sign-in',
  created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z',
};
const parent = { ...fork, id: 'p1', name: 'Entra risky sign-in', parentId: null, parentName: '' };

/** Context slice for a store containing `queries`, with lineage derived as App does it. */
const lineageFor = (queries) => ({
  byId: new Map(queries.map((q) => [q.id, q])),
  forkIndex: queries.reduce((m, q) => {
    if (q.parentId) m.set(q.parentId, [...(m.get(q.parentId) || []), q.id]);
    return m;
  }, new Map()),
});

describe('QueryCard lineage', () => {
  it('names the parent when one is resolvable', () => {
    renderWithApp(h(QueryCard, { query: fork }), { lineage: lineageFor([parent, fork]) });
    expect(screen.getByText(/forked from/i).textContent).toMatch(/Entra risky sign-in/);
    cleanup();
  });

  it('marks an orphan using the snapshot name', () => {
    renderWithApp(h(QueryCard, { query: fork }), { lineage: lineageFor([fork]) });
    const badge = screen.getByText(/forked from/i);
    expect(badge.textContent).toMatch(/Entra risky sign-in/);
    expect(badge.textContent).toMatch(/deleted/i);
    cleanup();
  });

  it('shows no lineage badge for a query that is not a fork', () => {
    renderWithApp(h(QueryCard, { query: parent }), { lineage: lineageFor([parent]) });
    expect(screen.queryByText(/forked from/i)).toBeNull();
    cleanup();
  });

  it('reports how many forks a parent has', () => {
    renderWithApp(h(QueryCard, { query: parent }), { lineage: lineageFor([parent, fork]) });
    expect(screen.getByText(/1 fork\b/i)).toBeTruthy();
    cleanup();
  });

  it('pluralises the fork count', () => {
    const second = { ...fork, id: 'f2', name: 'Another' };
    renderWithApp(h(QueryCard, { query: parent }), { lineage: lineageFor([parent, fork, second]) });
    expect(screen.getByText(/2 forks/i)).toBeTruthy();
    cleanup();
  });

  it('calls forkQuery with the query', () => {
    const forkQuery = vi.fn();
    renderWithApp(h(QueryCard, { query: fork }), { lineage: lineageFor([parent, fork]), forkQuery });
    fireEvent.click(screen.getByRole('button', { name: /^fork /i }));
    expect(forkQuery).toHaveBeenCalledWith(fork);
    cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/lineageCard.test.js`
Expected: FAIL — no element matching `/forked from/i`

- [ ] **Step 3: Write minimal implementation**

Add `GitFork` to the existing `lucide-react` import in `QueryCard.jsx`, and pull the two new keys
from the existing `useApp()` destructure:

```jsx
const { copyToClipboard, deleteQuery, duplicateQuery, forkQuery, lineage, selectedIds,
  selectedTags, setEditingQuery, setSelectedTags, toggleExpand, toggleFavorite, toggleSelect } = useApp();

const parentQuery = query.parentId ? lineage.byId.get(query.parentId) ?? null : null;
const orphaned = Boolean(query.parentId) && !parentQuery;
const forkCount = (lineage.forkIndex.get(query.id) || []).length;
```

Render the badges alongside the existing table/category badges:

```jsx
{query.parentId && (
  <span className="inline-flex items-center gap-1 text-xs text-slate-400">
    <GitFork size={12} aria-hidden="true" />
    forked from{' '}
    {parentQuery ? (
      <button type="button" onClick={() => setEditingQuery(parentQuery)}
        className="underline hover:text-slate-200">
        {parentQuery.name}
      </button>
    ) : (
      <span>{query.parentName || 'a query'} (deleted)</span>
    )}
  </span>
)}
{forkCount > 0 && (
  <span className="inline-flex items-center gap-1 text-xs text-slate-400">
    <GitFork size={12} aria-hidden="true" />
    {forkCount} {forkCount === 1 ? 'fork' : 'forks'}
  </span>
)}
```

The orphan wording sits **inside** the same element as "forked from" on purpose: the test asserts
against one element's `textContent`, and more importantly a screen reader should hear
"forked from Entra risky sign-in (deleted)" as one phrase rather than two disconnected fragments.

Add the action button beside the existing edit/delete controls, matching their `FOCUS_RING` usage:

```jsx
<button type="button" onClick={() => forkQuery(query)} title="Fork this query"
  aria-label={`Fork ${query.name}`} className={`p-1.5 rounded hover:bg-slate-700 ${FOCUS_RING}`}>
  <GitFork size={16} aria-hidden="true" />
</button>
```

In `src/App.jsx`, derive the maps once and add the handler, then put both into the context value:

```jsx
const lineage = useMemo(
  () => ({ byId: indexById(queries), forkIndex: childrenOf(queries) }),
  [queries],
);

const forkQuery = useCallback((source) => {
  setEditingQuery(makeFork(source, generateId(), new Date().toISOString()));
}, []);
```

Because `forkQuery` sets `editingQuery` to a draft that is not in `queries`, the existing editor's
save path creates it — **no database write happens until the user saves**, which is the intended
behaviour.

Finally, add the two keys to `makeAppValue` in `src/components/__tests__/harness.js`:

```javascript
    forkQuery: noop,
    lineage: { byId: new Map(), forkIndex: new Map() },
```

That file's header explains why this is required: a missing context key does not throw, it renders
`undefined` and fails an assertion somewhere unrelated. Every suite that mounts a `QueryCard`
depends on these defaults existing.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/__tests__/lineageCard.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Check the other component suites still mount**

Run: `npx vitest run src/components/__tests__/`
Expected: PASS. `a11y.test.js` and `dialog.test.js` mount `QueryCard` through the same harness — if
`makeAppValue` was not updated in Step 3, they fail here with `lineage is undefined` rather than
anything that names the real cause.

- [ ] **Step 6: Commit**

```bash
git add src/components/QueryCard.jsx src/App.jsx src/components/__tests__/harness.js src/components/__tests__/lineageCard.test.js
git commit -m "feat: fork action and lineage badges on query cards"
```

---

### Task 7: Sidebar fork filter

**Files:**
- Modify: `src/components/SidebarContent.jsx`
- Modify: `src/App.jsx` — `lineageFilter` state, filter predicate, `clearFilters`, `hasActiveFilters`
- Test: `src/domain/__tests__/lineage.test.js` (extend — the predicate lands in `lineage.js` so it is covered)

**Interfaces:**
- Consumes: `childrenOf` (Task 5).
- Produces: `matchesLineageFilter(query, filter, forkIndex)` exported from `src/domain/lineage.js`, where `filter` is `null | 'forks' | 'parents' | 'orphans'`.

- [ ] **Step 1: Write the failing test**

Append to `src/domain/__tests__/lineage.test.js`:

```javascript
describe('matchesLineageFilter', () => {
  const parent = q('p1');
  const fork = q('f1', { parentId: 'p1' });
  const lone = q('l1');
  const orphan = q('o1', { parentId: 'gone' });
  const all = [parent, fork, lone, orphan];
  const idx = childrenOf(all);
  const byId = indexById(all);

  it('passes everything when the filter is null', () => {
    expect(all.filter((x) => matchesLineageFilter(x, null, idx, byId))).toHaveLength(4);
  });

  it('"forks" selects queries that have a parent', () => {
    const got = all.filter((x) => matchesLineageFilter(x, 'forks', idx, byId));
    expect(got.map((x) => x.id).sort()).toEqual(['f1', 'o1']);
  });

  it('"parents" selects queries that have at least one fork', () => {
    const got = all.filter((x) => matchesLineageFilter(x, 'parents', idx, byId));
    expect(got.map((x) => x.id)).toEqual(['p1']);
  });

  it('"orphans" selects forks whose parent is gone', () => {
    const got = all.filter((x) => matchesLineageFilter(x, 'orphans', idx, byId));
    expect(got.map((x) => x.id)).toEqual(['o1']);
  });
});
```

Add `matchesLineageFilter` to the import at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/__tests__/lineage.test.js`
Expected: FAIL — "matchesLineageFilter is not a function"

- [ ] **Step 3: Write minimal implementation**

Append to `src/domain/lineage.js`:

```javascript
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
```

In `src/App.jsx` add `const [lineageFilter, setLineageFilter] = useState(null);`, add
`result = result.filter((q) => matchesLineageFilter(q, lineageFilter, forkIndex, byId));`
to the existing `useMemo` filter chain (line ~345, beside the `selectedTable` filter), add
`lineageFilter` to that memo's dependency array, add `setLineageFilter(null)` to
`clearFilters` (line ~410), and add `|| lineageFilter` to `hasActiveFilters` (line ~414).

In `SidebarContent.jsx`, add a group of three toggles — Forks, Parents, Orphans — following the
existing category-button markup and its `aria-pressed` pattern.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/__tests__/lineage.test.js`
Expected: PASS, 20 tests

- [ ] **Step 5: Run the full SPA suite**

Run: `npm run test:coverage`
Expected: PASS, thresholds held.

- [ ] **Step 6: Commit**

```bash
git add src/domain/lineage.js src/App.jsx src/components/SidebarContent.jsx src/domain/__tests__/lineage.test.js
git commit -m "feat: filter the query list by fork, parent and orphan status"
```

---

### Task 8: Schema table and server-side validation

**Files:**
- Modify: `api/db.js` (append the new table)
- Modify: `api/validate.js` — add `validateSchemaPayload`, extend `LIMITS`, extend `module.exports`
- Test: `api/test/schemas-validate.test.js` (create)

**Interfaces:**
- Consumes: `checkString`, `badRequest`, `LIMITS`.
- Produces: `validateSchemaPayload(body)` → `{ name, columns, notes, source }` where `columns` is a JSON **string** ready to bind, and `SCHEMA_SOURCES = ['getschema', 'manual', 'import']`.

- [ ] **Step 1: Write the failing test**

```javascript
// api/test/schemas-validate.test.js
const test = require('node:test');
const assert = require('node:assert');
const { validateSchemaPayload } = require('../validate');

test('accepts a minimal schema', () => {
  const out = validateSchemaPayload({ name: 'SigninLogs', columns: [{ name: 'TimeGenerated', type: 'datetime' }] });
  assert.strictEqual(out.name, 'SigninLogs');
  assert.deepStrictEqual(JSON.parse(out.columns), [{ name: 'TimeGenerated', type: 'datetime' }]);
  assert.strictEqual(out.notes, '');
  assert.strictEqual(out.source, 'getschema');
});

test('requires a name', () => {
  assert.throws(() => validateSchemaPayload({ columns: [] }), /"name" is required/);
});

test('rejects a non-array columns value', () => {
  assert.throws(() => validateSchemaPayload({ name: 'T', columns: 'nope' }), /"columns" must be an array/);
});

test('rejects a column without a name', () => {
  assert.throws(
    () => validateSchemaPayload({ name: 'T', columns: [{ type: 'string' }] }),
    /every column needs a "name"/,
  );
});

test('defaults a missing column type rather than rejecting', () => {
  const out = validateSchemaPayload({ name: 'T', columns: [{ name: 'Foo' }] });
  assert.deepStrictEqual(JSON.parse(out.columns), [{ name: 'Foo', type: 'unknown' }]);
});

test('rejects more than 500 columns', () => {
  const columns = Array.from({ length: 501 }, (_, i) => ({ name: `c${i}`, type: 'string' }));
  assert.throws(() => validateSchemaPayload({ name: 'T', columns }), /"columns" exceeds 500 entries/);
});

test('rejects an unknown source', () => {
  assert.throws(() => validateSchemaPayload({ name: 'T', columns: [], source: 'guesswork' }), /"source" must be one of/);
});

test('rejects notes over the limit', () => {
  assert.throws(
    () => validateSchemaPayload({ name: 'T', columns: [], notes: 'x'.repeat(5001) }),
    /"notes" exceeds 5000 characters/,
  );
});

test('strips unknown column keys', () => {
  const out = validateSchemaPayload({ name: 'T', columns: [{ name: 'A', type: 'string', evil: 1 }] });
  assert.deepStrictEqual(JSON.parse(out.columns), [{ name: 'A', type: 'string' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test test/schemas-validate.test.js`
Expected: FAIL — "validateSchemaPayload is not a function"

- [ ] **Step 3: Write minimal implementation**

Append to `api/db.js`:

```javascript
// Table schemas. Independent of `queries` by design: this is reference data about the
// tables a query reads from, not part of a query record, and nothing joins the two.
db.prepare(`
  CREATE TABLE IF NOT EXISTS table_schemas (
    name    TEXT PRIMARY KEY,
    columns TEXT NOT NULL DEFAULT '[]',
    notes   TEXT DEFAULT '',
    source  TEXT DEFAULT 'getschema',
    updated TEXT NOT NULL
  )
`).run();
```

In `api/validate.js`, add to `LIMITS`:

```javascript
  schemaName: 200,
  schemaColumns: 500,
  schemaColumnName: 200,
  schemaNotes: 5000,
```

and add, before `module.exports`:

```javascript
const SCHEMA_SOURCES = ['getschema', 'manual', 'import'];

/**
 * Validate a table schema. Columns are returned already serialised, because every caller
 * binds them straight into SQLite and re-stringifying at each call site is how the two
 * sides drift apart.
 *
 * A missing column type is defaulted rather than rejected: `getschema` output pasted from
 * the portal sometimes loses the type column to a copy that clipped it, and a column list
 * without types is still far more useful to a reader than no schema at all.
 */
function validateSchemaPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('request body must be a JSON object');
  }

  const name = checkString(body.name, 'name', LIMITS.schemaName, { required: true });

  if (body.columns !== undefined && !Array.isArray(body.columns)) {
    throw badRequest('"columns" must be an array');
  }
  const raw = body.columns || [];
  if (raw.length > LIMITS.schemaColumns) {
    throw badRequest(`"columns" exceeds ${LIMITS.schemaColumns} entries`);
  }

  const columns = raw.map((col) => {
    if (!col || typeof col !== 'object' || Array.isArray(col)) {
      throw badRequest('every column must be an object');
    }
    if (typeof col.name !== 'string' || !col.name.trim()) {
      throw badRequest('every column needs a "name"');
    }
    if (col.name.length > LIMITS.schemaColumnName) {
      throw badRequest(`a column name exceeds ${LIMITS.schemaColumnName} characters`);
    }
    return {
      name: col.name.trim(),
      type: typeof col.type === 'string' && col.type.trim() ? col.type.trim() : 'unknown',
    };
  });

  const notes = checkString(body.notes, 'notes', LIMITS.schemaNotes, { required: false }) ?? '';

  const source = body.source ?? 'getschema';
  if (!SCHEMA_SOURCES.includes(source)) {
    throw badRequest(`"source" must be one of: ${SCHEMA_SOURCES.join(', ')}`);
  }

  return { name: name.trim(), columns: JSON.stringify(columns), notes, source };
}
```

Add `validateSchemaPayload` and `SCHEMA_SOURCES` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && node --test test/schemas-validate.test.js`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add api/db.js api/validate.js api/test/schemas-validate.test.js
git commit -m "feat(api): add the table_schemas table and its payload validation"
```

---

### Task 9: Schema routes

**Files:**
- Create: `api/routes/schemas.js`
- Modify: `api/app.js:69` (mount the router)
- Test: `api/test/schemas.test.js` (create)

**Interfaces:**
- Consumes: `validateSchemaPayload` (Task 8), `db`.
- Produces: `GET /api/schemas`, `GET /api/schemas/:name`, `PUT /api/schemas/:name`, `DELETE /api/schemas/:name`. Every response shape is `{ name, columns: [{name,type}], notes, source, updated }`.

- [ ] **Step 1: Write the failing test**

```javascript
// api/test/schemas.test.js
const test = require('node:test');
const assert = require('node:assert');
const { useTempDatabase, startServer, api } = require('./helpers');

useTempDatabase();
const app = require('../app');

let server;
test.before(async () => { server = await startServer(app); });
test.after(async () => { await server.close(); });

const body = { columns: [{ name: 'TimeGenerated', type: 'datetime' }], notes: '30 day retention' };

test('starts empty', async () => {
  const res = await api(server.url, '/api/schemas');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, []);
});

test('creates and reads back a schema', async () => {
  const put = await api(server.url, '/api/schemas/SigninLogs', { method: 'PUT', body });
  assert.strictEqual(put.status, 200);
  assert.strictEqual(put.body.name, 'SigninLogs');
  assert.deepStrictEqual(put.body.columns, [{ name: 'TimeGenerated', type: 'datetime' }]);
  assert.strictEqual(put.body.notes, '30 day retention');
  assert.ok(put.body.updated, 'updated timestamp must be set');

  const get = await api(server.url, '/api/schemas/SigninLogs');
  assert.strictEqual(get.status, 200);
  assert.strictEqual(get.body.name, 'SigninLogs');
});

test('a second PUT replaces rather than duplicating', async () => {
  await api(server.url, '/api/schemas/SigninLogs', {
    method: 'PUT',
    body: { columns: [{ name: 'ResultType', type: 'string' }] },
  });
  const list = await api(server.url, '/api/schemas');
  const matches = list.body.filter((s) => s.name === 'SigninLogs');
  assert.strictEqual(matches.length, 1);
  assert.deepStrictEqual(matches[0].columns, [{ name: 'ResultType', type: 'string' }]);
});

test('404s an unknown schema', async () => {
  const res = await api(server.url, '/api/schemas/NoSuchTable');
  assert.strictEqual(res.status, 404);
});

test('deletes a schema', async () => {
  const del = await api(server.url, '/api/schemas/SigninLogs', { method: 'DELETE' });
  assert.strictEqual(del.status, 200);
  const after = await api(server.url, '/api/schemas/SigninLogs');
  assert.strictEqual(after.status, 404);
});

test('404s a delete for something that is not there', async () => {
  const res = await api(server.url, '/api/schemas/Ghost', { method: 'DELETE' });
  assert.strictEqual(res.status, 404);
});

test('rejects an invalid payload with 400 and a usable message', async () => {
  const res = await api(server.url, '/api/schemas/Bad', { method: 'PUT', body: { columns: 'nope' } });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /"columns" must be an array/);
});

test('a malformed columns row does not 500 the list', async () => {
  const db = require('../db');
  db.prepare(`
    INSERT INTO table_schemas (name, columns, notes, source, updated)
    VALUES ('Broken', '{not json', '', 'manual', '2026-01-01T00:00:00Z')
  `).run();
  const res = await api(server.url, '/api/schemas');
  assert.strictEqual(res.status, 200);
  const broken = res.body.find((s) => s.name === 'Broken');
  assert.deepStrictEqual(broken.columns, [], 'unparseable columns degrade to empty, not a 500');
});

test('a name in the path is used, not one in the body', async () => {
  await api(server.url, '/api/schemas/PathWins', { method: 'PUT', body: { name: 'BodyLoses', columns: [] } });
  const res = await api(server.url, '/api/schemas/PathWins');
  assert.strictEqual(res.status, 200);
  const loser = await api(server.url, '/api/schemas/BodyLoses');
  assert.strictEqual(loser.status, 404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test test/schemas.test.js`
Expected: FAIL — 404 on `GET /api/schemas`

- [ ] **Step 3: Write minimal implementation**

```javascript
// api/routes/schemas.js
const { Router } = require('express');
const db = require('../db');
const { validateSchemaPayload } = require('../validate');

const router = Router();

/**
 * Parse the columns document defensively. Same reasoning as parseTags in routes/queries.js:
 * one malformed row must not take down the list endpoint for every other table.
 */
function parseColumns(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toFrontend(row) {
  return {
    name: row.name,
    columns: parseColumns(row.columns),
    notes: row.notes || '',
    source: row.source || 'getschema',
    updated: row.updated,
  };
}

function notFound() {
  const error = new Error('Schema not found');
  error.statusCode = 404;
  return error;
}

router.get('/', (_req, res, next) => {
  try {
    res.json(db.prepare('SELECT * FROM table_schemas ORDER BY name ASC').all().map(toFrontend));
  } catch (err) {
    next(err);
  }
});

router.get('/:name', (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM table_schemas WHERE name = ?').get(req.params.name);
    if (!row) throw notFound();
    res.json(toFrontend(row));
  } catch (err) {
    next(err);
  }
});

// PUT is an upsert keyed on the path name. The body's own `name` is ignored: two sources
// of truth for the key is how you end up with a row nobody can address.
router.put('/:name', (req, res, next) => {
  try {
    const v = validateSchemaPayload({ ...req.body, name: req.params.name });
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO table_schemas (name, columns, notes, source, updated)
      VALUES (@name, @columns, @notes, @source, @updated)
      ON CONFLICT(name) DO UPDATE SET
        columns = @columns, notes = @notes, source = @source, updated = @updated
    `).run({ ...v, updated: now });
    res.json(toFrontend(db.prepare('SELECT * FROM table_schemas WHERE name = ?').get(v.name)));
  } catch (err) {
    next(err);
  }
});

router.delete('/:name', (req, res, next) => {
  try {
    const result = db.prepare('DELETE FROM table_schemas WHERE name = ?').run(req.params.name);
    if (result.changes === 0) throw notFound();
    res.json({ deleted: req.params.name });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
```

In `api/app.js`, beside the existing mounts:

```javascript
const schemasRouter = require('./routes/schemas');
app.use('/api/schemas', schemasRouter);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && node --test test/schemas.test.js`
Expected: PASS, 9 tests

- [ ] **Step 5: Confirm the request-size guard covers the new route**

Check `api/app.js:48` — the `/api/queries` middleware guard. If it enforces a body limit or content type that `/api/schemas` also needs, extend its path match. Then run the whole suite:

Run: `cd api && node --test "test/**/*.test.js"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add api/routes/schemas.js api/app.js api/test/schemas.test.js
git commit -m "feat(api): add CRUD routes for the table schema store"
```

---

### Task 10: The getschema parser

**Files:**
- Create: `src/domain/getschema.js`
- Test: `src/domain/__tests__/getschema.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `parseGetSchema(text)` → `{ ok: true, columns: [{name, type}] }` or `{ ok: false, error: string }`.

- [ ] **Step 1: Write the failing test**

```javascript
// src/domain/__tests__/getschema.test.js
import { describe, it, expect } from 'vitest';
import { parseGetSchema } from '../getschema.js';

describe('parseGetSchema', () => {
  it('parses tab-separated output with a header', () => {
    const text = [
      'ColumnName\tColumnOrdinal\tDataType\tColumnType',
      'TimeGenerated\t0\tSystem.DateTime\tdatetime',
      'ResultType\t1\tSystem.String\tstring',
    ].join('\n');
    const out = parseGetSchema(text);
    expect(out.ok).toBe(true);
    expect(out.columns).toEqual([
      { name: 'TimeGenerated', type: 'datetime' },
      { name: 'ResultType', type: 'string' },
    ]);
  });

  it('parses comma-separated output', () => {
    const text = 'ColumnName,ColumnOrdinal,DataType,ColumnType\nUserPrincipalName,0,System.String,string';
    const out = parseGetSchema(text);
    expect(out.ok).toBe(true);
    expect(out.columns).toEqual([{ name: 'UserPrincipalName', type: 'string' }]);
  });

  it('parses multi-space aligned output from the portal grid', () => {
    const text = 'ColumnName     ColumnOrdinal   DataType            ColumnType\nDeviceName     3               System.String       string';
    const out = parseGetSchema(text);
    expect(out.ok).toBe(true);
    expect(out.columns).toEqual([{ name: 'DeviceName', type: 'string' }]);
  });

  it('works without a header row', () => {
    const out = parseGetSchema('TimeGenerated\t0\tSystem.DateTime\tdatetime');
    expect(out.ok).toBe(true);
    expect(out.columns).toEqual([{ name: 'TimeGenerated', type: 'datetime' }]);
  });

  it('falls back to DataType when ColumnType is absent', () => {
    const out = parseGetSchema('ColumnName\tDataType\nTimeGenerated\tSystem.DateTime');
    expect(out.ok).toBe(true);
    expect(out.columns).toEqual([{ name: 'TimeGenerated', type: 'datetime' }]);
  });

  it('defaults an unknown type rather than dropping the column', () => {
    const out = parseGetSchema('Mystery');
    expect(out.ok).toBe(true);
    expect(out.columns).toEqual([{ name: 'Mystery', type: 'unknown' }]);
  });

  it('ignores blank lines', () => {
    const out = parseGetSchema('A\t0\tSystem.String\tstring\n\n\nB\t1\tSystem.Int32\tint');
    expect(out.columns).toHaveLength(2);
  });

  it('de-duplicates a repeated column name, keeping the first', () => {
    const out = parseGetSchema('A\t0\tSystem.String\tstring\nA\t1\tSystem.Int32\tint');
    expect(out.columns).toEqual([{ name: 'A', type: 'string' }]);
  });

  it('rejects empty input', () => {
    expect(parseGetSchema('')).toEqual({ ok: false, error: 'Nothing to parse.' });
    expect(parseGetSchema('   \n  ')).toEqual({ ok: false, error: 'Nothing to parse.' });
  });

  it('rejects a non-string input', () => {
    expect(parseGetSchema(null).ok).toBe(false);
  });

  it('rejects prose that is not schema output', () => {
    const out = parseGetSchema('Here is the schema you asked for, let me know if you need more!');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/does not look like getschema output/i);
  });

  it('rejects a paste with more than 500 columns', () => {
    const text = Array.from({ length: 501 }, (_, i) => `Col${i}\t${i}\tSystem.String\tstring`).join('\n');
    const out = parseGetSchema(text);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/500/);
  });

  it('strips a KQL prompt line if one was copied in', () => {
    const text = 'SigninLogs | getschema\nColumnName\tColumnOrdinal\tDataType\tColumnType\nA\t0\tSystem.String\tstring';
    const out = parseGetSchema(text);
    expect(out.ok).toBe(true);
    expect(out.columns).toEqual([{ name: 'A', type: 'string' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/__tests__/getschema.test.js`
Expected: FAIL — "Failed to resolve import ../getschema.js"

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/domain/getschema.js
// ============================================================
// `TableName | getschema` output parser.
//
// This is the only place in the app that eats untrusted human paste, and the bar it has
// to clear is the same one detectTableFromQuery has: be right about what a practitioner
// actually pastes, and fail loudly rather than confidently returning three plausible
// columns from something that was never schema output.
//
// Three shapes turn up in practice and all three are handled: tab-separated (copy from
// the results grid), comma-separated (the portal's CSV export), and multi-space aligned
// (a copy out of a rendered table or a terminal). They are distinguished per line rather
// than per document, because a paste that has been through an editor can mix them.
// ============================================================

const MAX_COLUMNS = 500;

// System.DateTime -> datetime, System.String -> string. Falls through unchanged for a
// value that is already a KQL type name.
const SYSTEM_TYPES = {
  'system.datetime': 'datetime',
  'system.string': 'string',
  'system.int32': 'int',
  'system.int64': 'long',
  'system.double': 'real',
  'system.boolean': 'bool',
  'system.guid': 'guid',
  'system.timespan': 'timespan',
  'system.object': 'dynamic',
  'system.sbyte': 'bool',
};

const HEADER = /^columnname\b/i;
// A line that is a KQL statement rather than a row of output.
const KQL_PROMPT = /\|\s*getschema\s*$/i;

/** Split one line on whichever separator it actually uses. */
function splitLine(line) {
  if (line.includes('\t')) return line.split('\t');
  if (line.includes(',')) return line.split(',');
  return line.split(/\s{2,}/);
}

function normaliseType(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return 'unknown';
  const value = raw.trim();
  return SYSTEM_TYPES[value.toLowerCase()] || value;
}

// A column name is an identifier. Anything with a space or punctuation in it came from
// prose, not from getschema.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * @param {string} text
 * @returns {{ok: true, columns: Array<{name: string, type: string}>} | {ok: false, error: string}}
 */
export function parseGetSchema(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: 'Nothing to parse.' };
  }

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !KQL_PROMPT.test(l));

  let headerFields = null;
  const columns = [];
  const seen = new Set();

  for (const line of lines) {
    const fields = splitLine(line).map((f) => f.trim()).filter((f) => f.length > 0);
    if (fields.length === 0) continue;

    if (HEADER.test(fields[0])) {
      headerFields = fields.map((f) => f.toLowerCase());
      continue;
    }

    const name = fields[0];
    if (!IDENTIFIER.test(name)) continue;
    if (seen.has(name)) continue;

    // Prefer the ColumnType column when a header told us where it is; otherwise take the
    // last field, which is where getschema puts it in every shape seen in practice.
    let type = 'unknown';
    if (headerFields) {
      const typeIndex = headerFields.indexOf('columntype');
      const dataIndex = headerFields.indexOf('datatype');
      const index = typeIndex !== -1 ? typeIndex : dataIndex;
      if (index !== -1 && fields[index] !== undefined) type = fields[index];
    } else if (fields.length > 1) {
      type = fields[fields.length - 1];
    }

    seen.add(name);
    columns.push({ name, type: normaliseType(type) });

    if (columns.length > MAX_COLUMNS) {
      return { ok: false, error: `That paste has more than ${MAX_COLUMNS} columns — check it is one table's schema.` };
    }
  }

  if (columns.length === 0) {
    return { ok: false, error: 'That does not look like getschema output — no column names found.' };
  }

  return { ok: true, columns };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/__tests__/getschema.test.js`
Expected: PASS, 13 tests

- [ ] **Step 5: Verify coverage**

Run: `npm run test:coverage`
Expected: PASS — `src/domain/getschema.js` at or above 80/80/75.

- [ ] **Step 6: Commit**

```bash
git add src/domain/getschema.js src/domain/__tests__/getschema.test.js
git commit -m "feat: parse getschema output in tab, comma and aligned forms"
```

---

### Task 11: Schema view and storage adapter

**Files:**
- Modify: `src/storage/adapter.js` (add schema methods)
- Create: `src/components/SchemaView.jsx`
- Modify: `src/App.jsx` (top-level view switch)
- Test: `src/storage/__tests__/schemaAdapter.test.js` (create)

**Interfaces:**
- Consumes: `parseGetSchema` (Task 10); `/api/schemas` routes (Task 9); `fetchStub` from `src/storage/__tests__/fetchStub.js`.
- Produces: `StorageAdapter.fetchSchemas()`, `.saveSchema(name, payload)`, `.deleteSchema(name)`; `App` state `view` of `'queries' | 'schemas'`.

- [ ] **Step 1: Write the failing test**

```javascript
// src/storage/__tests__/schemaAdapter.test.js
import { describe, it, expect, afterEach, vi } from 'vitest';
import { response, stubFetch, callsTo } from './fetchStub.js';
import { StorageAdapter } from '../adapter.js';

describe('schema adapter', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('fetches the schema list', async () => {
    const { calls } = stubFetch(() => response([
      { name: 'SigninLogs', columns: [], notes: '', source: 'getschema', updated: 'x' },
    ]));
    const out = await StorageAdapter.fetchSchemas();
    expect(out).toHaveLength(1);
    expect(calls[0].url).toBe('/api/schemas');
    expect(calls[0].credentials).toBe('include');
  });

  it('PUTs a schema to its encoded name', async () => {
    const { calls } = stubFetch(() => response({
      name: 'My Table', columns: [], notes: '', source: 'manual', updated: 'x',
    }));
    await StorageAdapter.saveSchema('My Table', { columns: [], notes: '', source: 'manual' });
    const [put] = callsTo(calls, '/api/schemas', 'PUT');
    expect(put.url).toBe('/api/schemas/My%20Table');
    expect(put.body).toEqual({ columns: [], notes: '', source: 'manual' });
  });

  it('surfaces the server message on failure', async () => {
    stubFetch(() => response(
      { error: '"columns" must be an array' },
      { status: 400, statusText: 'Bad Request' },
    ));
    await expect(StorageAdapter.saveSchema('T', { columns: 'nope' }))
      .rejects.toThrow(/"columns" must be an array/);
  });

  it('DELETEs by encoded name', async () => {
    const { calls } = stubFetch(() => response({ deleted: 'T' }));
    await StorageAdapter.deleteSchema('T');
    const [del] = callsTo(calls, '/api/schemas', 'DELETE');
    expect(del.url).toBe('/api/schemas/T');
  });

  it('rejects when the pod is unreachable', async () => {
    stubFetch(() => undefined);
    await expect(StorageAdapter.fetchSchemas()).rejects.toThrow(/Failed to fetch/);
  });
});
```

`fetchStub.js` exports exactly `response`, `emptyResponse`, `stubFetch` and `callsTo`. The handler
receives `{ url, method, body, credentials }` and returning `undefined` makes fetch reject with a
`TypeError`, which is how the last test simulates an unreachable API. Do not add a second stub style.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/__tests__/schemaAdapter.test.js`
Expected: FAIL — "StorageAdapter.fetchSchemas is not a function"

- [ ] **Step 3: Write minimal implementation**

Add to the `StorageAdapter` object in `src/storage/adapter.js`, following the exact `operationLog` + `apiError` pattern the query methods use:

```javascript
  async fetchSchemas() {
    const start = Date.now();
    try {
      const res = await fetch(`${API_BASE}/schemas`, { credentials: 'include' });
      if (!res.ok) throw await apiError(res);
      const data = await res.json();
      operationLog.add({ type: 'API_FETCH_SCHEMAS', key: 'schemas', success: true, latencyMs: Date.now() - start });
      return data;
    } catch (e) {
      operationLog.add({ type: 'API_FETCH_SCHEMAS', key: 'schemas', success: false, latencyMs: Date.now() - start, error: e.message });
      throw e;
    }
  },

  async saveSchema(name, payload) {
    const start = Date.now();
    try {
      const res = await fetch(`${API_BASE}/schemas/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'include',
      });
      if (!res.ok) throw await apiError(res);
      const data = await res.json();
      operationLog.add({ type: 'API_SAVE_SCHEMA', key: name, success: true, latencyMs: Date.now() - start });
      return data;
    } catch (e) {
      operationLog.add({ type: 'API_SAVE_SCHEMA', key: name, success: false, latencyMs: Date.now() - start, error: e.message });
      throw e;
    }
  },

  async deleteSchema(name) {
    const start = Date.now();
    try {
      const res = await fetch(`${API_BASE}/schemas/${encodeURIComponent(name)}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) throw await apiError(res);
      operationLog.add({ type: 'API_DELETE_SCHEMA', key: name, success: true, latencyMs: Date.now() - start });
    } catch (e) {
      operationLog.add({ type: 'API_DELETE_SCHEMA', key: name, success: false, latencyMs: Date.now() - start, error: e.message });
      throw e;
    }
  },
```

Create `src/components/SchemaView.jsx` with: a searchable list of stored schemas; a paste box that runs `parseGetSchema` and shows either the parsed column count or the parser's error verbatim before saving; a `notes` textarea; and a delete control. Reuse `Modal.jsx` for the delete confirmation and `useToast` for success and failure messages, exactly as the query flows do.

Add JSON export and import for the whole schema set, reusing the existing import machinery rather
than inventing a second one: export writes `{ schemas: [...] }` from `fetchSchemas()`, and import
feeds `ImportPreviewModal` the same add/skip/error item shape it already renders for queries
(`{ index, name, status, reason }` — see `SAMPLE_IMPORT_PREVIEW` in `harness.js`), then PUTs each
accepted entry. Import sets `source: 'import'`, which is why `SCHEMA_SOURCES` has that third value.

In `src/App.jsx`, add `const [view, setView] = useState('queries');`, render two top-level tab buttons with `role="tab"` and `aria-selected`, and switch the main region between the existing query list and `<SchemaView />`. **No router** — the app has one view today and this adds a second; a router is not warranted and would change the deployment's URL handling.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/storage/__tests__/schemaAdapter.test.js`
Expected: PASS, 5 tests

- [ ] **Step 5: Verify the whole suite and a real build**

Run: `npm run test:coverage && npm run lint && npm run build`
Expected: all PASS. The build must succeed — `SchemaView.jsx` is new and esbuild will catch an unresolved import that vitest's module graph did not.

- [ ] **Step 6: Commit**

```bash
git add src/storage/adapter.js src/components/SchemaView.jsx src/App.jsx src/storage/__tests__/schemaAdapter.test.js
git commit -m "feat: add the schema view and its storage adapter methods"
```

---

### Task 12: Documentation

**Files:**
- Modify: `docs/schema.md` (lineage fields)
- Modify: `docs/api.md` (the `/api/schemas` routes)
- Modify: `README.md` (architecture diagram note and feature list)
- Create: `docs/schemas.md`

- [ ] **Step 1: Document the lineage fields**

In `docs/schema.md`, add to the **Core fields** table, matching the existing tone — state the bound, then why it is what it is:

```markdown
| `parentId` | string \| null | no | UUID v4 of the query this was forked from, or `null`. **Not a foreign key**: deleting a parent neither cascades to nor blocks its forks, so a `parentId` that resolves to nothing is an expected state and renders as an orphaned fork. A value that is not a UUID is dropped rather than failing the record. |
| `parentName` | string | no | ≤ 200 characters. The parent's name **at fork time**, not a live reference. It is what lets an orphaned fork still say what it came from, so it is correct for it to go stale when the parent is renamed. |
```

Add a note that lineage is deliberately outside the v4 detection metadata document and therefore does not appear in the Sentinel or Navigator exports.

- [ ] **Step 2: Document the schema routes**

In `docs/api.md`, add a section for `GET /api/schemas`, `GET /api/schemas/:name`, `PUT /api/schemas/:name`, `DELETE /api/schemas/:name` — request and response bodies, the bounds from `LIMITS` (500 columns, 200-character names, 5000-character notes), and the fact that `PUT` is an upsert keyed on the **path** name, with any `name` in the body ignored.

- [ ] **Step 3: Write the schema store guide**

Create `docs/schemas.md` covering: what the store is for (model context, and a reference for humans); that it is **additive** and does not drive badges, the sidebar or the linter, which still read the constants in `src/constants.js`; how to get schema output (`TableName | getschema`); the three paste formats accepted; and why `notes` matters — retention windows, conditional population, DCR versions, the things `getschema` cannot tell you.

- [ ] **Step 4: Update the README**

Add forking and the schema store to the feature list. Note in the architecture section that `/api/schemas` is served by the same API Deployment and shares its PVC.

- [ ] **Step 5: Verify every documentation link resolves**

```bash
grep -oE '\]\([^)#][^)]*\)' docs/schemas.md docs/schema.md docs/api.md \
  | sed 's/.*](\(.*\))/\1/' | sed 's/#.*//' | sort -u \
  | while read p; do [ -e "docs/$p" ] || [ -e "$p" ] || echo "DEAD $p"; done
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add docs/schema.md docs/api.md docs/schemas.md README.md
git commit -m "docs: document fork lineage and the table schema store"
```

---

## Definition of done

- [ ] `cd api && node --test "test/**/*.test.js"` passes
- [ ] `npm run test:coverage` passes with thresholds held
- [ ] `npm run lint` clean
- [ ] `npm run build` succeeds
- [ ] Forking a query, editing it, and saving produces a fork whose badge names its parent
- [ ] Deleting the parent leaves the fork present and marked as orphaned
- [ ] Pasting `TableName | getschema` output into the schema tab stores a schema that survives a reload
- [ ] `src/constants.js` is unmodified — the six existing consumers of the table constants are untouched
