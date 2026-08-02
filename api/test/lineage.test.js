// ---------------------------------------------------------------------------
// Fork lineage end-to-end through the routes.
//
// The interesting cases are not "does it round-trip" — they are the ones where lineage
// has to survive something: a partial PUT that never mentions it, an upsert import, and
// the deletion of the parent it points at. Each of those is a place where a plausible
// implementation silently drops the pointer and the fork quietly stops being a fork.
// ---------------------------------------------------------------------------
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
  assert.strictEqual(listed.parentName, 'Failed sign-ins');
});

test('a query with no parent reports parentId null and parentName empty', async () => {
  const res = await api(server.url, '/api/queries', {
    method: 'POST', body: makeQuery({ name: 'Standalone' }),
  });
  assert.strictEqual(res.body.parentId, null);
  assert.strictEqual(res.body.parentName, '');
});

test('deleting a parent leaves the fork intact and orphaned', async () => {
  const parent = await api(server.url, '/api/queries', {
    method: 'POST', body: makeQuery({ name: 'Doomed' }),
  });
  const fork = await api(server.url, '/api/queries', {
    method: 'POST',
    body: makeQuery({ name: 'Survivor', parentId: parent.body.id, parentName: 'Doomed' }),
  });

  const del = await api(server.url, `/api/queries/${parent.body.id}`, { method: 'DELETE' });
  assert.strictEqual(del.status, 200);

  const after = await api(server.url, `/api/queries/${fork.body.id}`);
  assert.strictEqual(after.status, 200, 'the fork must survive its parent');
  assert.strictEqual(after.body.parentId, parent.body.id, 'the dangling pointer is retained on purpose');
  assert.strictEqual(after.body.parentName, 'Doomed', 'the snapshot name outlives the parent');
});

test('a partial PUT that never mentions lineage preserves it', async () => {
  const parentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const fork = await api(server.url, '/api/queries', {
    method: 'POST',
    body: makeQuery({ name: 'Keeps its parent', parentId, parentName: 'Original' }),
  });

  const put = await api(server.url, `/api/queries/${fork.body.id}`, {
    method: 'PUT',
    body: { description: 'edited, nothing to do with lineage' },
  });
  assert.strictEqual(put.status, 200);
  assert.strictEqual(put.body.parentId, parentId, 'a partial update must not silently orphan the fork');
  assert.strictEqual(put.body.parentName, 'Original');
});

test('a PUT can set lineage on a query that had none', async () => {
  const parentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const q = await api(server.url, '/api/queries', {
    method: 'POST', body: makeQuery({ name: 'Adopted later' }),
  });
  const put = await api(server.url, `/api/queries/${q.body.id}`, {
    method: 'PUT',
    body: { parentId, parentName: 'Late parent' },
  });
  assert.strictEqual(put.body.parentId, parentId);
  assert.strictEqual(put.body.parentName, 'Late parent');
});

test('lineage survives an import', async () => {
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
  assert.strictEqual(got.body.parentName, 'Imported parent');
});

test('an upsert import updates lineage on an existing row', async () => {
  const id = '33333333-3333-4333-8333-333333333333';
  const oldParent = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const newParent = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  await api(server.url, '/api/queries/import', {
    method: 'POST',
    body: {
      queries: [makeQuery({
        id, name: 'Before', updated: '2026-01-01T00:00:00Z', parentId: oldParent, parentName: 'Old',
      })],
    },
  });

  const res = await api(server.url, '/api/queries/import', {
    method: 'POST',
    body: {
      mode: 'upsert',
      queries: [makeQuery({
        id, name: 'After', updated: '2026-06-01T00:00:00Z', parentId: newParent, parentName: 'New',
      })],
    },
  });
  assert.strictEqual(res.body.updated, 1);

  const got = await api(server.url, `/api/queries/${id}`);
  assert.strictEqual(got.body.parentId, newParent);
  assert.strictEqual(got.body.parentName, 'New');
});

