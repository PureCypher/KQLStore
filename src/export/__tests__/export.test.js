import { describe, it, expect } from 'vitest';
import { toSentinelRule, toSentinelRuleSet } from '../sentinelYaml.js';
import { toNavigatorLayer, coverageSummary } from '../navigator.js';
import { toJsonExport } from '../json.js';
import { CURRENT_SCHEMA_VERSION } from '../../constants.js';

const full = {
  id: '3f2b1c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d',
  name: 'Encoded PowerShell execution',
  description: 'Detects encoded PowerShell.\nBehaviour-based.',
  query: 'DeviceProcessEvents\n| where Timestamp > ago(7d)\n| where FileName in~ ("powershell.exe")\n| project Timestamp, DeviceName',
  table: 'DeviceProcessEvents',
  severity: 'High',
  queryType: 'AnalyticsRule',
  attack: { tactics: ['execution', 'defense-evasion'], techniques: ['T1059.001', 'T1027'] },
  dataSources: { connectors: ['MicrosoftThreatProtection'], tables: ['DeviceProcessEvents'] },
  entityMappings: [{ entityType: 'Host', identifier: 'HostName', columnName: 'DeviceName' }],
  falsePositives: ['SCCM uses -enc'],
  lookback: '7d',
  version: '1.2.0',
  platform: ['Windows'],
};

describe('Sentinel YAML export', () => {
  it('emits the documented rule fields', () => {
    const { yaml } = toSentinelRule(full);
    expect(yaml).toContain('kind: Scheduled');
    expect(yaml).toContain('severity: High');
    expect(yaml).toContain('queryPeriod: 7d');
    expect(yaml).toContain('triggerOperator: gt');
    expect(yaml).toContain('  - connectorId: MicrosoftThreatProtection');
  });

  it('maps ATT&CK slugs to Sentinel PascalCase tactics', () => {
    const { yaml } = toSentinelRule(full);
    expect(yaml).toContain('  - Execution');
    expect(yaml).toContain('  - DefenseEvasion');
    expect(yaml).not.toContain('defense-evasion');
  });

  it('preserves multi-line KQL verbatim in a block scalar', () => {
    const { yaml } = toSentinelRule(full);
    const body = yaml.split('query: |-\n')[1].split('\nentityMappings')[0];
    const recovered = body.split('\n').map((l) => l.replace(/^ {2}/, '')).join('\n');
    expect(recovered).toBe(full.query);
  });

  it('emits entity mappings in Sentinel fieldMappings shape', () => {
    const { yaml } = toSentinelRule(full);
    expect(yaml).toContain('  - entityType: Host');
    expect(yaml).toContain('      - identifier: HostName');
    expect(yaml).toContain('        columnName: DeviceName');
  });

  // Silence about a default is how someone ships an unmapped rule believing it is mapped.
  it('warns about every field it had to default', () => {
    const { warnings } = toSentinelRule({ id: 'a', name: 'bare', query: 'Syslog | take 1' });
    expect(warnings.join(' ')).toMatch(/severity/);
    expect(warnings.join(' ')).toMatch(/tactics/);
    expect(warnings.join(' ')).toMatch(/lookback/);
    expect(warnings.join(' ')).toMatch(/entity mappings/);
  });

  it('warns when the query is not meant to be a rule', () => {
    const { warnings } = toSentinelRule({ ...full, queryType: 'Hunting' });
    expect(warnings.join(' ')).toMatch(/not AnalyticsRule/);
  });

  it('quotes names that would otherwise break the document', () => {
    const { yaml } = toSentinelRule({ ...full, name: 'name: with colon' });
    expect(yaml).toContain("name: 'name: with colon'");
  });

  it('joins many rules into one multi-document file', () => {
    const { yaml } = toSentinelRuleSet([full, { ...full, id: 'b', name: 'Second' }]);
    expect(yaml.split('---\n')).toHaveLength(2);
  });
});

describe('ATT&CK Navigator layer', () => {
  it('scores techniques by how many queries cover them', () => {
    const layer = toNavigatorLayer([full, { ...full, id: 'b', attack: { techniques: ['T1059.001'] } }]);
    const t = layer.techniques.find((x) => x.techniqueID === 'T1059.001');
    expect(t.score).toBe(2);
    expect(layer.techniques.find((x) => x.techniqueID === 'T1027').score).toBe(1);
  });

  it('names the contributing queries in the comment', () => {
    const layer = toNavigatorLayer([full]);
    expect(layer.techniques[0].comment).toContain('Encoded PowerShell execution');
  });

  it('produces a valid empty layer for an unmapped store', () => {
    const layer = toNavigatorLayer([{ id: 'x', name: 'n', query: 'q' }]);
    expect(layer.techniques).toEqual([]);
    expect(layer.gradient.maxValue).toBe(1);
    expect(layer.domain).toBe('enterprise-attack');
  });

  it('summarises coverage', () => {
    const s = coverageSummary([full, { id: 'b', name: 'n', query: 'q' }]);
    expect(s).toMatchObject({ totalQueries: 2, mappedQueries: 1, unmappedQueries: 1, uniqueTechniques: 2 });
  });
});

describe('JSON export', () => {
  it('carries the schema envelope so it can be migrated on re-import', () => {
    const parsed = JSON.parse(toJsonExport([full]));
    expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.queries).toHaveLength(1);
    expect(parsed.meta.totalQueries).toBe(1);
  });
});
