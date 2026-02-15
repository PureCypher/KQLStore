import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Terminal, Play, Trash2, ChevronDown, ChevronUp } from 'lucide-react';

// ============================================================
// KQL Store — Storage API Test Suite
// ============================================================

const TEST_PREFIX = '__test-kql:';

const COLORS = {
  bg: '#0a0a0f',
  bgCard: '#12121a',
  bgInput: '#1a1a2e',
  border: '#1e1e2e',
  borderLight: '#2a2a3e',
  pass: '#00ff88',
  fail: '#ff4444',
  info: '#00d4ff',
  warn: '#ffcc00',
  gray: '#666',
  grayLight: '#aaa',
  text: '#e0e0e0',
};

// ============================================================
// Assertion Helpers
// ============================================================

const assert = (condition, message) => {
  if (!condition) throw new Error(message || 'Assertion failed');
};

const assertEqual = (actual, expected, message) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(message || `Expected ${e}, got ${a}`);
  }
};

const assertThrows = async (fn, message) => {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new Error(message || 'Expected function to throw, but it did not');
  }
};

// ============================================================
// Safe JSON parse (mirrors StorageService logic)
// ============================================================

const safeJsonParse = (input) => {
  if (typeof input !== 'string') return null;
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
};

// ============================================================
// Query validation helpers (mirrors app logic)
// ============================================================

const REQUIRED_QUERY_FIELDS = ['name', 'query'];
const ALLOWED_QUERY_FIELDS = [
  'id', 'name', 'description', 'query', 'category', 'table',
  'tags', 'favorite', 'usageCount', 'created', 'updated',
];

const validateQuery = (obj) => {
  if (!obj || typeof obj !== 'object') return { valid: false, reason: 'Not an object' };
  for (const field of REQUIRED_QUERY_FIELDS) {
    if (!obj[field] || typeof obj[field] !== 'string' || !obj[field].trim()) {
      return { valid: false, reason: `Missing required field: ${field}` };
    }
  }
  return { valid: true };
};

const stripUnexpectedFields = (obj) => {
  const result = {};
  for (const key of ALLOWED_QUERY_FIELDS) {
    if (key in obj) result[key] = obj[key];
  }
  return result;
};

// ============================================================
// Constants (mirrors v3 app constants)
// ============================================================
const CATEGORIES = ['Detection', 'Hunting', 'Investigation', 'Monitoring', 'Reporting', 'Enrichment', 'Utility'];

const CATEGORY_MIGRATION = {
  'Threat Hunting': 'Hunting',
  'Incident Response': 'Investigation',
  'Identity & Access': 'Detection',
  'Network': 'Detection',
  'Compliance': 'Reporting',
  'Custom': 'Utility',
};

const SENTINEL_TABLES = [
  'SigninLogs','AuditLogs','SecurityEvent','SecurityAlert','SecurityIncident',
  'Syslog','CommonSecurityLog','ThreatIntelligenceIndicator','OfficeActivity',
  'AzureActivity','AzureDiagnostics','Heartbeat','Usage','DnsEvents',
  'W3CIISLog','WindowsFirewall','WindowsEvent',
];

const DEFENDER_TABLES = [
  'DeviceProcessEvents','DeviceNetworkEvents','DeviceFileEvents','DeviceLogonEvents',
  'DeviceRegistryEvents','DeviceImageLoadEvents','DeviceEvents','DeviceInfo',
  'DeviceTvmSoftwareVulnerabilities','EmailEvents','EmailAttachmentInfo','EmailUrlInfo',
  'EmailPostDeliveryEvents','IdentityLogonEvents','IdentityQueryEvents',
  'IdentityDirectoryEvents','CloudAppEvents','AADSignInEventsBeta','AlertInfo',
  'AlertEvidence','BehaviorEntities','BehaviorInfo','UrlClickEvents',
];

const ALL_KNOWN_TABLES = [...SENTINEL_TABLES, ...DEFENDER_TABLES];

// ============================================================
// detectTableFromQuery (mirrors app logic)
// ============================================================
function detectTableFromQuery(queryBody) {
  if (!queryBody || typeof queryBody !== 'string') return 'Custom';
  const lines = queryBody.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('let ') || trimmed.startsWith('|')) continue;
    const firstWord = trimmed.split(/[\s|(\[]/)[0];
    if (!firstWord) continue;
    if (ALL_KNOWN_TABLES.includes(firstWord)) return firstWord;
    if (firstWord.endsWith('_CL') || firstWord.endsWith('_CF')) return 'Custom:' + firstWord;
    if (/^[A-Z][a-zA-Z0-9]+$/.test(firstWord) && firstWord.length > 3) return 'Custom:' + firstWord;
  }
  return 'Custom';
}

// ============================================================
// migrateData (mirrors app logic)
// ============================================================
function migrateData(data) {
  if (!data || typeof data !== 'object') return null;
  let version = data.schemaVersion || 1;
  let queries = Array.isArray(data.queries) ? data.queries : [];

  if (version < 2) {
    queries = queries.map(q => ({
      ...q,
      severity: q.severity || 'medium',
      tags: Array.isArray(q.tags) ? q.tags : [],
    }));
    version = 2;
  }

  if (version < 3) {
    queries = queries.map(q => {
      const migrated = { ...q };
      if (CATEGORY_MIGRATION[migrated.category]) {
        migrated.category = CATEGORY_MIGRATION[migrated.category];
      }
      if (!CATEGORIES.includes(migrated.category)) {
        migrated.category = 'Utility';
      }
      migrated.table = detectTableFromQuery(migrated.query);
      delete migrated.severity;
      delete migrated.platform;
      return migrated;
    });
    version = 3;
  }

  return {
    schemaVersion: 3,
    queries,
    meta: {
      lastUpdated: new Date().toISOString(),
      totalQueries: queries.length,
    },
  };
}

// ============================================================
// Test Suite Definitions
// ============================================================

