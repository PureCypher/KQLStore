import { describe, it, expect } from 'vitest';
import {
  detectTableFromQuery, getTableGroup, getTableDisplayName, isAsimTable, ASIM_PARSERS,
} from '../tables.js';

/**
 * These import the real module. Every case below is a query shape taken from published
 * Sentinel or Defender content, not an invented one — the point of the detector is to be
 * right about what practitioners actually write.
 */

describe('detectTableFromQuery', () => {
  describe('the simple shapes', () => {
    it.each([
      ['SigninLogs\n| take 5', 'SigninLogs'],
      ['DeviceProcessEvents | where X == 1', 'DeviceProcessEvents'],
      ['  \n\nSyslog\n| take 1', 'Syslog'],
      ['MyCustomLog_CL | take 1', 'Custom:MyCustomLog_CL'],
      ['MyFunction_CF | take 1', 'Custom:MyFunction_CF'],
      ['SomeOtherTable | take 1', 'Custom:SomeOtherTable'],
    ])('detects %s', (input, expected) => {
      expect(detectTableFromQuery(input)).toBe(expected);
    });

    it('falls back to Custom for empty or non-string input', () => {
      expect(detectTableFromQuery('')).toBe('Custom');
      expect(detectTableFromQuery(null)).toBe('Custom');
      expect(detectTableFromQuery(42)).toBe('Custom');
    });
  });

  describe('comments', () => {
    it('skips a leading line comment', () => {
      expect(detectTableFromQuery('// a comment\nSyslog | take 1')).toBe('Syslog');
    });

    it('skips a block comment, including a multi-line one', () => {
      const q = '/* Detection: brute force\n   Author: SOC\n   SigninLogs is mentioned here */\nSecurityEvent\n| take 1';
      expect(detectTableFromQuery(q)).toBe('SecurityEvent');
    });

    it('does not read a table name out of a comment', () => {
      expect(detectTableFromQuery('let x = 1; // SigninLogs\nx | take 1')).toBe('Custom');
    });

    it('does not read a table name out of a string literal', () => {
      expect(detectTableFromQuery('let x = 1;\nlet y = "SigninLogs";\nx | take 1')).toBe('Custom');
    });

    it('is not fooled by a // inside a URL literal', () => {
      const q = 'let u = "https://portal.azure.com/";\nAuditLogs\n| take 1';
      expect(detectTableFromQuery(q)).toBe('AuditLogs');
    });
  });

  describe('let statements', () => {
    // The old detector skipped the `let` LINE and then read the next line as the source,
    // so a let whose body was on its own line was attributed to the let body's table.
    it('skips the continuation lines of a multi-line let', () => {
      const q = [
        'let Interesting =',
        '    SigninLogs',
        '    | where ResultType == 0;',
        'DeviceLogonEvents',
        '| take 1',
      ].join('\n');
      expect(detectTableFromQuery(q)).toBe('DeviceLogonEvents');
    });

    it('does not badge a let-bound variable as a custom table', () => {
      const q = 'let Threshold = 5;\nlet Interesting = 10;\nInteresting | take 1';
      expect(detectTableFromQuery(q)).not.toBe('Custom:Interesting');
      expect(detectTableFromQuery(q)).toBe('Custom');
    });

    it('resolves to the real table when the query proper is a let-bound variable', () => {
      const q = 'let SuspiciousSignins = SigninLogs\n| where ResultType == 50126;\nSuspiciousSignins\n| take 10';
      expect(detectTableFromQuery(q)).toBe('SigninLogs');
    });

    it('prefers the statement that actually runs over a table named in a let body', () => {
      const q = 'let ips = ThreatIntelligenceIndicator | project NetworkIP;\nCommonSecurityLog\n| where SourceIP in (ips)';
      expect(detectTableFromQuery(q)).toBe('CommonSecurityLog');
    });

    it('tolerates a semicolon inside a user-defined function body', () => {
      const q = 'let f = (n:int) { let m = n + 1; m };\nDeviceNetworkEvents\n| take 1';
      expect(detectTableFromQuery(q)).toBe('DeviceNetworkEvents');
    });
  });

  describe('union', () => {
    it.each([
      ['union SigninLogs, AuditLogs\n| take 1', 'SigninLogs'],
      ['union withsource=SourceTable Staging_CL, SecurityEvent\n| take 1', 'SecurityEvent'],
      ['union kind=outer isfuzzy=true (SigninLogs | where X == 1), AuditLogs', 'SigninLogs'],
      ['union Alpha_CL, Beta_CL\n| take 1', 'Custom:Alpha_CL'],
      ['union imDns, Staging_CL', 'imDns'],
    ])('resolves %s', (input, expected) => {
      expect(detectTableFromQuery(input)).toBe(expected);
    });

    it('does not treat a union option value as a table', () => {
      expect(detectTableFromQuery('union withsource=SourceTable SecurityEvent, Syslog'))
        .not.toBe('Custom:SourceTable');
    });

    it('does not guess at a wildcard union', () => {
      expect(detectTableFromQuery('union Device*\n| take 1')).toBe('Custom');
    });
  });

  describe('find', () => {
    it.each([
      ['find in (SigninLogs, AuditLogs) where ResultType == "0"', 'SigninLogs'],
      ['find in (Staging_CL) where X == "y"', 'Custom:Staging_CL'],
      ['find in (Staging_CL, SecurityEvent) where X == "y"', 'SecurityEvent'],
    ])('resolves %s', (input, expected) => {
      expect(detectTableFromQuery(input)).toBe(expected);
    });

    it('claims no table for an unscoped find', () => {
      expect(detectTableFromQuery('find where Computer == "DC01"')).toBe('Custom');
    });

    it('reads the table list, not the first in-operator in a predicate', () => {
      expect(detectTableFromQuery('find in (SecurityEvent) where Account in ("a", "b")'))
        .toBe('SecurityEvent');
    });
  });

  describe('ASIM parsers', () => {
    it.each([
      ['imFileEvent | take 1', 'imFileEvent'],
      ['imProcessCreate(starttime=ago(1d))\n| take 5', 'imProcessCreate'],
      ['imNetworkSession\n| where DstPortNumber == 445', 'imNetworkSession'],
      ['imWebSession | take 1', 'imWebSession'],
      ['imAuthentication | take 1', 'imAuthentication'],
      ['imDns | take 1', 'imDns'],
      ['imRegistry | take 1', 'imRegistry'],
      ['_Im_FileEvent | take 1', '_Im_FileEvent'],
      ['_ASim_Dns | take 1', '_ASim_Dns'],
      ['ASimNetworkSessionLogs | take 1', 'ASimNetworkSessionLogs'],
      ['vimDnsInfobloxNIOS | take 1', 'vimDnsInfobloxNIOS'],
    ])('detects %s', (input, expected) => {
      expect(detectTableFromQuery(input)).toBe(expected);
    });

    it('exports the unifying parsers', () => {
      expect(ASIM_PARSERS).toContain('imFileEvent');
      expect(ASIM_PARSERS.every(isAsimTable)).toBe(true);
    });

    // The prefix alone is far too weak to match on: plenty of custom tables begin with Im.
    it.each(['ImportantThing', 'ImageInventory_CL', 'Impact', 'vimeoLogs', 'Simulation'])(
      'does not mistake %s for an ASIM parser', (name) => {
        expect(isAsimTable(name)).toBe(false);
      });
  });
});

