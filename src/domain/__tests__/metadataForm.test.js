import { describe, it, expect } from 'vitest';
import { metadataToForm, formToMetadata } from '../metadataForm.js';
import { validateQuery } from '../validate.js';

const full = {
  queryType: 'Hunting',
  severity: 'High',
  confidence: 'Medium',
  platform: ['Windows'],
  attack: { tactics: ['execution'], techniques: ['T1059.001', 'T1027'] },
  falsePositives: ['SCCM uses -enc', 'Vendor installers'],
  tuningNotes: 'Baseline first.',
  references: ['https://attack.mitre.org/techniques/T1059/001/'],
  lookback: '7d',
  lastValidated: '2026-07-26',
  entityMappings: [{ entityType: 'Host', identifier: 'HostName', columnName: 'DeviceName' }],
};

describe('metadata form translation', () => {
  it('round-trips a fully populated block', () => {
    const back = formToMetadata(metadataToForm(full));
    for (const key of Object.keys(full)) {
      expect(back[key], key).toEqual(full[key]);
    }
  });

  // An empty field must be ABSENT, not ''. validateQuery treats a present-but-invalid
  // value as an error while an absent one is simply optional, so emitting empty strings
  // everywhere would make every untouched query fail validation.
  it('emits nothing for an untouched form', () => {
    expect(formToMetadata(metadataToForm({}))).toEqual({});
    expect(formToMetadata({})).toEqual({});
  });

  it('a query with an untouched metadata form still validates', () => {
    const r = validateQuery({
      id: '3f2b1c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d',
      name: 'n', query: 'SigninLogs | take 5', table: 'SigninLogs',
      ...formToMetadata(metadataToForm({})),
    });
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('drops invalid technique ids rather than failing the whole save', () => {
    const out = formToMetadata({ techniques: 'T1059.01, T1027, nonsense, T1003' });
    expect(out.attack.techniques).toEqual(['T1027', 'T1003']);
  });

  it('drops non-http references', () => {
    const out = formToMetadata({ references: 'https://ok.example\njavascript:alert(1)\nnot a url' });
    expect(out.references).toEqual(['https://ok.example']);
  });

  it('drops entity mappings missing a type or column', () => {
    const out = formToMetadata({
      entityMappings: [
        { entityType: 'Host', identifier: 'HostName', columnName: 'DeviceName' },
        { entityType: '', columnName: 'X' },
        { entityType: 'IP', columnName: '  ' },
      ],
    });
    expect(out.entityMappings).toHaveLength(1);
  });

  it('splits list fields on newlines and trims', () => {
    const out = formToMetadata({ falsePositives: '  one  \n\n two \n' });
    expect(out.falsePositives).toEqual(['one', 'two']);
  });

  it('omits an empty attack block rather than emitting empty arrays', () => {
    expect(formToMetadata({ tactics: [], techniques: '' })).not.toHaveProperty('attack');
  });

  // Everything the form produces must survive the validator untouched, or the editor
  // would quietly discard fields the user filled in.
  it('produces output validateQuery accepts with no errors', () => {
    const r = validateQuery({
      id: '3f2b1c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d',
      name: 'n', query: 'SigninLogs | take 5', table: 'SigninLogs',
      ...formToMetadata(metadataToForm(full)),
    });
    expect(r.errors).toEqual([]);
    expect(r.sanitized.attack.techniques).toEqual(['T1059.001', 'T1027']);
    expect(r.sanitized.entityMappings).toHaveLength(1);
  });
});