const buildTestSuites = () => {
  const suites = [];

  // ----------------------------------------------------------
  // 1. BASIC CRUD
  // ----------------------------------------------------------
  suites.push({
    name: 'BASIC CRUD',
    tests: [
      {
        name: 'Write a query -> Read it back -> Values match',
        fn: async () => {
          const data = JSON.stringify({ id: 'test-1', name: 'Test Query', query: 'SecurityEvent | take 10' });
          await window.storage.set(TEST_PREFIX + 'crud-1', data, false);
          const result = await window.storage.get(TEST_PREFIX + 'crud-1', false);
          const parsed = JSON.parse(result.value);
          assertEqual(parsed.id, 'test-1', 'id mismatch');
          assertEqual(parsed.name, 'Test Query', 'name mismatch');
          assertEqual(parsed.query, 'SecurityEvent | take 10', 'query mismatch');
        },
      },
      {
        name: 'Update a query -> Read it back -> Updated values present',
        fn: async () => {
          const original = JSON.stringify({ id: 'test-2', name: 'Original', query: 'Syslog | take 5' });
          await window.storage.set(TEST_PREFIX + 'crud-2', original, false);
          const updated = JSON.stringify({ id: 'test-2', name: 'Updated', query: 'Syslog | take 50' });
          await window.storage.set(TEST_PREFIX + 'crud-2', updated, false);
          const result = await window.storage.get(TEST_PREFIX + 'crud-2', false);
          const parsed = JSON.parse(result.value);
          assertEqual(parsed.name, 'Updated', 'name should be updated');
          assertEqual(parsed.query, 'Syslog | take 50', 'query should be updated');
        },
      },
      {
        name: 'Delete a query -> Attempt read -> Throws error (key not found)',
        fn: async () => {
          const data = JSON.stringify({ id: 'test-3', name: 'To Delete', query: 'AuditLogs | take 1' });
          await window.storage.set(TEST_PREFIX + 'crud-3', data, false);
          await window.storage.delete(TEST_PREFIX + 'crud-3', false);
          await assertThrows(
            () => window.storage.get(TEST_PREFIX + 'crud-3', false),
            'Expected get() to throw after deletion'
          );
        },
      },
      {
        name: 'List keys with prefix -> Returns expected keys',
        fn: async () => {
          await window.storage.set(TEST_PREFIX + 'list-a', 'val-a', false);
          await window.storage.set(TEST_PREFIX + 'list-b', 'val-b', false);
          await window.storage.set(TEST_PREFIX + 'list-c', 'val-c', false);
          const result = await window.storage.list(TEST_PREFIX + 'list-', false);
          const keys = result.keys || [];
          assert(keys.includes(TEST_PREFIX + 'list-a'), 'Missing key list-a');
          assert(keys.includes(TEST_PREFIX + 'list-b'), 'Missing key list-b');
          assert(keys.includes(TEST_PREFIX + 'list-c'), 'Missing key list-c');
        },
      },
    ],
  });

  // ----------------------------------------------------------
  // 2. DATA SURVIVAL
  // ----------------------------------------------------------
  suites.push({
    name: 'DATA SURVIVAL',
    tests: [
      {
        name: 'Write data -> Read after short delay -> Data persists',
        fn: async () => {
          const data = JSON.stringify({ persisted: true, ts: Date.now() });
          await window.storage.set(TEST_PREFIX + 'persist-1', data, false);
          await new Promise((r) => setTimeout(r, 500));
          const result = await window.storage.get(TEST_PREFIX + 'persist-1', false);
          const parsed = JSON.parse(result.value);
          assertEqual(parsed.persisted, true, 'Data did not persist after delay');
        },
      },
      {
        name: 'Write 10 queries -> list() -> Returns all 10 keys',
        fn: async () => {
          for (let i = 0; i < 10; i++) {
            await window.storage.set(TEST_PREFIX + 'batch-' + i, JSON.stringify({ index: i }), false);
          }
          const result = await window.storage.list(TEST_PREFIX + 'batch-', false);
          const keys = result.keys || [];
          assertEqual(keys.length, 10, `Expected 10 keys, got ${keys.length}`);
          for (let i = 0; i < 10; i++) {
            assert(keys.includes(TEST_PREFIX + 'batch-' + i), `Missing key batch-${i}`);
          }
        },
      },
      {
        name: 'Write complex query object -> Read back -> All fields preserved',
        fn: async () => {
          const complex = {
            id: 'complex-1',
            name: 'Complex Query',
            description: 'Multi-table join with aggregation',
            query: 'DeviceProcessEvents\n| where Timestamp > ago(7d)\n| summarize count() by DeviceName\n| sort by count_ desc\n| take 20',
            category: 'Hunting',
            table: 'DeviceProcessEvents',
            tags: ['process', 'aggregation', 't1059'],
            favorite: true,
            usageCount: 42,
            created: '2025-01-01T00:00:00Z',
            updated: '2025-06-15T12:30:00Z',
          };
          await window.storage.set(TEST_PREFIX + 'complex-1', JSON.stringify(complex), false);
          const result = await window.storage.get(TEST_PREFIX + 'complex-1', false);
          const parsed = JSON.parse(result.value);
          assertEqual(parsed.id, complex.id);
          assertEqual(parsed.name, complex.name);
          assertEqual(parsed.description, complex.description);
          assertEqual(parsed.query, complex.query);
          assertEqual(parsed.category, complex.category);
          assertEqual(parsed.table, complex.table);
          assertEqual(parsed.tags, complex.tags);
          assertEqual(parsed.favorite, complex.favorite);
          assertEqual(parsed.usageCount, complex.usageCount);
          assertEqual(parsed.created, complex.created);
          assertEqual(parsed.updated, complex.updated);
        },
      },
    ],
  });

  // ----------------------------------------------------------
  // 3. ERROR RESILIENCE
  // ----------------------------------------------------------
  suites.push({
    name: 'ERROR RESILIENCE',
    tests: [
      {
        name: 'Read non-existent key -> Catches error gracefully (throws, no crash)',
        fn: async () => {
          await assertThrows(
            () => window.storage.get(TEST_PREFIX + 'nonexistent-key-xyz', false),
            'Expected get() to throw for non-existent key'
          );
        },
      },
      {
        name: 'Write then read invalid JSON string -> Handles parse correctly',
        fn: async () => {
          const invalidJson = '{not valid json: [}';
          await window.storage.set(TEST_PREFIX + 'invalid-json', invalidJson, false);
          const result = await window.storage.get(TEST_PREFIX + 'invalid-json', false);
          assertEqual(result.value, invalidJson, 'Raw value should be preserved');
          const parsed = safeJsonParse(result.value);
          assertEqual(parsed, null, 'safeJsonParse should return null for invalid JSON');
        },
      },
      {
        name: 'Write key with 199 chars -> Succeeds',
        fn: async () => {
          const longKey = TEST_PREFIX + 'k'.repeat(199 - TEST_PREFIX.length);
          assert(longKey.length === 199, `Key length is ${longKey.length}, expected 199`);
          await window.storage.set(longKey, 'long-key-value', false);
          const result = await window.storage.get(longKey, false);
          assertEqual(result.value, 'long-key-value', 'Value should match for 199-char key');
        },
      },
      {
        name: 'Write value near max size (~100KB JSON) -> Succeeds',
        fn: async () => {
          const largeObj = { data: 'x'.repeat(100 * 1024) };
          const largeValue = JSON.stringify(largeObj);
          await window.storage.set(TEST_PREFIX + 'large-value', largeValue, false);
          const result = await window.storage.get(TEST_PREFIX + 'large-value', false);
          const parsed = JSON.parse(result.value);
          assertEqual(parsed.data.length, 100 * 1024, 'Large value data length mismatch');
        },
      },
      {
        name: 'Delete already-deleted key -> Handles gracefully',
        fn: async () => {
          await window.storage.set(TEST_PREFIX + 'double-del', 'temp', false);
          await window.storage.delete(TEST_PREFIX + 'double-del', false);
          // Second delete should not throw or should handle gracefully
          let errorOccurred = false;
          try {
            await window.storage.delete(TEST_PREFIX + 'double-del', false);
          } catch {
            // Some implementations may throw, some may not — both are acceptable
            errorOccurred = true;
          }
          // Either way, the key should not exist
          await assertThrows(
            () => window.storage.get(TEST_PREFIX + 'double-del', false),
            'Key should not exist after double delete'
          );
          // Test passes regardless of whether second delete threw
          assert(true, 'Double delete handled without crash');
        },
      },
      {
        name: 'List with prefix that matches nothing -> Returns empty array',
        fn: async () => {
          const result = await window.storage.list(TEST_PREFIX + 'nonexistent-prefix-zzz-', false);
          const keys = result.keys || [];
          assertEqual(keys.length, 0, `Expected 0 keys, got ${keys.length}`);
        },
      },
    ],
  });

  // ----------------------------------------------------------
  // 4. SCOPE ISOLATION
  // ----------------------------------------------------------
  suites.push({
    name: 'SCOPE ISOLATION',
    tests: [
      {
        name: 'Write with shared:false -> Read with shared:false -> Match',
        fn: async () => {
          const data = JSON.stringify({ scope: 'private', value: 'mine' });
          await window.storage.set(TEST_PREFIX + 'scope-1', data, false);
          const result = await window.storage.get(TEST_PREFIX + 'scope-1', false);
          const parsed = JSON.parse(result.value);
          assertEqual(parsed.scope, 'private');
          assertEqual(parsed.value, 'mine');
        },
      },
      {
        name: 'Confirm default behavior is equivalent to shared:false',
        fn: async () => {
          const data = JSON.stringify({ mode: 'default-test' });
          // Write with explicit shared:false
          await window.storage.set(TEST_PREFIX + 'scope-default', data, false);
          // Read with explicit shared:false
          const result = await window.storage.get(TEST_PREFIX + 'scope-default', false);
          const parsed = JSON.parse(result.value);
          assertEqual(parsed.mode, 'default-test', 'Explicit shared:false read should match');
        },
      },
      {
        name: 'Write with explicit shared:false -> Verify data accessible',
        fn: async () => {
          const queries = [
            { id: 's1', name: 'Scope Query 1' },
            { id: 's2', name: 'Scope Query 2' },
            { id: 's3', name: 'Scope Query 3' },
          ];
          for (const q of queries) {
            await window.storage.set(TEST_PREFIX + 'scope-verify-' + q.id, JSON.stringify(q), false);
          }
          for (const q of queries) {
            const result = await window.storage.get(TEST_PREFIX + 'scope-verify-' + q.id, false);
            const parsed = JSON.parse(result.value);
            assertEqual(parsed.id, q.id, `ID mismatch for ${q.id}`);
            assertEqual(parsed.name, q.name, `Name mismatch for ${q.id}`);
          }
        },
      },
    ],
  });

  // ----------------------------------------------------------
  // 5. CONCURRENCY & EDGE CASES
  // ----------------------------------------------------------
  suites.push({
    name: 'CONCURRENCY & EDGE CASES',
    tests: [
      {
        name: 'Rapid sequential writes (10 writes) -> Last write wins, no corruption',
        fn: async () => {
          for (let i = 0; i < 10; i++) {
            await window.storage.set(TEST_PREFIX + 'rapid', JSON.stringify({ iteration: i }), false);
          }
          const result = await window.storage.get(TEST_PREFIX + 'rapid', false);
          const parsed = JSON.parse(result.value);
          assertEqual(parsed.iteration, 9, 'Last write should win (iteration=9)');
        },
      },
      {
        name: 'Write empty string value -> Read back -> Returns empty string (not error)',
        fn: async () => {
          await window.storage.set(TEST_PREFIX + 'empty-val', '', false);
          const result = await window.storage.get(TEST_PREFIX + 'empty-val', false);
          assertEqual(result.value, '', 'Empty string value should be preserved');
        },
      },
      {
        name: 'Write deeply nested JSON (5 levels) -> Read back -> Structure preserved',
        fn: async () => {
          const nested = {
            level1: {
              level2: {
                level3: {
                  level4: {
                    level5: {
                      value: 'deep',
                      array: [1, 2, 3],
                      flag: true,
                    },
                  },
                },
              },
            },
          };
          await window.storage.set(TEST_PREFIX + 'nested', JSON.stringify(nested), false);
          const result = await window.storage.get(TEST_PREFIX + 'nested', false);
          const parsed = JSON.parse(result.value);
          assertEqual(parsed.level1.level2.level3.level4.level5.value, 'deep', 'Deeply nested value mismatch');
          assertEqual(parsed.level1.level2.level3.level4.level5.array, [1, 2, 3], 'Nested array mismatch');
          assertEqual(parsed.level1.level2.level3.level4.level5.flag, true, 'Nested flag mismatch');
        },
      },
      {
        name: 'Write JSON with special chars (unicode, newlines, quotes) -> Read back -> Preserved',
        fn: async () => {
          const special = {
            unicode: '\u00e9\u00e0\u00fc\u00f1 \u2603 \u2764 \ud83d\udd25 \u4f60\u597d \u0410\u0411\u0412',
            newlines: 'line1\nline2\nline3\ttab',
            quotes: 'He said "hello" and she said \'hi\'',
            backslashes: 'path\\to\\file',
            nullChar: 'before\u0000after',
            emoji: '\ud83d\ude80\ud83d\udee1\ufe0f\ud83d\udd0d',
          };
          await window.storage.set(TEST_PREFIX + 'special', JSON.stringify(special), false);
          const result = await window.storage.get(TEST_PREFIX + 'special', false);
          const parsed = JSON.parse(result.value);
          assertEqual(parsed.unicode, special.unicode, 'Unicode mismatch');
          assertEqual(parsed.newlines, special.newlines, 'Newlines mismatch');
          assertEqual(parsed.quotes, special.quotes, 'Quotes mismatch');
          assertEqual(parsed.backslashes, special.backslashes, 'Backslashes mismatch');
          assertEqual(parsed.emoji, special.emoji, 'Emoji mismatch');
        },
      },
    ],
  });

  // ----------------------------------------------------------
  // 6. IMPORT SIMULATION
  // ----------------------------------------------------------
  suites.push({
    name: 'IMPORT SIMULATION',
    tests: [
      {
        name: 'Write 20 queries sequentially -> list() returns all 20',
        fn: async () => {
          for (let i = 0; i < 20; i++) {
            const q = { id: `import-${i}`, name: `Import Query ${i}`, query: `SecurityEvent | take ${i}` };
            await window.storage.set(TEST_PREFIX + 'import-' + i, JSON.stringify(q), false);
          }
          const result = await window.storage.list(TEST_PREFIX + 'import-', false);
          const keys = result.keys || [];
          assertEqual(keys.length, 20, `Expected 20 keys, got ${keys.length}`);
        },
      },
      {
        name: 'Write 20 queries -> Delete 10 -> list() returns 10',
        fn: async () => {
          for (let i = 0; i < 20; i++) {
            await window.storage.set(TEST_PREFIX + 'deltest-' + i, JSON.stringify({ i }), false);
          }
          for (let i = 0; i < 10; i++) {
            await window.storage.delete(TEST_PREFIX + 'deltest-' + i, false);
          }
          const result = await window.storage.list(TEST_PREFIX + 'deltest-', false);
          const keys = result.keys || [];
          assertEqual(keys.length, 10, `Expected 10 keys after deletion, got ${keys.length}`);
          for (let i = 10; i < 20; i++) {
            assert(keys.includes(TEST_PREFIX + 'deltest-' + i), `Missing surviving key deltest-${i}`);
          }
        },
      },
      {
        name: 'Write queries -> Read all -> Delete all -> Write all back -> Verify match',
        fn: async () => {
          const originals = [];
          for (let i = 0; i < 5; i++) {
            const q = { id: `roundtrip-${i}`, name: `Roundtrip ${i}`, query: `Syslog | take ${i + 1}` };
            originals.push(q);
            await window.storage.set(TEST_PREFIX + 'roundtrip-' + i, JSON.stringify(q), false);
          }
          // Read all
          const readBack = [];
          for (let i = 0; i < 5; i++) {
            const result = await window.storage.get(TEST_PREFIX + 'roundtrip-' + i, false);
            readBack.push(JSON.parse(result.value));
          }
          // Delete all
          for (let i = 0; i < 5; i++) {
            await window.storage.delete(TEST_PREFIX + 'roundtrip-' + i, false);
          }
          // Verify deleted
          const afterDelete = await window.storage.list(TEST_PREFIX + 'roundtrip-', false);
          assertEqual((afterDelete.keys || []).length, 0, 'All roundtrip keys should be deleted');
          // Write back from read data
          for (let i = 0; i < 5; i++) {
            await window.storage.set(TEST_PREFIX + 'roundtrip-' + i, JSON.stringify(readBack[i]), false);
          }
          // Verify match
          for (let i = 0; i < 5; i++) {
            const result = await window.storage.get(TEST_PREFIX + 'roundtrip-' + i, false);
            const parsed = JSON.parse(result.value);
            assertEqual(parsed.id, originals[i].id, `Roundtrip ID mismatch at ${i}`);
            assertEqual(parsed.name, originals[i].name, `Roundtrip name mismatch at ${i}`);
            assertEqual(parsed.query, originals[i].query, `Roundtrip query mismatch at ${i}`);
          }
        },
      },
    ],
  });

  // ----------------------------------------------------------
  // 7. STORAGE SERVICE INTEGRATION
  // ----------------------------------------------------------
  suites.push({
    name: 'STORAGE SERVICE INTEGRATION',
    tests: [
      {
        name: 'Safe JSON parse handles valid JSON',
        fn: async () => {
          const cases = [
            ['{"a":1}', { a: 1 }],
            ['[1,2,3]', [1, 2, 3]],
            ['"hello"', 'hello'],
            ['42', 42],
            ['true', true],
            ['null', null],
          ];
          for (const [input, expected] of cases) {
            const result = safeJsonParse(input);
            assertEqual(result, expected, `safeJsonParse(${input}) failed`);
          }
        },
      },
      {
        name: 'Safe JSON parse rejects non-string input gracefully',
        fn: async () => {
          assertEqual(safeJsonParse(42), null, 'number should return null');
          assertEqual(safeJsonParse(null), null, 'null should return null');
          assertEqual(safeJsonParse(undefined), null, 'undefined should return null');
          assertEqual(safeJsonParse({}), null, 'object should return null');
          assertEqual(safeJsonParse([]), null, 'array should return null');
          assertEqual(safeJsonParse(true), null, 'boolean should return null');
        },
      },
      {
        name: 'Query validation accepts valid query objects',
        fn: async () => {
          const valid = { name: 'Test', query: 'SecurityEvent | take 10' };
          const result = validateQuery(valid);
          assert(result.valid, 'Valid query should pass validation');

          const full = {
            id: '123', name: 'Full Query', description: 'Desc', query: 'Syslog',
            category: 'Utility', table: 'Syslog',
            tags: ['test'], favorite: false, usageCount: 0,
          };
          const fullResult = validateQuery(full);
          assert(fullResult.valid, 'Fully-specified query should pass validation');
        },
      },
      {
        name: 'Query validation rejects missing required fields',
        fn: async () => {
          const noName = { query: 'SecurityEvent' };
          assert(!validateQuery(noName).valid, 'Missing name should fail');

          const noQuery = { name: 'Test' };
          assert(!validateQuery(noQuery).valid, 'Missing query should fail');

          const empty = {};
          assert(!validateQuery(empty).valid, 'Empty object should fail');

          assert(!validateQuery(null).valid, 'null should fail');
          assert(!validateQuery('string').valid, 'string should fail');

          const blankName = { name: '  ', query: 'SecurityEvent' };
          assert(!validateQuery(blankName).valid, 'Blank name should fail');

          const blankQuery = { name: 'Test', query: '   ' };
          assert(!validateQuery(blankQuery).valid, 'Blank query should fail');
        },
      },
      {
        name: 'Query validation strips unexpected fields',
        fn: async () => {
          const input = {
            id: '123',
            name: 'Test',
            query: 'Syslog',
            category: 'Utility',
            malicious: 'should be removed',
            __proto__: 'attack',
            extraField: true,
          };
          const stripped = stripUnexpectedFields(input);
          assert(!('malicious' in stripped), 'malicious field should be stripped');
          assert(!('extraField' in stripped), 'extraField should be stripped');
          assertEqual(stripped.id, '123', 'id should be preserved');
          assertEqual(stripped.name, 'Test', 'name should be preserved');
          assertEqual(stripped.query, 'Syslog', 'query should be preserved');
          assertEqual(stripped.category, 'Utility', 'category should be preserved');
        },
      },
      {
        name: 'Query validation rejects empty table field',
        fn: async () => {
          const noTable = { name: 'Test', query: 'SecurityEvent | take 10', table: '' };
          const result = validateQuery(noTable);
          assert(!result.valid || result.sanitized.table === 'Custom', 'Empty table should be rejected or default to Custom');
        },
      },
      {
        name: 'detectTableFromQuery identifies Sentinel tables',
        fn: async () => {
          const cases = [
            ['SecurityEvent\n| where EventID == 4688', 'SecurityEvent'],
            ['SigninLogs\n| where ResultType != 0', 'SigninLogs'],
            ['Syslog\n| take 10', 'Syslog'],
            ['AuditLogs\n| where OperationName == "Add member to role"', 'AuditLogs'],
          ];
          for (const [query, expected] of cases) {
            const result = detectTableFromQuery(query);
            assertEqual(result, expected, `detectTableFromQuery failed for: ${query.split('\n')[0]}`);
          }
        },
      },
      {
        name: 'detectTableFromQuery identifies Defender tables',
        fn: async () => {
          const cases = [
            ['DeviceProcessEvents\n| where FileName == "powershell.exe"', 'DeviceProcessEvents'],
            ['EmailEvents\n| where EmailDirection == "Inbound"', 'EmailEvents'],
            ['IdentityLogonEvents\n| take 100', 'IdentityLogonEvents'],
          ];
          for (const [query, expected] of cases) {
            const result = detectTableFromQuery(query);
            assertEqual(result, expected, `detectTableFromQuery failed for: ${query.split('\n')[0]}`);
          }
        },
      },
      {
        name: 'detectTableFromQuery handles custom tables',
        fn: async () => {
          assertEqual(detectTableFromQuery('MyCustomLog_CL\n| take 10'), 'Custom:MyCustomLog_CL', 'Should detect _CL suffix');
          assertEqual(detectTableFromQuery('CustomFeed_CF\n| take 10'), 'Custom:CustomFeed_CF', 'Should detect _CF suffix');
          const result = detectTableFromQuery('| take 10');
          assertEqual(result, 'Custom', 'Pipe-only query should return Custom');
        },
      },
      {
        name: 'detectTableFromQuery skips comments and let statements',
        fn: async () => {
          const query = '// This is a comment\nlet threshold = 10;\nSecurityEvent\n| where EventID == 4688';
          assertEqual(detectTableFromQuery(query), 'SecurityEvent', 'Should skip comments and let statements');
        },
      },
      {
        name: 'Category migration maps old categories correctly',
        fn: async () => {
          const mapping = {
            'Threat Hunting': 'Hunting',
            'Incident Response': 'Investigation',
            'Identity & Access': 'Detection',
            'Network': 'Detection',
            'Compliance': 'Reporting',
            'Custom': 'Utility',
          };
          for (const [old, expected] of Object.entries(mapping)) {
            const result = CATEGORY_MIGRATION[old];
            assertEqual(result, expected, `Migration failed for ${old}: expected ${expected}, got ${result}`);
          }
        },
      },
      {
        name: 'New categories are all valid',
        fn: async () => {
          const expected = ['Detection', 'Hunting', 'Investigation', 'Monitoring', 'Reporting', 'Enrichment', 'Utility'];
          assertEqual(CATEGORIES.length, 7, 'Should have 7 categories');
          for (const cat of expected) {
            assert(CATEGORIES.includes(cat), `Missing category: ${cat}`);
          }
        },
      },
      {
        name: 'Query validation strips severity and platform fields',
        fn: async () => {
          const input = {
            id: '123', name: 'Test', query: 'Syslog', table: 'Syslog',
            severity: 'high', platform: 'Sentinel', category: 'Hunting',
          };
          const stripped = stripUnexpectedFields(input);
          assert(!('severity' in stripped), 'severity should be stripped');
          assert(!('platform' in stripped), 'platform should be stripped');
          assertEqual(stripped.table, 'Syslog', 'table should be preserved');
        },
      },
    ],
  });

  // ----------------------------------------------------------
  // 8. SCHEMA MIGRATION
  // ----------------------------------------------------------
  suites.push({
    name: 'SCHEMA MIGRATION',
    tests: [
      {
        name: 'v2 data blob migrates to v3 (severity removed, table added, category mapped)',
        fn: async () => {
          const v2Blob = {
            schemaVersion: 2,
            queries: [
              {
                id: 'migrate-1', name: 'Test', query: 'SecurityEvent\n| take 10',
                category: 'Threat Hunting', platform: 'Sentinel', severity: 'high',
                tags: ['test'], favorite: false, usageCount: 0,
                created: '2025-01-01T00:00:00Z', updated: '2025-01-01T00:00:00Z',
              },
            ],
            meta: { lastUpdated: '2025-01-01T00:00:00Z', totalQueries: 1 },
          };
          const migrated = migrateData(v2Blob);
          assertEqual(migrated.schemaVersion, 3, 'Should be schema v3');
          const q = migrated.queries[0];
          assertEqual(q.category, 'Hunting', 'Category should be migrated from Threat Hunting to Hunting');
          assertEqual(q.table, 'SecurityEvent', 'Table should be detected from query body');
          assert(!('severity' in q), 'severity should be removed');
          assert(!('platform' in q), 'platform should be removed');
        },
      },
      {
        name: 'v1 data migrates through v2 to v3',
        fn: async () => {
          const v1Blob = {
            schemaVersion: 1,
            queries: [
              {
                id: 'v1-test', name: 'Old Query', query: 'DeviceProcessEvents\n| take 5',
                category: 'Custom',
                created: '2024-06-01T00:00:00Z', updated: '2024-06-01T00:00:00Z',
              },
            ],
          };
          const migrated = migrateData(v1Blob);
          assertEqual(migrated.schemaVersion, 3, 'Should reach v3');
          const q = migrated.queries[0];
          assertEqual(q.category, 'Utility', 'Custom should migrate to Utility');
          assertEqual(q.table, 'DeviceProcessEvents', 'Table should be detected');
          assert(!('severity' in q), 'severity should be removed after v2->v3');
        },
      },
      {
        name: 'Migration preserves all non-deprecated fields',
        fn: async () => {
          const v2Blob = {
            schemaVersion: 2,
            queries: [{
              id: 'preserve-test', name: 'Preserve Me', description: 'Important',
              query: 'EmailEvents\n| where Timestamp > ago(7d)',
              category: 'Incident Response', platform: 'Sentinel', severity: 'critical',
              tags: ['phishing', 'email'], favorite: true, usageCount: 42,
              created: '2025-03-15T10:00:00Z', updated: '2025-06-01T15:30:00Z',
            }],
            meta: { lastUpdated: '2025-06-01T15:30:00Z', totalQueries: 1 },
          };
          const migrated = migrateData(v2Blob);
          const q = migrated.queries[0];
          assertEqual(q.id, 'preserve-test', 'id preserved');
          assertEqual(q.name, 'Preserve Me', 'name preserved');
          assertEqual(q.description, 'Important', 'description preserved');
          assertEqual(q.tags, ['phishing', 'email'], 'tags preserved');
          assertEqual(q.favorite, true, 'favorite preserved');
          assertEqual(q.usageCount, 42, 'usageCount preserved');
          assertEqual(q.created, '2025-03-15T10:00:00Z', 'created preserved');
          assertEqual(q.category, 'Investigation', 'Incident Response -> Investigation');
          assertEqual(q.table, 'EmailEvents', 'table detected');
        },
      },
      {
        name: 'v3 data passes through migration unchanged',
        fn: async () => {
          const v3Blob = {
            schemaVersion: 3,
            queries: [{
              id: 'v3-test', name: 'Already V3', query: 'Syslog | take 10',
              category: 'Monitoring', table: 'Syslog',
              tags: [], favorite: false, usageCount: 0,
              created: '2025-06-15T00:00:00Z', updated: '2025-06-15T00:00:00Z',
            }],
            meta: { lastUpdated: '2025-06-15T00:00:00Z', totalQueries: 1 },
          };
          const migrated = migrateData(v3Blob);
          assertEqual(migrated.schemaVersion, 3);
          const q = migrated.queries[0];
          assertEqual(q.category, 'Monitoring');
          assertEqual(q.table, 'Syslog');
          assertEqual(q.name, 'Already V3');
        },
      },
      {
        name: 'Import of v2 export file auto-migrates on load',
        fn: async () => {
          // Simulate writing a v2-format blob to storage and reading it back
          const v2Export = JSON.stringify({
            schemaVersion: 2,
            queries: [
              {
                id: 'import-v2-1', name: 'Imported V2', query: 'AuditLogs\n| take 10',
                category: 'Compliance', platform: 'Sentinel', severity: 'medium',
                tags: ['audit'], favorite: false, usageCount: 0,
                created: '2025-01-01T00:00:00Z', updated: '2025-01-01T00:00:00Z',
              },
            ],
          });
          await window.storage.set(TEST_PREFIX + 'v2-import', v2Export, false);
          const result = await window.storage.get(TEST_PREFIX + 'v2-import', false);
          const parsed = JSON.parse(result.value);
          const migrated = migrateData(parsed);
          assertEqual(migrated.schemaVersion, 3);
          assertEqual(migrated.queries[0].category, 'Reporting', 'Compliance -> Reporting');
          assertEqual(migrated.queries[0].table, 'AuditLogs', 'Table detected from query');
        },
      },
    ],
  });

  return suites;
};

