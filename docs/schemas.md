# The table schema store

A second store, next to the query library, for the shape of the tables your queries read from:
column names, their types, and free-text notes about the things `getschema` cannot tell you. It is
reference data, not detection logic — nothing in the app treats a stored schema as authoritative
about anything.

## What it is for

Two audiences, in order of how the feature actually gets used:

- **A model, or a human, reading the library.** When you are writing or reviewing a query against
  `SigninLogs` and cannot remember whether the risk fields are `RiskLevelDuringSignIn` or
  `RiskLevelAggregated`, or whether `ConditionalAccessStatus` is even the right table for it, a
  pasted `getschema` is faster and more trustworthy than a half-remembered portal screenshot.
- **A record of the things a schema alone does not say.** A column list tells you a field exists
  and its type. It does not tell you it is null for 90% of rows, that it only started being
  populated after a DCR version bump, or that the workspace only retains 90 days of it. That is
  what `notes` is for — see [Why notes matters](#why-notes-matters-the-things-getschema-cannot-tell-you) below.

## What it is not: additive, not authoritative

**The schema store does not drive the application.** [`src/constants.js`](../src/constants.js)'s
`SENTINEL_TABLES` and `DEFENDER_TABLES` are unchanged by this feature and remain the single source
of truth for:

- the table badges on a query card,
- the sidebar's table filter and its counts,
- [`TableSelector`](../src/components/TableSelector.jsx)'s autocomplete when you set a query's
  `table` field,
- [`src/domain/lint.js`](../src/domain/lint.js)'s table-name recognition, and
- [`src/domain/tables.js`](../src/domain/tables.js)'s table detection and grouping, used in the
  v2 → v3 migration and elsewhere.

Saving a schema for `MyCustomTable_CL` does not add it to those lists, does not make the linter
recognise it, and does not change what the table picker offers. The two are deliberately not
joined — `table_schemas` lives in its own SQLite table (see
[docs/schema.md](schema.md#how-it-is-stored)) with no foreign key to `queries` and no lookup from
`constants.js` into it. **Converging them — teaching the linter and the table picker to read from
the schema store instead of a hardcoded list — is a real idea and a deliberately separate future
project**, not an oversight here. Until that happens, editing or deleting a schema changes only
what this tab shows; it changes nothing about how a query is linted, filtered, or badged.

## Getting the input: `TableName | getschema`

Run `TableName | getschema` in the Sentinel or Defender portal's query editor (or wherever the
table lives — Log Analytics, an ASIM parser's underlying table, anything KQL can query) and copy
the results grid. That copy is what you paste into the **Paste `| getschema` output** box on the
Schemas tab.

[`src/domain/getschema.js`](../src/domain/getschema.js) parses it and never throws — it returns
either `{ ok: true, columns }` or `{ ok: false, error }`, and the error text is written for the
person who just pasted something, not for a log file: *"That does not look like getschema
output — no column names found."* A bad paste is a hint to try again, not a crash.

### Three accepted paste formats

The parser tells them apart per **line**, not per document, because a paste that has been through
an editor or a chat client can end up mixing them:

| Format | Where it comes from | Separator |
| --- | --- | --- |
| Tab-separated | Copying rows straight out of the portal's results grid | `\t` |
| Comma-separated | The portal's own CSV export | `,` |
| Multi-space aligned | Copying out of a rendered table or a terminal | two or more consecutive spaces |

A header row (`ColumnName`, `ColumnType`, ...) is optional. Column names may contain a dot or a
hyphen — custom tables ingested from JSON or CSV genuinely have dotted or hyphenated columns, and
silently dropping those would hand back an incomplete schema with no signal anything was lost. A
missing type is not an error, in the paste or over the API: it defaults to `unknown`, because a
clipped copy that lost its type column still leaves a column list that is worth more than nothing.

The parser also strips a copied-in KQL prompt line, in both styles a practitioner actually writes
it: `TableName | getschema` on one line, and `TableName` followed by `| getschema` alone on the
next line (how KQL is commonly formatted when the pipe starts a new line). In the second form, the
table name on the line above the bare `| getschema` is discarded along with it — otherwise it would
be read as a phantom column named after the table.

## Why `notes` matters: the things `getschema` cannot tell you

A column list is a fact about the schema *right now*. It cannot capture the operational knowledge
that actually changes how you'd write a query against the table:

- **Retention.** `getschema` says a column exists; it does not say the workspace only keeps 30 days
  of it, or that this particular table has a shorter retention override than the workspace default.
- **Conditionally-populated columns.** Plenty of Sentinel and Defender columns are only non-null for
  certain event types, certain connectors, or certain licence tiers — `getschema` cannot tell you
  `RiskLevelDuringSignIn` is empty unless Identity Protection is actually enabled on the tenant.
- **DCR versions and schema drift.** A custom table ingested through a Data Collection Rule can gain
  or lose columns when the DCR is updated, and `getschema` only ever shows you the shape as of
  today. A note recording "this table's DCR was bumped to v3 on 2026-06-01, added `DeviceGroup`" is
  the only place that history survives.

None of that is inferable from a paste, however carefully it is parsed — which is why `notes` is a
free-text field with real room (5 000 characters) rather than an afterthought next to the columns.

## Using it

The Schemas tab (a second top-level tab next to Queries — no router, no separate URL) is a
searchable list of stored schemas beside a form: a name field, the paste box, and notes.

- **Saving is always an upsert, keyed on the name you typed or selected — there is no separate
  edit form.** Selecting an existing schema from the list loads its name and notes and disables the
  name field; saving with the paste box left empty keeps the columns already on file, so you can
  edit just the notes without re-pasting. Saving under a name that already exists and was *not*
  selected from the list (a fresh name field that happens to collide) asks for confirmation first,
  because that save silently replaces the stored columns — and clears the notes, if you left the
  notes field empty.
- **Deleting** asks for confirmation and cannot be undone. It removes only the reference row —
  no query is affected, because nothing joins to it.
- **Export** downloads every stored schema as one JSON file; **Import** reads that shape (or a bare
  array of `{name, columns, notes}`) back in, previewing each row as new or an overwrite before you
  confirm, the same review-before-commit shape the query importer uses.

## API

Endpoint reference, bounds and request/response shapes: [docs/api.md](api.md#table-schemas).

## Related

- [docs/schema.md](schema.md) — the query record's own schema, including fork lineage.
- [docs/api.md](api.md) — every endpoint, including `/api/schemas`.
- [docs/kql-linter.md](kql-linter.md) — the linter that still reads `src/constants.js`, not this
  store.
