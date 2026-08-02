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

  // --- Additional coverage: branches the brief's core list does not exercise. ---

  it('skips a prose line mixed in among otherwise valid rows, rather than treating it as a column', () => {
    const text = 'A\t0\tSystem.String\tstring\nnot a column name at all\tfoo\nB\t1\tSystem.Int32\tint';
    const out = parseGetSchema(text);
    expect(out.ok).toBe(true);
    expect(out.columns).toEqual([
      { name: 'A', type: 'string' },
      { name: 'B', type: 'int' },
    ]);
  });

  it('defaults to unknown when a header is present but has neither DataType nor ColumnType', () => {
    const out = parseGetSchema('ColumnName\tColumnOrdinal\nTimeGenerated\t0');
    expect(out.ok).toBe(true);
    expect(out.columns).toEqual([{ name: 'TimeGenerated', type: 'unknown' }]);
  });

  it('defaults to unknown when a data row is shorter than the header it followed', () => {
    const text = 'ColumnName\tColumnOrdinal\tDataType\tColumnType\nTimeGenerated';
    const out = parseGetSchema(text);
    expect(out.ok).toBe(true);
    expect(out.columns).toEqual([{ name: 'TimeGenerated', type: 'unknown' }]);
  });

  it('maps every System.* type name the brief lists', () => {
    const rows = [
      ['A', 'System.DateTime', 'datetime'],
      ['B', 'System.String', 'string'],
      ['C', 'System.Int32', 'int'],
      ['D', 'System.Int64', 'long'],
      ['E', 'System.Double', 'real'],
      ['F', 'System.Boolean', 'bool'],
      ['G', 'System.Guid', 'guid'],
      ['H', 'System.TimeSpan', 'timespan'],
      ['I', 'System.Object', 'dynamic'],
      ['J', 'System.SByte', 'bool'],
    ];
    const text = rows.map(([name, type], i) => `${name}\t${i}\t${type}\t${type}`).join('\n');
    const out = parseGetSchema(text);
    expect(out.ok).toBe(true);
    expect(out.columns).toEqual(rows.map(([name, , expected]) => ({ name, type: expected })));
  });

  it('passes through a type that is already a KQL type name, case included', () => {
    const out = parseGetSchema('A\t0\tSystem.String\tSTRING');
    expect(out.ok).toBe(true);
    expect(out.columns).toEqual([{ name: 'A', type: 'STRING' }]);
  });

  // --- Adversarial-review follow-up: two shapes that previously produced a confidently
  // wrong ok:true instead of an honest failure or a complete column list. ---

  it('discards both the table name and the continuation pipe when getschema is split across two lines', () => {
    // `SigninLogs\n| getschema` is how many practitioners actually write the query, and
    // pasting it along with the results used to leave `SigninLogs` behind as a phantom
    // bare-identifier line, read as a real (fabricated) column.
    const text = [
      'SigninLogs',
      '| getschema',
      'ColumnName\tColumnOrdinal\tDataType\tColumnType',
      'TimeGenerated\t0\tSystem.DateTime\tdatetime',
    ].join('\n');
    const out = parseGetSchema(text);
    expect(out.ok).toBe(true);
    expect(out.columns).toEqual([{ name: 'TimeGenerated', type: 'datetime' }]);
  });

  it('still strips the single-line `Table | getschema` form (regression guard)', () => {
    const text = 'SigninLogs | getschema\nColumnName\tColumnOrdinal\tDataType\tColumnType\nA\t0\tSystem.String\tstring';
    const out = parseGetSchema(text);
    expect(out.ok).toBe(true);
    expect(out.columns).toEqual([{ name: 'A', type: 'string' }]);
  });

  it('keeps a dotted or hyphenated column name instead of silently dropping it', () => {
    // Custom tables ingested from JSON or CSV genuinely have dotted/hyphenated column
    // names. Dropping them without saying so left the user with an incomplete schema and
    // no signal anything was lost — worse than either keeping them or rejecting outright.
    const text = [
      'ColumnName\tColumnOrdinal\tDataType\tColumnType',
      'Good1\t0\tSystem.String\tstring',
      'Bad.Name\t1\tSystem.String\tstring',
      'Good2\t2\tSystem.String\tstring',
      'Has-Hyphen\t3\tSystem.String\tstring',
    ].join('\n');
    const out = parseGetSchema(text);
    expect(out.ok).toBe(true);
    expect(out.columns).toEqual([
      { name: 'Good1', type: 'string' },
      { name: 'Bad.Name', type: 'string' },
      { name: 'Good2', type: 'string' },
      { name: 'Has-Hyphen', type: 'string' },
    ]);
  });

  it('still rejects prose after widening the identifier rule to allow dots and hyphens', () => {
    const out = parseGetSchema('Hello there\nSigninLogs is the table you want');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/does not look like getschema output/i);
  });
});
