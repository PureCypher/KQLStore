import { describe, it, expect } from 'vitest';
import { reviewProposal, buildProvenanceRecord } from '../proposal.js';

const draft = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Entra risky sign-in', description: 'Original', query: 'SigninLogs | take 1',
  category: 'Hunting', table: 'SigninLogs', tags: ['entra'], favorite: false, usageCount: 0,
  parentId: null, parentName: '',
};

describe('reviewProposal', () => {
  it('reports a valid field change as accepted-by-default', () => {
    const [change] = reviewProposal(draft, { name: 'Okta risky sign-in' });
    expect(change.field).toBe('name');
    expect(change.from).toBe('Entra risky sign-in');
    expect(change.to).toBe('Okta risky sign-in');
    expect(change.valid).toBe(true);
  });

  it('ignores a field the model returned unchanged', () => {
    expect(reviewProposal(draft, { name: 'Entra risky sign-in' })).toEqual([]);
  });

  it('rejects an invalid ATT&CK technique with a readable reason', () => {
    const [change] = reviewProposal(draft, { attack: { techniques: ['T1078.9'] } });
    expect(change.valid).toBe(false);
    expect(change.reason).toMatch(/T1078\.9/);
  });

  it('accepts a well-formed technique', () => {
    const [change] = reviewProposal(draft, { attack: { techniques: ['T1078.004'] } });
    expect(change.valid).toBe(true);
  });

  it('normalizes human-readable tactic names to the kebab-case vocabulary', () => {
    const [change] = reviewProposal(draft, { attack: { tactics: ['Credential Access', 'Initial Access'] } });
    expect(change.valid).toBe(true);
    expect(change.to.tactics).toEqual(['credential-access', 'initial-access']);
  });

  it('normalizes tactic case without touching already-canonical values', () => {
    const [change] = reviewProposal(draft, { attack: { tactics: ['credential-access', 'Defense Evasion'] } });
    expect(change.valid).toBe(true);
    expect(change.to.tactics).toEqual(['credential-access', 'defense-evasion']);
  });

  it('still rejects a tactic that is not in the vocabulary under any casing', () => {
    const [change] = reviewProposal(draft, { attack: { tactics: ['Credential Theft'] } });
    expect(change.valid).toBe(false);
    expect(change.reason).toMatch(/tactic/i);
  });

  it('normalizes lowercase technique ids to the T-prefixed form', () => {
    const [change] = reviewProposal(draft, { attack: { techniques: ['t1110.003', 'T1110'] } });
    expect(change.valid).toBe(true);
    expect(change.to.techniques).toEqual(['T1110.003', 'T1110']);
  });

  it('rejects a severity outside the vocabulary', () => {
    const [change] = reviewProposal(draft, { severity: 'Catastrophic' });
    expect(change.valid).toBe(false);
    expect(change.reason).toMatch(/severity/i);
  });

  it('rejects an empty query rather than letting it through', () => {
    const [change] = reviewProposal(draft, { query: '' });
    expect(change.valid).toBe(false);
  });

  it('rejects a name over 200 characters', () => {
    const [change] = reviewProposal(draft, { name: 'x'.repeat(201) });
    expect(change.valid).toBe(false);
  });

  it('drops tags over the cap but keeps the change valid', () => {
    const tags = Array.from({ length: 30 }, (_, i) => `t${i}`);
    const [change] = reviewProposal(draft, { tags });
    expect(change.valid).toBe(true);
    expect(change.to).toHaveLength(20);
  });

  it('handles several fields at once, each judged independently', () => {
    const out = reviewProposal(draft, { name: 'Okta', severity: 'Nope', description: 'Better' });
    expect(out).toHaveLength(3);
    expect(out.find((c) => c.field === 'name').valid).toBe(true);
    expect(out.find((c) => c.field === 'severity').valid).toBe(false);
    expect(out.find((c) => c.field === 'description').valid).toBe(true);
  });

  it('ignores fields the model is not allowed to set', () => {
    const out = reviewProposal(draft, { id: 'hijacked', usageCount: 9999, parentId: 'x' });
    expect(out).toEqual([]);
  });

  it('returns empty for a null or non-object proposal', () => {
    expect(reviewProposal(draft, null)).toEqual([]);
    expect(reviewProposal(draft, 'nope')).toEqual([]);
  });
});

describe('buildProvenanceRecord', () => {
  const ctx = {
    model: 'deepseek-v4-flash:cloud',
    generatedAt: '2026-07-31T14:02:11Z',
    redaction: 'applied',
    instruction: 'make this detect Okta instead of Entra',
  };

  it('records only accepted fields', () => {
    const accepted = [{ field: 'name', from: 'a', to: 'b', valid: true, reason: '' }];
    expect(buildProvenanceRecord(accepted, ctx).fields).toEqual(['name']);
  });

  it('does not record a proposed field that was rejected', () => {
    // The model proposed name AND query; the operator accepted only name.
    const accepted = [{ field: 'name', from: 'a', to: 'b', valid: true, reason: '' }];
    const record = buildProvenanceRecord(accepted, ctx);
    expect(record.fields).not.toContain('query');
  });

  it('records an empty fields array when nothing was accepted', () => {
    expect(buildProvenanceRecord([], ctx).fields).toEqual([]);
  });

  it('carries the redaction state through', () => {
    expect(buildProvenanceRecord([], { ...ctx, redaction: 'overridden' }).redaction).toBe('overridden');
  });

  it('truncates an over-long instruction', () => {
    const record = buildProvenanceRecord([], { ...ctx, instruction: 'x'.repeat(2000) });
    expect(record.instruction).toHaveLength(1000);
  });
});