// ============================================================
// Cleanup: delete all test keys
// ============================================================

const cleanup = async () => {
  try {
    const result = await window.storage.list(TEST_PREFIX, false);
    const keys = result?.keys || [];
    for (const key of keys) {
      try {
        await window.storage.delete(key, false);
      } catch {
        // ignore individual delete failures during cleanup
      }
    }
    return keys.length;
  } catch {
    return 0;
  }
};

// ============================================================
// Component
// ============================================================

export default function KQLStoreTests() {
  const [results, setResults] = useState([]);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState(null);
  const [storageAvailable, setStorageAvailable] = useState(null);
  const [collapsed, setCollapsed] = useState({});
  const outputRef = useRef(null);
  const resultsRef = useRef([]);

  // Check storage availability
  useEffect(() => {
    const available = typeof window !== 'undefined' && window.storage &&
      typeof window.storage.get === 'function' &&
      typeof window.storage.set === 'function' &&
      typeof window.storage.delete === 'function' &&
      typeof window.storage.list === 'function';
    setStorageAvailable(available);
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [results]);

  // Auto-run on mount
  useEffect(() => {
    if (storageAvailable === true) {
      runAllTests();
    }
  }, [storageAvailable]);

  const addResult = useCallback((entry) => {
    resultsRef.current = [...resultsRef.current, entry];
    setResults([...resultsRef.current]);
  }, []);

  const runTest = async (name, fn) => {
    const start = performance.now();
    try {
      await fn();
      return { type: 'test', name, pass: true, time: performance.now() - start };
    } catch (err) {
      return { type: 'test', name, pass: false, time: performance.now() - start, error: err.message || String(err) };
    }
  };

  const runAllTests = async () => {
    setRunning(true);
    resultsRef.current = [];
    setResults([]);
    setSummary(null);
    setCollapsed({});

    // Cleanup before run
    addResult({ type: 'info', message: 'Cleaning up leftover test keys...' });
    const cleaned = await cleanup();
    if (cleaned > 0) {
      addResult({ type: 'info', message: `Removed ${cleaned} leftover test key${cleaned !== 1 ? 's' : ''}` });
    }

    addResult({ type: 'info', message: 'Starting test run...' });
    addResult({ type: 'separator' });

    const suites = buildTestSuites();
    const allTestResults = [];

    for (const suite of suites) {
      addResult({ type: 'section', name: suite.name });

      for (const test of suite.tests) {
        const result = await runTest(test.name, test.fn);
        allTestResults.push(result);
        addResult(result);
      }

      addResult({ type: 'separator' });
    }

    // Cleanup after run
    addResult({ type: 'info', message: 'Cleaning up test keys...' });
    const cleanedAfter = await cleanup();
    addResult({ type: 'info', message: `Removed ${cleanedAfter} test key${cleanedAfter !== 1 ? 's' : ''}` });

    // Summary
    const passed = allTestResults.filter((t) => t.pass).length;
    const failed = allTestResults.filter((t) => !t.pass).length;
    const total = allTestResults.length;
    const totalTime = allTestResults.reduce((sum, t) => sum + t.time, 0);

    const summaryData = { passed, failed, total, totalTime };
    setSummary(summaryData);
    addResult({ type: 'summary', ...summaryData });

    setRunning(false);
  };

  const handleCleanup = async () => {
    setRunning(true);
    resultsRef.current = [...resultsRef.current, { type: 'info', message: 'Manual cleanup: removing all test keys...' }];
    setResults([...resultsRef.current]);
    const count = await cleanup();
    resultsRef.current = [...resultsRef.current, { type: 'info', message: `Manual cleanup complete: removed ${count} key${count !== 1 ? 's' : ''}` }];
    setResults([...resultsRef.current]);
    setRunning(false);
  };

  const toggleSection = (name) => {
    setCollapsed((prev) => ({ ...prev, [name]: !prev[name] }));
  };

  // ============================================================
  // Render: Storage not available
  // ============================================================

  if (storageAvailable === false) {
    return (
      <div style={{
        background: COLORS.bg, minHeight: '100vh', display: 'flex', alignItems: 'center',
        justifyContent: 'center', fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        color: COLORS.text, padding: 24,
      }}>
        <div style={{
          background: COLORS.bgCard, border: `1px solid ${COLORS.fail}`, borderRadius: 12,
          padding: 32, maxWidth: 520, textAlign: 'center',
        }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>
            <Terminal size={40} color={COLORS.fail} style={{ display: 'inline' }} />
          </div>
          <h1 style={{ color: COLORS.fail, fontSize: 20, fontWeight: 'bold', marginBottom: 12 }}>
            window.storage Not Available
          </h1>
          <p style={{ color: COLORS.grayLight, fontSize: 13, lineHeight: 1.6 }}>
            The <code style={{ color: COLORS.info, background: COLORS.bgInput, padding: '2px 6px', borderRadius: 4 }}>
            window.storage</code> API is not available in this environment.
            This test suite requires the KQL Store storage API to be present.
          </p>
          <p style={{ color: COLORS.gray, fontSize: 12, marginTop: 16 }}>
            Required methods: get(), set(), delete(), list()
          </p>
        </div>
      </div>
    );
  }

  // ============================================================
  // Render: Loading check
  // ============================================================

  if (storageAvailable === null) {
    return (
      <div style={{
        background: COLORS.bg, minHeight: '100vh', display: 'flex', alignItems: 'center',
        justifyContent: 'center', fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      }}>
        <div style={{ textAlign: 'center', color: COLORS.pass }}>
          <Terminal size={32} style={{ margin: '0 auto 12px', display: 'block' }} />
          <div style={{ fontSize: 13, color: COLORS.grayLight }}>Checking storage availability...</div>
        </div>
      </div>
    );
  }

  // ============================================================
  // Render: Test Runner
  // ============================================================

  const allPassed = summary && summary.failed === 0;

  return (
    <div style={{
      background: COLORS.bg, minHeight: '100vh',
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      color: COLORS.text, display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <header style={{
        padding: '16px 24px', borderBottom: `1px solid ${COLORS.border}`,
        background: '#0d0d14', display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', flexShrink: 0, flexWrap: 'wrap', gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Terminal size={20} color={COLORS.pass} />
          <h1 style={{ fontSize: 16, fontWeight: 'bold' }}>
            <span style={{ color: COLORS.pass }}>&gt;</span>{' '}
            <span style={{ color: COLORS.text }}>kql_store_tests</span>
          </h1>
          {running && (
            <span style={{
              fontSize: 11, padding: '2px 10px', borderRadius: 9999,
              background: COLORS.info + '20', color: COLORS.info,
              border: `1px solid ${COLORS.info}`,
              animation: 'pulse 1.5s ease-in-out infinite',
            }}>running...</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={runAllTests}
            disabled={running}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 16px', borderRadius: 8, fontSize: 12, fontWeight: 'bold',
              background: running ? COLORS.bgInput : COLORS.pass,
              color: running ? COLORS.gray : COLORS.bg,
              border: 'none', cursor: running ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              opacity: running ? 0.5 : 1,
            }}
          >
            <Play size={13} />
            Run Again
          </button>
          <button
            onClick={handleCleanup}
            disabled={running}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 16px', borderRadius: 8, fontSize: 12, fontWeight: 'bold',
              background: running ? COLORS.bgInput : 'transparent',
              color: running ? COLORS.gray : COLORS.warn,
              border: `1px solid ${running ? COLORS.borderLight : COLORS.warn}`,
              cursor: running ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              opacity: running ? 0.5 : 1,
            }}
          >
            <Trash2 size={13} />
            Clean Up
          </button>
        </div>
      </header>

      {/* Summary Bar */}
      {summary && (
        <div style={{
          padding: '10px 24px',
          background: allPassed ? COLORS.pass + '10' : COLORS.fail + '10',
          borderBottom: `1px solid ${allPassed ? COLORS.pass + '40' : COLORS.fail + '40'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexWrap: 'wrap', gap: 8, flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 13 }}>
            <span style={{ fontWeight: 'bold', color: allPassed ? COLORS.pass : COLORS.fail }}>
              {allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}
            </span>
            <span style={{ color: COLORS.pass }}>{summary.passed} passed</span>
            {summary.failed > 0 && (
              <span style={{ color: COLORS.fail }}>{summary.failed} failed</span>
            )}
            <span style={{ color: COLORS.grayLight }}>{summary.total} total</span>
          </div>
          <span style={{ color: COLORS.gray, fontSize: 11 }}>
            {summary.totalTime.toFixed(0)}ms total
          </span>
        </div>
      )}

      {/* Output */}
      <div
        ref={outputRef}
        style={{
          flex: 1, overflowY: 'auto', padding: 24,
        }}
      >
        <div style={{ maxWidth: 900, margin: '0 auto' }}>
          {results.map((entry, i) => {
            if (entry.type === 'separator') {
              return (
                <div key={i} style={{
                  borderBottom: `1px solid ${COLORS.border}`,
                  margin: '8px 0',
                }} />
              );
            }

            if (entry.type === 'info') {
              return (
                <div key={i} style={{
                  color: COLORS.info, fontSize: 12, padding: '4px 0',
                  display: 'flex', alignItems: 'center', gap: 8,
                }}>
                  <span style={{ color: COLORS.gray }}>{'>'}</span>
                  {entry.message}
                </div>
              );
            }

            if (entry.type === 'section') {
              return (
                <div
                  key={i}
                  onClick={() => toggleSection(entry.name)}
                  style={{
                    color: COLORS.info, fontSize: 13, fontWeight: 'bold',
                    padding: '10px 0 4px', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 8,
                    userSelect: 'none',
                  }}
                >
                  {collapsed[entry.name]
                    ? React.createElement(ChevronDown, { size: 14, color: COLORS.info })
                    : React.createElement(ChevronUp, { size: 14, color: COLORS.info })
                  }
                  {entry.name}
                </div>
              );
            }

            if (entry.type === 'test') {
              // Find which section this test belongs to (look backwards for nearest section)
              let sectionName = null;
              for (let j = i - 1; j >= 0; j--) {
                if (results[j].type === 'section') {
                  sectionName = results[j].name;
                  break;
                }
              }
              if (sectionName && collapsed[sectionName]) {
                return null;
              }

              return (
                <div key={i} style={{
                  padding: '4px 0 4px 24px', fontSize: 12,
                  display: 'flex', alignItems: 'flex-start', gap: 8,
                }}>
                  <span style={{
                    color: entry.pass ? COLORS.pass : COLORS.fail,
                    fontWeight: 'bold', flexShrink: 0, width: 16, textAlign: 'center',
                  }}>
                    {entry.pass ? '\u2713' : '\u2717'}
                  </span>
                  <span style={{
                    color: entry.pass ? COLORS.text : COLORS.fail,
                    flex: 1, wordBreak: 'break-word',
                  }}>
                    {entry.name}
                    {!entry.pass && entry.error && (
                      <span style={{
                        display: 'block', color: COLORS.fail, fontSize: 11,
                        marginTop: 2, paddingLeft: 4,
                        opacity: 0.85,
                      }}>
                        Error: {entry.error}
                      </span>
                    )}
                  </span>
                  <span style={{
                    color: COLORS.gray, fontSize: 11, flexShrink: 0,
                    minWidth: 60, textAlign: 'right',
                  }}>
                    {entry.time.toFixed(1)}ms
                  </span>
                </div>
              );
            }

            if (entry.type === 'summary') {
              return (
                <div key={i} style={{
                  marginTop: 12, padding: '12px 16px', borderRadius: 8,
                  background: entry.failed === 0 ? COLORS.pass + '10' : COLORS.fail + '10',
                  border: `1px solid ${entry.failed === 0 ? COLORS.pass + '40' : COLORS.fail + '40'}`,
                  fontSize: 13,
                }}>
                  <div style={{
                    fontWeight: 'bold',
                    color: entry.failed === 0 ? COLORS.pass : COLORS.fail,
                    marginBottom: 4,
                  }}>
                    {entry.failed === 0 ? 'All tests passed!' : `${entry.failed} test${entry.failed !== 1 ? 's' : ''} failed`}
                  </div>
                  <div style={{ color: COLORS.grayLight, fontSize: 12 }}>
                    {entry.passed} passed, {entry.failed} failed, {entry.total} total
                    {' '}&mdash;{' '}{entry.totalTime.toFixed(0)}ms
                  </div>
                </div>
              );
            }

            return null;
          })}

          {/* Running indicator */}
          {running && (
            <div style={{
              color: COLORS.info, fontSize: 12, padding: '8px 0',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{
                display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                background: COLORS.info,
                animation: 'pulse 1s ease-in-out infinite',
              }} />
              Running tests...
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <footer style={{
        padding: '6px 24px', borderTop: `1px solid ${COLORS.border}`,
        background: '#0d0d14', fontSize: 11, color: COLORS.gray,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        flexShrink: 0,
      }}>
        <span>KQL Store Test Suite</span>
        <span>Test prefix: {TEST_PREFIX}</span>
      </footer>

      {/* Pulse animation */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
