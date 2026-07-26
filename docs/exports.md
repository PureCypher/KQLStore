# Exports

Three formats, reached from the **Export** button in the header
([`src/components/ExportMenu.jsx`](../src/components/ExportMenu.jsx)). Each emits a file straight
from the browser; nothing is sent anywhere. The generators are pure functions in
[`src/export/`](../src/export/) and are unit-tested independently of the UI.

Export is where a detection library earns its keep. Before these existed the only output was a bare
array of the application's own records, so queries went into the tool and came back out into the
same tool and nowhere else.

| Menu entry | File | Module |
| --- | --- | --- |
| JSON (native) | `kqlstore-YYYY-MM-DD.json` | [`src/export/json.js`](../src/export/json.js) |
| Sentinel analytics rules (YAML) | `kqlstore-sentinel-rules-YYYY-MM-DD.yaml` | [`src/export/sentinelYaml.js`](../src/export/sentinelYaml.js) |
| ATT&CK Navigator layer | `kqlstore-attack-layer-YYYY-MM-DD.json` | [`src/export/navigator.js`](../src/export/navigator.js) |

All three export **every query in the store**, not the current filter or selection.

## JSON (native)

The round-trip format: this is what the app's own Import accepts, and the one to keep in version
control.

```json
{
  "schemaVersion": 4,
  "queries": [ … ],
  "meta": { "exportedAt": "2026-07-26T13:03:32.333Z", "totalQueries": 15, "generator": "KQL Store" }
}
```

The envelope is the point. The old export emitted a bare array, and since import only runs the
migration chain when it sees a versioned blob, an exported file could never be migrated on
re-import — a v3 file loaded into a later build would be assumed current and silently mis-read.

Two things still emit the older bare-array shape, and both are worth knowing about:

- **Export selected**, on the bulk action bar, writes `kql-store-backup-YYYY-MM-DD.json` as a plain
  array. It re-imports fine today, because import accepts an array as well as an envelope, but it
  carries no version marker.
- **`GET /api/queries/export`** wraps its rows in an envelope that still declares `schemaVersion: 3`
  while the records inside it carry v4 metadata. Re-importing it is safe — the v3 → v4 step only
  promotes technique IDs out of tags and leaves an existing `attack` block alone — but the number is
  wrong and should not be relied on.

## Sentinel scheduled analytics rules (YAML)

One `kind: Scheduled` rule per query, in the shape Sentinel's own content repository uses, joined
into a single multi-document file with `---` separators. Commit it to a content repo, or hand it to
whatever pipeline deploys your rules.

```yaml
id: 71fa50fd-e082-4d4c-b712-b575e2f16ddf
name: LOLBin spawned by an Office application
kind: Scheduled
description: |-
  An Office application spawning a living-off-the-land binary. A classic macro or exploit execution chain, and rare enough in most estates to alert on directly.
severity: High
requiredDataConnectors:
  - connectorId: MicrosoftThreatProtection
    dataTypes:
      - DeviceProcessEvents
queryFrequency: 1d
queryPeriod: 1d
triggerOperator: gt
triggerThreshold: 0
tactics:
  - Execution
  - DefenseEvasion
relevantTechniques:
  - T1218
  - T1566.001
query: |-
  let lookback = 1d;
  let OfficeApps = dynamic(["winword.exe", "excel.exe", "powerpnt.exe", "outlook.exe", "msaccess.exe"]);
  DeviceProcessEvents
  | where Timestamp > ago(lookback)
  …
entityMappings:
  - entityType: Host
    fieldMappings:
      - identifier: HostName
        columnName: DeviceName
  - entityType: Process
    fieldMappings:
      - identifier: CommandLine
        columnName: ProcessCommandLine
customDetails:
  TuningNotes: 'False positive: Some line-of-business Excel add-ins legitimately shell out to rundll32. | …'
version: 1.0.0
```

Mappings worth knowing:

- ATT&CK tactic **slugs become Sentinel's PascalCase** (`defense-evasion` → `DefenseEvasion`),
  derived from the canonical tactic list so the two cannot drift.
- The KQL body goes into a literal block scalar (`|-`), so multi-line queries round-trip
  byte-for-byte. Blank lines inside the query are emitted empty rather than as indentation, which is
  what keeps the block valid.
