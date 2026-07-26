# The KQL linter

[`src/domain/lint.js`](../src/domain/lint.js) is a dependency-free check for the mistakes that cost
a Sentinel or Defender analyst real money and real detections: full-table substring scans, queries
with no time bound, joins whose default kind silently drops rows, and predicates that cannot be
answered from an index.

```js
import { lint } from './src/domain/lint.js';

lint('DeviceProcessEvents | where TimeGenerated > ago(1d) | where FileName contains "powershell"');
// [
//   { rule: 'select-star-project', severity: 'info', line: 1, column: 1, message: …, hint: … },
//   { rule: 'prefer-has',          severity: 'info', line: 1, column: 70, message: …, hint: … }
// ]
```

Findings are returned in source order — sorted by line, then column, then rule name — and
de-duplicated on `rule:line:column`, so a caller can render them straight down the side of the
editor. Empty input returns `[]`.

## What it is not

**It is not a parser.** It is a lexer plus a set of shape checks, because the alternative — a real
KQL grammar in the browser bundle — is an order of magnitude more code for findings nobody asked
for. It does not know whether your query runs, whether a column exists, or whether the logic is
right. Nothing here replaces running the query in the portal.

The constraint that shapes every rule is **false positives**. A linter that fires on correct queries
is switched off within a week and then never catches the real defect either, so every rule
under-reports: it fires only on the shape it can be confident about and stays silent when the intent
is ambiguous. Concretely:

- No rule ever fires on text inside a comment or a string literal. The query is lexed once into a
  mask the same length as the source, with comment and string *bodies* blanked but the delimiters
  kept, so any index found in the mask points at the same character of the original and needs no
  translation.
- Rules that need to know what a value *is*, rather than where it is, only fire on literals — never
  on an expression or a variable, where the linter would be guessing.

## Severity contract

| Severity | Meaning |
| --- | --- |
| `error` | The query is wrong: it will fail, or it will silently return the wrong rows. |
| `warning` | The query works, but it will scan far more data than it needs to, or its result depends on a default the author probably did not choose. |
| `info` | There is a clearer or cheaper way to express the same thing. |

## The rules

| `rule` | Severity | Fires when | Suggests |
| --- | --- | --- | --- |
| `datetime-string-compare` | error | A datetime column (`TimeGenerated`, `Timestamp`, `ingestion_time`, `FirstSeen`, `LastSeen`, or any name ending `Time`, `DateTime` or `Date`) is compared to a string literal. KQL has no overload for that. | `datetime(…)` or `todatetime(…)` |
| `unbounded-timerange` | warning | The query has no `ago()`, no `between()`, no comparison against `TimeGenerated`/`Timestamp`, and no absolute `datetime(YYYY-…)` literal. Reported at 1:1. | `\| where TimeGenerated > ago(7d)` as the first operator — in an analytics rule the bound must still be in the query; the rule period does not replace it |
| `leading-wildcard` | warning | A string comparison's right-hand literal starts with `*`, or a `matches regex` pattern starts with `.*`. | KQL is not Splunk: `*` is not a wildcard in a string comparison. Use `has`/`contains`, or an anchored regex |
| `search-all-tables` | warning | A statement-initial bare `search`, not scoped with `in (…)`. | Scope it, or start from the table and pipe into `search` |
| `join-without-kind` | warning | A `join` with no `kind=`. | The default is `innerunique`, which collapses duplicate keys on the **left** to one row before matching. State the kind you meant |
| `deprecated-operator` | warning | `mvexpand`, `mvapply`, `makeset(`, `makelist(`, `makeseries`. | `mv-expand`, `mv-apply`, `make_set()`, `make_list()`, `make-series` — identical behaviour, safe to apply blind |
| `prefer-has` | info | `contains` or `!contains` against a bare-term literal (letters, digits and underscore only, 3+ characters). | `has`/`!has` answers it from the term index. Anything with a separator in it — `powershell.exe`, `C:\Users` — is left alone, because it may well be a deliberate substring match |
| `join-order` | info | The **first** join has a higher-volume table on the left than on the right. | Kusto broadcasts the left side, so the smaller table belongs there — or add `hint.strategy=broadcast` |
| `select-star-project` | info | A wide table is queried with no `project`, `project-away`, `project-keep`, `project-rename`, `project-reorder`, `summarize`, `distinct`, `count`, `make-series`, `top-nested`, `getschema` or `evaluate` anywhere. Reported at 1:1. | Project the columns the analyst reads. The cheapest single change to a hunting query's cost |
| `regex-over-has-any` | info | A `matches regex` pattern is a plain alternation of two or more literals with no other metacharacters. | `has_any (…)`, or `in~ (…)` when the pattern was anchored at both ends and so meant the whole value |
| `deprecated-operator` | info | `summarize by` with no aggregate and a by-list of nothing but bare column names. | Say what you mean with `distinct`, or add the aggregate. A computed or binned key (`by bin(TimeGenerated, 1h)`) is left alone — `distinct` cannot express it |
| `deprecated-operator` | info | The query uses both `sort by` and `order by`. | They are the same operator; pick one |
| `distinct-over-summarize` | info | `distinct` over a high-cardinality column — one ending in `CommandLine`, `CorrelationId`, `SessionId`, `OperationId`, `RequestId`, `ReportId`, `ProcessId`, `DeviceId`, a hash name, `Url`, `Uri`, `UserAgent`, `Message` or `Token` — with no downstream `take`, `limit` or `top`. | `summarize dcount(…)` for "how many", `top N by` for "which" |
| `take-without-order` | info | `take` or `limit` with no preceding `sort`, `order` or `top`. | An arbitrary N rows, and a different N on every run. `top 100 by TimeGenerated desc` when you want the newest |

Three checks share the `deprecated-operator` id — the legacy spellings, the aggregate-free
`summarize by`, and mixing `sort by` with `order by`. They are grouped as "this is the old way of
writing it" rather than given ids of their own.

## Table knowledge

Two rules need to know something about the table, and both take their answer from a static list, so
a table the list has never heard of produces **silence rather than a guess**:

- `join-order` uses three coarse volume tiers — firehoses (`DeviceNetworkEvents`,
  `DeviceProcessEvents`, `CommonSecurityLog`, `Syslog`, `SecurityEvent`, `AzureDiagnostics` and
  friends), tables bounded by user or device count (`SigninLogs`, `AuditLogs`, `EmailEvents`,
  `DeviceLogonEvents` …), and reference-sized tables with one row per alert, incident or device
  (`SecurityAlert`, `SecurityIncident`, `AlertInfo`, `DeviceInfo` …). It fires only when the tiers
  differ. Three tiers is as much precision as a static list can honestly claim.
- `select-star-project` uses a list of tables wide enough that returning every column is never what
  the analyst wanted; `DeviceProcessEvents` alone is over forty columns, most of them empty for any
  given event.

The table itself comes from `detectTableFromQuery`
([`src/domain/tables.js`](../src/domain/tables.js)), which understands `union`, `find`, block
comments, multi-line `let` statements and ASIM parsers, and does not mistake a `let`-bound variable
for a table. When it cannot tell, the table is `Custom` and `unbounded-timerange` stays quiet — a
bare `print`, a `datatable` or a function definition has nothing to bound, so the rule would only
ever be noise there.

## Tests

56 cases in [`src/domain/__tests__/lint.test.js`](../src/domain/__tests__/lint.test.js). Every rule
has both a positive and a negative case: the negative is the one that matters, because a linter that
fires on correct KQL gets switched off.