describe('getTableGroup', () => {
  it('groups known tables by product', () => {
    expect(getTableGroup('SigninLogs')).toBe('sentinel');
    expect(getTableGroup('DeviceProcessEvents')).toBe('defender');
    expect(getTableGroup('Custom:Sysmon_CL')).toBe('custom');
    expect(getTableGroup(null)).toBe('custom');
  });

  it.each(['imFileEvent', 'imDns', '_Im_WebSession', '_ASim_Authentication', 'vimRegistryMicrosoftSysmon'])(
    'groups %s as asim', (name) => {
      expect(getTableGroup(name)).toBe('asim');
    });

  it('treats an explicit Custom: prefix as the user asserting the group', () => {
    expect(getTableGroup('Custom:imDns')).toBe('custom');
  });

  it('leaves a custom table that merely looks similar in the custom group', () => {
    expect(getTableGroup('ImportantEvents')).toBe('custom');
  });
});

describe('getTableDisplayName', () => {
  it('strips the Custom: prefix for display', () => {
    expect(getTableDisplayName('Custom:Sysmon_CL')).toBe('Sysmon_CL');
    expect(getTableDisplayName('SigninLogs')).toBe('SigninLogs');
    expect(getTableDisplayName('imFileEvent')).toBe('imFileEvent');
    expect(getTableDisplayName(null)).toBe('Unknown');
  });
});
