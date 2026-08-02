import { describe, it, expect } from 'vitest';
import { selectRelevantSchemas } from '../relevantSchemas.js';

const schema = (name) => ({ name, columns: [{ name: 'TimeGenerated', type: 'datetime' }], notes: '' });
const store = [schema('SigninLogs'), schema('DeviceEvents'), schema('ZTSGraph'), schema('meraki_CL')];

const draft = (over = {}) => ({ name: '', description: '', query: '', table: '', ...over });

describe('selectRelevantSchemas', () => {
  it('matches the draft table field', () => {
    const { relevant, otherNames } = selectRelevantSchemas(store, draft({ table: 'SigninLogs' }), []);
    expect(relevant.map((s) => s.name)).toEqual(['SigninLogs']);
    expect(otherNames).toEqual(['DeviceEvents', 'ZTSGraph', 'meraki_CL']);
  });

  it('matches tables referenced in the query text', () => {
    const { relevant } = selectRelevantSchemas(store, draft({ query: 'DeviceEvents\n| take 1' }), []);
    expect(relevant.map((s) => s.name)).toEqual(['DeviceEvents']);
  });

  it('matches tables named anywhere in the conversation, case-insensitively', () => {
    const messages = [{ role: 'user', content: 'design a hunt on ztsgraph please' }];
    const { relevant } = selectRelevantSchemas(store, draft(), messages);
    expect(relevant.map((s) => s.name)).toEqual(['ZTSGraph']);
  });

  it('does not match a name embedded inside a longer identifier', () => {
    const { relevant } = selectRelevantSchemas(store, draft({ query: 'MySigninLogsExtra | take 1' }), []);
    expect(relevant).toEqual([]);
  });

  it('matches names containing underscores as whole words', () => {
    const { relevant } = selectRelevantSchemas(store, draft({ query: 'meraki_CL | take 1' }), []);
    expect(relevant.map((s) => s.name)).toEqual(['meraki_CL']);
  });

  it('returns every name as otherNames when nothing is referenced', () => {
    const { relevant, otherNames } = selectRelevantSchemas(store, draft(), [{ role: 'user', content: 'which table should I use for email clicks?' }]);
    expect(relevant).toEqual([]);
    expect(otherNames).toEqual(['SigninLogs', 'DeviceEvents', 'ZTSGraph', 'meraki_CL']);
  });

  it('unions matches across draft and messages without duplicates', () => {
    const messages = [{ role: 'user', content: 'join SigninLogs against DeviceEvents' }];
    const { relevant, otherNames } = selectRelevantSchemas(store, draft({ table: 'SigninLogs' }), messages);
    expect(relevant.map((s) => s.name)).toEqual(['SigninLogs', 'DeviceEvents']);
    expect(otherNames).toEqual(['ZTSGraph', 'meraki_CL']);
  });

  it('tolerates malformed inputs', () => {
    expect(selectRelevantSchemas([], null, undefined)).toEqual({ relevant: [], otherNames: [] });
    const { relevant } = selectRelevantSchemas(store, draft(), [{ role: 'user' }, null]);
    expect(relevant).toEqual([]);
  });
});
