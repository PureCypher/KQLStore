import { describe, it, expect } from 'vitest';
import { lint } from '../lint.js';

/**
 * Every rule gets a pair: a query that MUST fire it, and a near-identical query that must
 * NOT. The negative half is the important half — a linter a practitioner sees on every
 * query is only useful for as long as it is right, and the fastest way to make one useless
 * is to let it cry wolf on correct KQL.
 */

const rules = (query) => lint(query).map((f) => f.rule);
const firstOf = (query, rule) => lint(query).find((f) => f.rule === rule);

// A time bound and a project, so that unbounded-timerange and select-star-project stay
// quiet and each test below is isolated to the rule it names.
const bounded = (...lines) => ['SigninLogs', '| where TimeGenerated > ago(1d)', ...lines,
  '| project TimeGenerated, UserPrincipalName'].join('\n');

describe('lint', () => {
  describe('contract', () => {
    it('returns an empty array for empty or non-string input', () => {
      expect(lint('')).toEqual([]);
      expect(lint('   \n  ')).toEqual([]);
      expect(lint(null)).toEqual([]);
      expect(lint(undefined)).toEqual([]);
      expect(lint(42)).toEqual([]);
    });

    it('returns well-formed findings', () => {
      const findings = lint('DeviceProcessEvents\n| where ProcessCommandLine contains "mimikatz"');
      expect(findings.length).toBeGreaterThan(0);
      for (const f of findings) {
        expect(typeof f.rule).toBe('string');
        expect(['error', 'warning', 'info']).toContain(f.severity);
        expect(f.line).toBeGreaterThanOrEqual(1);
        expect(f.column).toBeGreaterThanOrEqual(1);
        expect(f.message.length).toBeGreaterThan(0);
        expect(f.hint.length).toBeGreaterThan(0);
      }
    });

    it('orders findings by position', () => {
      const findings = lint([
        'DeviceProcessEvents',
        '| where AccountName contains "admin"',
        '| mvexpand Files',
        '| take 10',
      ].join('\n'));
      const positions = findings.map((f) => f.line * 1000 + f.column);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });

    it('reports the position of the offending token, not of the line', () => {
      const query = 'SigninLogs\n| where TimeGenerated > ago(1d)\n| where Account contains "admin"';
      const finding = firstOf(query, 'prefer-has');
      expect(finding.line).toBe(3);
      expect(query.split('\n')[2].slice(finding.column - 1)).toMatch(/^contains/);
    });
  });

  // The lexer is the foundation every rule stands on: if it mis-scans, rules fire on text
  // the engine will never execute, or go silent on text it will.
  describe('comments and strings are never linted', () => {
    it('ignores a commented-out predicate', () => {
      const query = bounded('// | where Account contains "admin" and take 5');
      expect(rules(query)).not.toContain('prefer-has');
      expect(rules(query)).not.toContain('take-without-order');
    });

    it('ignores operator names inside a string literal', () => {
      const query = bounded('| where Message == "please take 5 and mvexpand the join"');
      expect(rules(query)).not.toContain('take-without-order');
      expect(rules(query)).not.toContain('deprecated-operator');
      expect(rules(query)).not.toContain('join-without-kind');
    });

    it('ignores a block comment', () => {
      const query = bounded('/* legacy version:\n   | mvexpand Files\n*/');
      expect(rules(query)).not.toContain('deprecated-operator');
    });

    // KQS-039 in the highlighter: the // in a URL opened a comment that swallowed the rest
    // of the line. Here that would silently disable every rule after a URL literal.
    it('does not let a // inside a URL literal blind the rest of the line', () => {
      const query = bounded('| where Url has "https://portal.azure.com" and Account contains "admin"');
      expect(rules(query)).toContain('prefer-has');
    });

    it("does not let an apostrophe in a comment open a string", () => {
      const query = bounded("// don't bother with the index", '| where Account contains "admin"');
      expect(rules(query)).toContain('prefer-has');
    });
  });

  describe('prefer-has', () => {
    it('fires on contains with a single-term literal', () => {
      expect(rules(bounded('| where AccountName contains "admin"'))).toContain('prefer-has');
    });

    it('does not fire when the literal is not a single term', () => {
      // has matches whole terms, so "powershell.exe" and a path are not safe rewrites.
      expect(rules(bounded('| where FileName contains "powershell.exe"'))).not.toContain('prefer-has');
      expect(rules(bounded('| where Path contains "C:\\\\Users\\\\Public"'))).not.toContain('prefer-has');
      expect(rules(bounded('| where Cmd contains "rm -rf"'))).not.toContain('prefer-has');
    });

    it('advises the negated operator when the predicate is negated', () => {
      const finding = firstOf(bounded('| where AccountName !contains "admin"'), 'prefer-has');
      expect(finding.hint).toContain("'!has'");
      expect(finding.hint).not.toContain("''has'");
    });

    it('does not fire on contains_cs, on has, or on a non-literal operand', () => {
      expect(rules(bounded('| where AccountName contains_cs "admin"'))).not.toContain('prefer-has');
      expect(rules(bounded('| where AccountName has "admin"'))).not.toContain('prefer-has');
      expect(rules(bounded('| where AccountName contains TargetAccount'))).not.toContain('prefer-has');
    });
  });

  describe('unbounded-timerange', () => {
    it('fires when nothing bounds the time range', () => {
      expect(rules('SigninLogs\n| where ResultType == 0\n| project UserPrincipalName'))
        .toContain('unbounded-timerange');
    });

    it('does not fire for ago(), between() or an absolute datetime bound', () => {
      expect(rules('SigninLogs\n| where TimeGenerated > ago(1d)')).not.toContain('unbounded-timerange');
      expect(rules('SigninLogs\n| where TimeGenerated between (datetime(2024-01-01) .. datetime(2024-02-01))'))
        .not.toContain('unbounded-timerange');
      expect(rules('DeviceProcessEvents\n| where Timestamp >= datetime(2024-01-01)'))
        .not.toContain('unbounded-timerange');
    });

    it('treats a mention of TimeGenerated as a bound only when it is compared', () => {
      expect(rules('SigninLogs\n| project TimeGenerated, UserPrincipalName'))
        .toContain('unbounded-timerange');
    });

    it('does not fire when there is no table to bound', () => {
      expect(rules('print Answer = 40 + 2')).not.toContain('unbounded-timerange');
      expect(rules('let t = datatable(a:int)[1, 2];\nt\n| where a == 1'))
        .not.toContain('unbounded-timerange');
    });
  });

  describe('leading-wildcard', () => {
    it('fires on a leading * in a string predicate', () => {
      expect(rules(bounded('| where UserPrincipalName contains "*admin*"'))).toContain('leading-wildcard');
      expect(rules(bounded('| where Url startswith "*evil"'))).toContain('leading-wildcard');
    });

    it('fires on a regex that starts with .*', () => {
      expect(rules(bounded('| where FileName matches regex ".*evil"'))).toContain('leading-wildcard');
      expect(rules(bounded('| where FileName matches regex "^.*evil"'))).toContain('leading-wildcard');
    });

    it('does not fire on a star elsewhere in the value or an anchored regex', () => {
      expect(rules(bounded('| where Path contains "logs*archive"'))).not.toContain('leading-wildcard');
      expect(rules(bounded('| where FileName matches regex "^cmd.*"'))).not.toContain('leading-wildcard');
    });
  });

  describe('search-all-tables', () => {
    it('fires on a bare search', () => {
      expect(rules('search "invoke-mimikatz"')).toContain('search-all-tables');
    });

    it('does not fire when the search is scoped', () => {
      expect(rules('search in (SigninLogs, AuditLogs) "invoke-mimikatz"'))
        .not.toContain('search-all-tables');
      expect(rules('SigninLogs\n| where TimeGenerated > ago(1d)\n| search "mimikatz"'))
        .not.toContain('search-all-tables');
    });
  });

  describe('join-without-kind', () => {
    it('fires on a join with no kind', () => {
      expect(rules(bounded('| join (AuditLogs) on $left.Id == $right.Id')))
        .toContain('join-without-kind');
      expect(rules(bounded('| join AuditLogs on CorrelationId'))).toContain('join-without-kind');
    });

    it('does not fire when the kind is stated, or on lookup', () => {
      expect(rules(bounded('| join kind=leftouter (AuditLogs) on CorrelationId')))
        .not.toContain('join-without-kind');
      expect(rules(bounded('| join hint.strategy=broadcast kind=inner (AuditLogs) on CorrelationId')))
        .not.toContain('join-without-kind');
      expect(rules(bounded('| lookup (AuditLogs) on CorrelationId'))).not.toContain('join-without-kind');
    });
  });

  describe('join-order', () => {
    it('fires when the larger table is on the left', () => {
      expect(rules([
        'DeviceProcessEvents',
        '| where TimeGenerated > ago(1d)',
        '| join kind=inner (SecurityAlert) on $left.DeviceId == $right.SystemAlertId',
        '| project TimeGenerated',
      ].join('\n'))).toContain('join-order');
    });

    it('does not fire when the smaller table is on the left', () => {
      expect(rules([
        'SecurityAlert',
        '| where TimeGenerated > ago(1d)',
        '| join kind=inner (DeviceProcessEvents) on $left.SystemAlertId == $right.DeviceId',
        '| project TimeGenerated',
      ].join('\n'))).not.toContain('join-order');
    });

    it('stays silent when either side has no known volume', () => {
      expect(rules([
        'MyStaging_CL',
        '| where TimeGenerated > ago(1d)',
        '| join kind=inner (SecurityAlert) on Id',
        '| project TimeGenerated',
      ].join('\n'))).not.toContain('join-order');
      expect(rules([
        'DeviceProcessEvents',
        '| where TimeGenerated > ago(1d)',
        '| join kind=inner (MyStaging_CL) on Id',
        '| project TimeGenerated',
      ].join('\n'))).not.toContain('join-order');
    });
  });

  describe('select-star-project', () => {
    it('fires on a wide table with no column selection', () => {
      expect(rules('DeviceProcessEvents\n| where TimeGenerated > ago(1d)\n| take 10'))
        .toContain('select-star-project');
    });

    it('does not fire when the columns are narrowed, or on a narrow table', () => {
      expect(rules('DeviceProcessEvents\n| where TimeGenerated > ago(1d)\n| project DeviceName'))
        .not.toContain('select-star-project');
      expect(rules('DeviceProcessEvents\n| where TimeGenerated > ago(1d)\n| project-away ReportId'))
        .not.toContain('select-star-project');
      expect(rules('DeviceProcessEvents\n| where TimeGenerated > ago(1d)\n| summarize count() by DeviceName'))
        .not.toContain('select-star-project');
      expect(rules('Heartbeat\n| where TimeGenerated > ago(1d)\n| take 10'))
        .not.toContain('select-star-project');
    });
  });

  describe('regex-over-has-any', () => {
    it('fires on a regex that is a plain alternation of literals', () => {
      expect(rules(bounded('| where Process matches regex "winword.exe|excel.exe"')))
        .toContain('regex-over-has-any');
      expect(rules(bounded('| where Process matches regex "^(cmd|powershell|wscript)$"')))
        .toContain('regex-over-has-any');
    });

    // has_any is a term match; a regex anchored at both ends asked for the whole value.
    it('suggests in~ for a fully anchored alternation and has_any otherwise', () => {
      expect(firstOf(bounded('| where Process matches regex "^(cmd|powershell)$"'), 'regex-over-has-any').hint)
        .toContain('in~ ("cmd", "powershell")');
      expect(firstOf(bounded('| where Process matches regex "cmd.exe|powershell.exe"'), 'regex-over-has-any').hint)
        .toContain('has_any ("cmd.exe", "powershell.exe")');
    });

    it('does not fire on a real regex or on a single literal', () => {
      expect(rules(bounded('| where Process matches regex "^[a-z]{3}[0-9]+$"')))
        .not.toContain('regex-over-has-any');
      expect(rules(bounded('| where Process matches regex "svc.*host"')))
        .not.toContain('regex-over-has-any');
      expect(rules(bounded('| where Process matches regex "^powershell$"')))
        .not.toContain('regex-over-has-any');
    });
  });

  describe('datetime-string-compare', () => {
    it('fires on a datetime column compared to a string literal', () => {
      const findings = lint('SigninLogs\n| where TimeGenerated > "2024-01-01"');
      const finding = findings.find((f) => f.rule === 'datetime-string-compare');
      expect(finding).toBeDefined();
      expect(finding.severity).toBe('error');
      expect(rules('DeviceProcessEvents\n| where Timestamp >= "2024-01-01T00:00:00Z"\n| project Timestamp'))
        .toContain('datetime-string-compare');
    });

    it('does not fire when the string is converted, or on a non-datetime column', () => {
      expect(rules('SigninLogs\n| where TimeGenerated >= todatetime("2024-01-01")'))
        .not.toContain('datetime-string-compare');
      expect(rules('SigninLogs\n| where TimeGenerated > ago(1d)\n| where IPAddress == "10.0.0.1"'))
        .not.toContain('datetime-string-compare');
      // Ends in a lowercase "time", so it is a duration or a name, not a datetime column.
      expect(rules('SigninLogs\n| where TimeGenerated > ago(1d)\n| where Runtime == "fast"'))
        .not.toContain('datetime-string-compare');
    });
  });

  describe('deprecated-operator', () => {
    it.each(['| mvexpand Files', '| summarize makeset(Account) by Computer',
      '| summarize makelist(Account) by Computer'])('fires on %s', (line) => {
      expect(rules(bounded(line))).toContain('deprecated-operator');
    });

    it.each(['| mv-expand Files', '| summarize make_set(Account) by Computer',
      '| summarize make_list(Account) by Computer'])('does not fire on %s', (line) => {
      expect(rules(bounded(line))).not.toContain('deprecated-operator');
    });

    it('fires on a summarize with no aggregate', () => {
      expect(rules(bounded('| summarize by UserPrincipalName'))).toContain('deprecated-operator');
    });

    it('does not fire on a summarize that aggregates', () => {
      expect(rules(bounded('| summarize Attempts = count() by UserPrincipalName')))
        .not.toContain('deprecated-operator');
    });

    it('still fires on a multi-column by-list of bare identifiers', () => {
      expect(rules(bounded('| summarize by UserPrincipalName, IPAddress')))
        .toContain('deprecated-operator');
    });

    // `distinct` accepts column names only, so for a computed or bucketed key the suggested
    // rewrite does not exist and the finding is pure noise on a correct, idiomatic query.
    it.each([
      '| summarize by Country = tostring(LocationDetails.countryOrRegion)',
      '| summarize by bin(TimeGenerated, 1h), UserPrincipalName',
      '| summarize by UserPrincipalName, bin(TimeGenerated, 1h)',
      '| summarize by tolower(UserPrincipalName)',
    ])('does not fire on a computed by-list: %s', (line) => {
      expect(rules(bounded(line))).not.toContain('deprecated-operator');
    });

    it('fires when sort by and order by are mixed in one query', () => {
      expect(rules(bounded('| sort by TimeGenerated desc', '| order by UserPrincipalName asc')))
        .toContain('deprecated-operator');
    });

    it('does not fire when only one of the two spellings is used', () => {
      expect(rules(bounded('| order by TimeGenerated desc'))).not.toContain('deprecated-operator');
      expect(rules(bounded('| sort by TimeGenerated desc'))).not.toContain('deprecated-operator');
    });
  });

  describe('distinct-over-summarize', () => {
    it('fires on distinct over an unbounded high-cardinality column', () => {
      expect(rules('CommonSecurityLog\n| where TimeGenerated > ago(1d)\n| distinct RequestUrl'))
        .toContain('distinct-over-summarize');
      expect(rules('DeviceProcessEvents\n| where TimeGenerated > ago(1d)\n| distinct ProcessCommandLine'))
        .toContain('distinct-over-summarize');
    });

    it('does not fire on a low-cardinality column or when the result is bounded', () => {
      expect(rules('DeviceProcessEvents\n| where TimeGenerated > ago(1d)\n| distinct DeviceName'))
        .not.toContain('distinct-over-summarize');
      expect(rules('DeviceProcessEvents\n| where TimeGenerated > ago(1d)\n| distinct ProcessCommandLine\n| take 100'))
        .not.toContain('distinct-over-summarize');
    });
  });

  describe('take-without-order', () => {
    it('fires on take or limit with nothing ordering the rows first', () => {
      expect(rules(bounded('| take 10'))).toContain('take-without-order');
      expect(rules(bounded('| limit 10'))).toContain('take-without-order');
    });

    it('does not fire when the rows are ordered first', () => {
      expect(rules(bounded('| sort by TimeGenerated desc', '| take 10')))
        .not.toContain('take-without-order');
      expect(rules(bounded('| order by TimeGenerated desc', '| take 10')))
        .not.toContain('take-without-order');
      expect(rules(bounded('| top 10 by TimeGenerated desc'))).not.toContain('take-without-order');
    });
  });

  describe('a query written properly is clean', () => {
    it.each([
      [
        'a bounded, projected, ordered Defender hunt',
        [
          '// Office application spawning a script interpreter',
          'DeviceProcessEvents',
          '| where TimeGenerated > ago(7d)',
          '| where InitiatingProcessFileName has_any ("winword.exe", "excel.exe")',
          '| where FileName has_any ("powershell.exe", "wscript.exe")',
          '| project TimeGenerated, DeviceName, AccountName, ProcessCommandLine',
          '| top 100 by TimeGenerated desc',
        ].join('\n'),
      ],
      [
        'an ASIM network session summary',
        [
          'let lookback = 24h;',
          'imNetworkSession',
          '| where TimeGenerated > ago(lookback)',
          '| where DstPortNumber in (445, 3389)',
          '| summarize Attempts = count() by SrcIpAddr, DstIpAddr',
          '| order by Attempts desc',
        ].join('\n'),
      ],
      [
        'a joined alert enrichment with the small table on the left',
        [
          'SecurityAlert',
          '| where TimeGenerated > ago(1d)',
          '| join kind=inner (',
          '    DeviceProcessEvents',
          '    | where TimeGenerated > ago(1d)',
          '    | project DeviceId, ProcessCommandLine',
          ') on $left.SystemAlertId == $right.DeviceId',
          '| project TimeGenerated, AlertName, ProcessCommandLine',
        ].join('\n'),
      ],
    ])('reports nothing for %s', (_name, query) => {
      expect(lint(query)).toEqual([]);
    });
  });
});
