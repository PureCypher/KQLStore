import { describe, it, expect } from 'vitest';
import { validateQuery } from '../validate.js';
import { migrateData } from '../migrate.js';
import { CURRENT_SCHEMA_VERSION, ATTACK_TACTICS } from '../../constants.js';

const base = () => ({
  id: '3f2b1c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d',
  name: 'Encoded PowerShell',
  query: 'DeviceProcessEvents | take 1',
  table: 'DeviceProcessEvents',
});

describe('detection metadata (schema v4)', () => {
  it('accepts a fully populated detection block', () => {
    const r = validateQuery({
      ...base(),
      queryType: 'Hunting',
      severity: 'High',
      confidence: 'Medium',
      platform: ['Windows'],
      attack: { tactics: ['execution', 'defense-evasion'], techniques: ['T1059.001', 'T1027'] },
      dataSources: { connectors: ['MicrosoftThreatProtection'], tables: ['DeviceProcessEvents'] },
      entityMappings: [{ entityType: 'Host', identifier: 'HostName', columnName: 'DeviceName' }],
      falsePositives: ['Configuration management uses -enc for quoting'],
      references: ['https://attack.mitre.org/techniques/T1059/001/'],
      tuningNotes: 'Baseline InitiatingProcessFileName before promoting to a rule.',
      lookback: '7d',
      version: '1.2.0',
      lastValidated: '2026-07-26',
      author: 'liam',
      license: 'CC0-1.0',
    });
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.sanitized.attack.techniques).toEqual(['T1059.001', 'T1027']);
    expect(r.sanitized.entityMappings[0].columnName).toBe('DeviceName');
  });

  // The whole point of a validated field rather than a free-text tag: a typo is caught.
  it('rejects a malformed technique id', () => {
    const r = validateQuery({ ...base(), attack: { techniques: ['T1059.01'] } });
    expect(r.errors.some((e) => e.includes('T1059.01'))).toBe(true);
    expect(r.sanitized.attack?.techniques ?? []).not.toContain('T1059.01');
  });

  it('accepts every documented tactic and rejects an invented one', () => {
    const ok = validateQuery({ ...base(), attack: { tactics: ATTACK_TACTICS } });
    expect(ok.errors).toEqual([]);
    const bad = validateQuery({ ...base(), attack: { tactics: ['world-domination'] } });
    expect(bad.errors.some((e) => e.includes('world-domination'))).toBe(true);
  });

  it.each([
    ['severity', 'Catastrophic'],
    ['confidence', 'Certain'],
    ['queryType', 'Dashboard'],
  ])('rejects an out-of-vocabulary %s', (field, value) => {
    const r = validateQuery({ ...base(), [field]: value });
    expect(r.errors.some((e) => e.startsWith(field))).toBe(true);
    expect(r.sanitized[field]).toBeUndefined();
  });

  it.each([['7days'], ['d7'], ['7 d'], ['']])('rejects lookback %s', (value) => {
    const r = validateQuery({ ...base(), lookback: value });
    expect(r.sanitized.lookback).toBeUndefined();
  });

  it('accepts KQL timespan literals', () => {
    for (const t of ['7d', '90m', '1h', '30s', '500ms']) {
      expect(validateQuery({ ...base(), lookback: t }).sanitized.lookback).toBe(t);
    }
  });

  // A reference field is a link, not a script sink.
  it('rejects non-http reference URLs', () => {
    const r = validateQuery({
      ...base(),
      references: ['https://good.example/a', 'javascript:alert(1)', 'not a url'],
    });
    expect(r.sanitized.references).toEqual(['https://good.example/a']);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('drops entity mappings with an unknown type or no column', () => {
    const r = validateQuery({
      ...base(),
      entityMappings: [
        { entityType: 'Host', identifier: 'HostName', columnName: 'DeviceName' },
        { entityType: 'Spaceship', columnName: 'X' },
        { entityType: 'IP' },
      ],
    });
    expect(r.sanitized.entityMappings).toHaveLength(1);
  });

  it('leaves a plain v3 record untouched', () => {
    const r = validateQuery(base());
    expect(r.valid).toBe(true);
    for (const k of ['attack', 'severity', 'queryType', 'lookback', 'references']) {
      expect(r.sanitized).not.toHaveProperty(k);
    }
  });

  it('de-duplicates tactics and techniques', () => {
    const r = validateQuery({
      ...base(),
      attack: { tactics: ['execution', 'execution'], techniques: ['T1059', 'T1059'] },
    });
    expect(r.sanitized.attack.tactics).toEqual(['execution']);
    expect(r.sanitized.attack.techniques).toEqual(['T1059']);
  });
});

describe('v3 to v4 migration', () => {
  it('promotes technique ids smuggled into tags, and clears them from tags', () => {
    const out = migrateData({
      schemaVersion: 3,
      queries: [{ id: 'a', name: 'n', query: 'q', tags: ['powershell', 't1059', 'T1218.010'] }],
    });
    expect(out.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(out.queries[0].attack.techniques).toEqual(['T1059', 'T1218.010']);
    expect(out.queries[0].tags).toEqual(['powershell']);
  });

  it('leaves a query with no technique tags alone', () => {
    const input = { id: 'b', name: 'n', query: 'q', tags: ['ops', 'weekly'] };
    const out = migrateData({ schemaVersion: 3, queries: [input] });
    expect(out.queries[0]).toEqual(input);
  });

  it('merges into an existing attack block rather than replacing it', () => {
    const out = migrateData({
      schemaVersion: 3,
      queries: [{ id: 'c', name: 'n', query: 'q', tags: ['t1027'], attack: { tactics: ['execution'], techniques: ['T1059'] } }],
    });
    expect(out.queries[0].attack.tactics).toEqual(['execution']);
    expect(out.queries[0].attack.techniques).toEqual(['T1059', 'T1027']);
  });

  it('is idempotent', () => {
    const once = migrateData({ schemaVersion: 3, queries: [{ id: 'd', name: 'n', query: 'q', tags: ['t1059'] }] });
    expect(migrateData(once).queries).toEqual(once.queries);
  });

  // Previously this fell through every branch, returned the blob restamped as the current
  // version, and the caller wrote that downgrade back — destroying the version marker.
  it('refuses to downgrade data written by a newer build', () => {
    const out = migrateData({ schemaVersion: 99, queries: [{ id: 'e' }] });
    expect(out.tooNew).toBe(true);
    expect(out.schemaVersion).toBe(99);
  });
});
