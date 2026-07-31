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

  it('inherits detection metadata (severity, confidence, queryType, platform)', () => {
    const enriched = q('p2', {
      name: 'Detection with metadata',
      severity: 'High',
      confidence: 'Medium',
      queryType: 'Detection',
      platform: 'Azure Sentinel',
    });
    const forkOfEnriched = makeFork(enriched, 'f3', '2026-07-31T12:00:00Z');
    expect(forkOfEnriched.severity).toBe('High');
    expect(forkOfEnriched.confidence).toBe('Medium');
    expect(forkOfEnriched.queryType).toBe('Detection');
    expect(forkOfEnriched.platform).toBe('Azure Sentinel');
  });

  it('inherits attack tactics and techniques', () => {
    const detection = q('p3', {
      name: 'Attack detection',
      attack: {
        tactics: ['Persistence', 'DefenseEvasion'],
        techniques: ['T1078.004', 'T1562.001'],
      },
    });
    const forkOfDetection = makeFork(detection, 'f4', '2026-07-31T12:30:00Z');
    expect(forkOfDetection.attack).toEqual({
      tactics: ['Persistence', 'DefenseEvasion'],
      techniques: ['T1078.004', 'T1562.001'],
    });
  });

  it('does not alias nested attack object to parent', () => {
    const detection = q('p4', {
      name: 'Detection with nested object',
      attack: {
        tactics: ['Persistence'],
        techniques: ['T1078.004'],
      },
    });
    const forkOfDetection = makeFork(detection, 'f5', '2026-07-31T13:00:00Z');
    // Mutate the fork's nested object
    forkOfDetection.attack.tactics.push('Execution');
    // Parent should not be affected
    expect(detection.attack.tactics).toEqual(['Persistence']);
  });

  it('inherits datasources, entity mappings, and other schema v4 fields', () => {
    const fullDetection = q('p5', {
      name: 'Full detection',
      dataSources: ['Azure AD', 'Office 365'],
      entityMappings: ['Account.Name', 'IP.Address'],
      falsePositives: 'Service accounts',
      references: ['https://example.com'],
      tuningNotes: 'Monitor for exceptions',
      lookback: '7d',
      version: '1.0.0',
      lastValidated: '2026-07-01T00:00:00Z',
      author: 'SOC Team',
      license: 'MIT',
    });
    const forkOfFull = makeFork(fullDetection, 'f6', '2026-07-31T13:30:00Z');
    expect(forkOfFull.dataSources).toEqual(['Azure AD', 'Office 365']);
    expect(forkOfFull.entityMappings).toEqual(['Account.Name', 'IP.Address']);
    expect(forkOfFull.falsePositives).toBe('Service accounts');
    expect(forkOfFull.references).toEqual(['https://example.com']);
    expect(forkOfFull.tuningNotes).toBe('Monitor for exceptions');
    expect(forkOfFull.lookback).toBe('7d');
    expect(forkOfFull.version).toBe('1.0.0');
    expect(forkOfFull.lastValidated).toBe('2026-07-01T00:00:00Z');
    expect(forkOfFull.author).toBe('SOC Team');
    expect(forkOfFull.license).toBe('MIT');
  });

  it('resets name to match parent name (inherit, not reset)', () => {
    const parent1 = q('p6', { name: 'Original Name' });
    const fork1 = makeFork(parent1, 'f7', '2026-07-31T14:00:00Z');
    expect(fork1.name).toBe('Original Name');
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
