import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateQuery } from '../../src/domain/validate.js';
import { toSentinelRule } from '../../src/export/sentinelYaml.js';
import { toNavigatorLayer, coverageSummary } from '../../src/export/navigator.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/constants.js';

const pack = JSON.parse(readFileSync(new URL('../starter-pack.json', import.meta.url), 'utf8'));

describe('starter pack', () => {
  it('declares the current schema version', () => {
    expect(pack.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(pack.meta.totalQueries).toBe(pack.queries.length);
  });

  // The pack doubles as the worked example for the metadata schema, so it must survive
  // the same validator user-authored queries go through — with zero errors, not merely
  // "sanitised into shape".
  it.each(pack.queries.map((q) => [q.name, q]))('%s validates with no errors', (_name, q) => {
    const r = validateQuery(q);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('every query carries the metadata that makes it operable', () => {
    for (const q of pack.queries) {
      expect(q.attack.techniques.length, `${q.name} techniques`).toBeGreaterThan(0);
      expect(q.attack.tactics.length, `${q.name} tactics`).toBeGreaterThan(0);
      expect(q.falsePositives.length, `${q.name} falsePositives`).toBeGreaterThan(0);
      expect(q.tuningNotes.length, `${q.name} tuningNotes`).toBeGreaterThan(20);
      expect(q.references.length, `${q.name} references`).toBeGreaterThan(0);
      expect(q.severity).toBeTruthy();
      expect(q.lookback).toBeTruthy();
    }
  });

  it('uses stable ids so re-importing does not duplicate', () => {
    const ids = pack.queries.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('every query body is real KQL against its declared table', () => {
    for (const q of pack.queries) {
      expect(q.query, q.name).toContain(q.table);
      expect(q.query.split('\n').length, `${q.name} should be multi-line`).toBeGreaterThan(1);
      // Every query must bound its own time range — the single biggest cost lever.
      expect(q.query, `${q.name} must bound time`).toMatch(/ago\(|between\s*\(/);
    }
  });

  it('exports every entry as a Sentinel rule with no unexpected defaults', () => {
    for (const q of pack.queries) {
      const { yaml, warnings } = toSentinelRule(q);
      expect(yaml, q.name).toContain('kind: Scheduled');
      // A hunt legitimately warns that it is not an analytics rule, and an aggregating hunt
      // has no per-row entity to map — its output is a stacked list, not events.
      // A hunt or an investigation pivot legitimately warns that it is not an analytics
      // rule, and an aggregating hunt has no per-row entity to map — its output is a
      // stacked list, not events. Anything else means the pack is missing metadata.
      const allowed = q.queryType === 'AnalyticsRule'
        ? []
        : ['not AnalyticsRule', 'entity mappings'];
      const unexpected = warnings.filter((w) => !allowed.some((a) => w.includes(a)));
      expect(unexpected, `${q.name}: ${unexpected.join('; ')}`).toEqual([]);
    }
  });

  it('produces a Navigator layer covering every technique in the pack', () => {
    const layer = toNavigatorLayer(pack.queries);
    const inPack = new Set(pack.queries.flatMap((q) => q.attack.techniques));
    expect(new Set(layer.techniques.map((t) => t.techniqueID))).toEqual(inPack);
    expect(coverageSummary(pack.queries).unmappedQueries).toBe(0);
  });

  it('states plainly that these need tuning before use', () => {
    expect(pack.meta.notice).toMatch(/baselin/i);
    expect(pack.meta.notice).toMatch(/have not been validated|none of these have been validated/i);
  });
});