- `falsePositives` and `tuningNotes` are joined into `customDetails.TuningNotes`, truncated at 500
  characters. Sentinel has no first-class field for either.
- Sub-technique IDs are passed through whole rather than truncated to the parent.

### What it defaults, and why it tells you

Sentinel requires fields the store does not carry. Rather than guess quietly, the exporter
substitutes a conservative value and **reports every substitution as a warning**; the menu then
shows how many rules were exported with defaulted fields, listed by name. Nobody should ship an
unmapped rule believing it was mapped.

| Missing | Default | Warning |
| --- | --- | --- |
| `severity` | `Medium` | `severity not set — defaulted to Medium` |
| `lookback` | `1d` for both `queryFrequency` and `queryPeriod` | `lookback not set — queryPeriod defaulted to 1d` |
| `attack.tactics` | omitted | `no ATT&CK tactics — Sentinel will show the rule as unmapped` |
| `attack.techniques` | omitted | `no ATT&CK techniques` |
| `entityMappings` | omitted | `no entity mappings — incidents will not correlate entities` |
| `version` | `1.0.0` | *(none — a version is not a detection decision)* |

A `queryType` that is neither `AnalyticsRule` nor `NRT` also warns: exporting a hunting query as a
scheduled rule is legitimate, but it is a decision, not a default.

Exporting the starter pack produces 15 documents and warns on 5 of them: the four hunts and the one
investigation pivot, each for being what it says it is rather than an `AnalyticsRule`. Two of those
hunts warn twice, because they aggregate and so have no per-row entity to map.

### Limitations

- **`queryFrequency` equals `queryPeriod`.** Both come from `lookback`, because the store has one
  time field and Sentinel has two. A rule that looks back 7 days does not want to run every 7 days;
  set the frequency yourself before deploying.
- **`triggerOperator: gt` and `triggerThreshold: 0`** — alert on any result. That is the right
  conservative default and almost never the right production setting.
- **No incident configuration, no grouping, no alert details, no suppression.** Those have no
  representation in the schema, so they are not emitted.
- **The YAML is emitted, not parsed.** There is no schema validation against Sentinel's own rule
  schema; a rule that Sentinel later rejects will still export cleanly. The test suite verifies the
  output is *valid YAML* by round-tripping it, and the shipped file parses with PyYAML.
- **It is one-way.** Nothing imports Sentinel YAML back into the store.

## ATT&CK Navigator layer

A layer file for the [ATT&CK Navigator](https://mitre-attack.github.io/attack-navigator/): open the
Navigator, choose *Open Existing Layer → Upload from local*, and the store is projected onto the
Enterprise matrix.

```json
{
  "name": "KQL Store coverage",
  "domain": "enterprise-attack",
  "versions": { "attack": "14", "navigator": "4.9.0", "layer": "4.5" },
  "description": "Generated from KQL Store: 16 technique(s) across 15 queries.",
  "techniques": [
    {
      "techniqueID": "T1110.003",
      "score": 2,
      "comment": "Password spray against Entra ID\nSuccessful sign-in from an IP that just sprayed",
      "enabled": true
    }
  ],
  "gradient": { "colors": ["#a1d99b", "#31a354"], "minValue": 1, "maxValue": 2 }
}
```

- **Score is the number of queries mapped to that technique**, so the heat map reads as depth of
  coverage rather than a flat yes/no, and the gradient's `maxValue` follows the busiest technique.
- **The comment on each cell lists the contributing query names**, which is what makes a hot cell
  actionable when you click it.
- The `platforms` filter is built from the `platform` values in the store, mapped to the Navigator's
  own vocabulary (`Azure` and `Identity` → `Azure AD`, `AWS` and `GCP` → `IaaS`). When the store
  says nothing, the full default set is emitted — an empty filter list means "no platforms" in the
  Navigator, not "all".

Limitations: the layer pins ATT&CK v14 and layer format 4.5, so a much newer Navigator may want a
conversion on load. Coverage here means *a query claims this technique*, nothing more — it is not
evidence that the query fires, that the data source is onboarded, or that the rule is enabled. A
query with no `attack.techniques` contributes nothing and is counted as unmapped in the toast the
menu shows after the download.

## Related

- [docs/schema.md](schema.md) — where the metadata these exports read comes from.
- [docs/starter-pack.md](starter-pack.md) — a store that exercises all three formats.