test('an import of a fork whose parent is absent still stores the pointer', async () => {
  // The common real case: exporting one fork without its ancestor. Refusing it, or
  // nulling the pointer, would lose the only record that it was ever derived work. The
  // pointer just has to be well-formed — resolvability is a separate question from format,
  // and this store has no row with this id either way.
  const id = '44444444-4444-4444-8444-444444444444';
  const neverExisted = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  await api(server.url, '/api/queries/import', {
    method: 'POST',
    body: { queries: [makeQuery({ id, name: 'Lonely fork', parentId: neverExisted, parentName: 'Ghost' })] },
  });
  const got = await api(server.url, `/api/queries/${id}`);
  assert.strictEqual(got.body.parentId, neverExisted);
});

test('a metadata blob cannot shadow the real lineage columns', async () => {
  // collectMetadata merges body.metadata wholesale, so a caller can put anything in it,
  // including keys that collide with real columns. toFrontend spreads that blob, so
  // lineage has to be assigned AFTER the spread or a client could fake a fork badge by
  // smuggling parentId through metadata.
  const realParent = 'ff111111-1111-4111-8111-111111111111';
  const res = await api(server.url, '/api/queries', {
    method: 'POST',
    body: makeQuery({
      name: 'Spoof attempt',
      parentId: realParent,
      parentName: 'Real',
      metadata: { parentId: 'spoofed', parentName: 'Spoofed' },
    }),
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.parentId, realParent, 'the column must win over the metadata blob');
  assert.strictEqual(res.body.parentName, 'Real');
});

// ---------------------------------------------------------------------------
// The format rule: parentId must be a UUID v4, the same one src/domain/validate.js
// enforces on the SPA side. A value that fails it is dropped — the record is still
// stored, just without a lineage pointer that could never resolve to a row in this
// store anyway (every id here is a UUID).
// ---------------------------------------------------------------------------

test('a non-UUID parentId is dropped on create — the query is still stored, not rejected', async () => {
  const res = await api(server.url, '/api/queries', {
    method: 'POST',
    body: makeQuery({ name: 'Hand-edited pointer', parentId: 'not-a-uuid', parentName: 'Ghost' }),
  });
  assert.strictEqual(res.status, 201, 'the record itself is still good and must not be rejected');
  assert.strictEqual(res.body.parentId, null);
  assert.strictEqual(res.body.parentName, '', 'the paired name is cleared along with the bad pointer');
});

test('an import item with a non-UUID parentId is stored anyway, with the pointer dropped rather than the item rejected', async () => {
  const id = '55555555-5555-4555-8555-555555555555';
  const res = await api(server.url, '/api/queries/import', {
    method: 'POST',
    body: { queries: [makeQuery({ id, name: 'Bulk import stray', parentId: 'p-123', parentName: 'Ghost' })] },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.rejected.length, 0, 'a bad pointer must not reject the whole item — only the pointer is dropped');
  assert.strictEqual(res.body.inserted, 1);

  const got = await api(server.url, `/api/queries/${id}`);
  assert.strictEqual(got.status, 200);
  assert.strictEqual(got.body.parentId, null);
  assert.strictEqual(got.body.parentName, '');
});

test('a malformed metadata blob does not take lineage down with it', async () => {
  const db = require('../db');
  db.prepare(`
    INSERT INTO queries (id, name, query, metadata, parent_id, parent_name, created, updated)
    VALUES ('broken', 'Bad metadata', 'q', '{not json', 'p-broken', 'Parent', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
  `).run();

  const got = await api(server.url, '/api/queries/broken');
  assert.strictEqual(got.status, 200);
  assert.strictEqual(got.body.parentId, 'p-broken');
  assert.strictEqual(got.body.parentName, 'Parent');
});

test('the export carries lineage', async () => {
  const res = await api(server.url, '/api/queries/export');
  assert.strictEqual(res.status, 200);
  const fork = res.body.queries.find((q) => q.name === 'Imported fork');
  assert.strictEqual(fork.parentId, '22222222-2222-4222-8222-222222222222');
});
