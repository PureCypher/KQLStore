# Table schema scraper — design

**Date:** 2026-08-02
**Status:** Approved pending user review

## Problem

The Schemas tab is populated by hand-pasting `TableName | getschema` output, and the public
LADemo workspace does not contain most Sentinel or Defender tables, so the store cannot be
filled from it. The goal is the schemas themselves, not a lab: get column name/type lists for
every security-relevant table into KQLStore's schema store without standing up Azure
infrastructure.

## Decision summary

- **No lab.** Microsoft publishes the full column/type reference for every Log Analytics table
  and every Defender XDR Advanced Hunting table as generated markdown in public GitHub repos.
  A script parses those and emits KQLStore's existing import JSON.
- **Scope: the security-relevant set** (~100–150 tables), not all ~1,200 Log Analytics tables
  and not only the 40 tables in `src/constants.js`.
- **Delivery: a re-runnable script** committed to `scripts/`, whose output the user feeds to
  the existing Schemas-tab importer (keeping its new-vs-overwrite preview as the review gate).

## Sources (verified 2026-08-02)

| Source | Repo | Path | Format |
| --- | --- | --- | --- |
| Log Analytics tables | `MicrosoftDocs/azure-monitor-docs` | `articles/azure-monitor/reference/tables/*.md` | `## Table attributes` block with a `**Categories**` row; `## Columns` section with a `| Column | Type | Description |` table |
| Defender XDR tables | `MicrosoftDocs/defender-docs` | `defender-xdr/advanced-hunting-*-table.md` | Prose description paragraph, then a `| Column name | Data type | Description |` table with backticked values |

Both repos are the generated source behind learn.microsoft.com, so re-running the script picks
up Microsoft's schema changes.

**Acquisition method:** shallow sparse clone into a temp directory
(`git clone --depth 1 --filter=blob:none --sparse`, then `git sparse-checkout set <path>`),
not per-file HTTP fetches. The tables directory holds 1,200+ files and the category filter
requires reading each one; a sparse clone avoids rate limits and is two git commands.

## Table selection

- **Log Analytics:** every table whose `**Categories**` attribute includes `Security`, **union**
  every name in `SENTINEL_TABLES` from `src/constants.js` regardless of category (Heartbeat,
  Usage, W3CIISLog are not categorised Security but the app knows them).
- **Defender:** every `advanced-hunting-*-table.md`. Files ending `-function.md` are excluded —
  they are functions, not tables.
- **Collision rule:** ~25 Defender tables exist in both sources (the XDR original keyed on
  `Timestamp`, the Sentinel streamed copy carrying `TimeGenerated`). The store keys one row per
  name, so **the Defender XDR version wins**, and its notes get an extra line: *"Sentinel's
  streamed copy of this table also carries TimeGenerated."*

## Components

One new file, `scripts/fetch-schemas.js` (Node ≥ 18: global `fetch` not required since we
clone; no new npm dependencies). Structured as pure, exported parsing functions plus a thin
`main()`:

1. **`parseAzureMonitorTable(markdown)`** → `{ name, categories, columns }` or `null` if the
   file has no Columns table. Name from the `# H1` heading; categories split from the
   `|**Categories**|...|` row; columns from the `| Column | Type | Description |` rows.
2. **`parseDefenderTable(markdown)`** → `{ name, description, columns }` or `null`. Name from
   the H1; description is the first prose paragraph after the H1 (markdown links flattened to
   their text); backticks stripped from column names and types.
3. **`buildImportRows(azureTables, defenderTables, sentinelTableNames)`** → the final array,
   applying the selection filter, the collision rule, notes composition and bounds.
4. **`main()`** — sparse-clones both repos into the OS temp dir, reads the files, calls the
   above, writes the output file, prints a summary (`N tables written, M files skipped:
   <names>`), and cleans up the clones.

## Output

A bare JSON array of `{ name, columns, notes }` sorted by name — exactly the shape the
Schemas-tab importer already accepts — written to the path given as the first CLI argument,
defaulting to `./table-schemas.json` (added to `.gitignore`; the generated file is not
committed).

**Notes composition**, per table:

- Defender tables: the doc's description paragraph, the learn.microsoft.com URL for the table,
  `Scraped from Microsoft Learn on <date>`, and the collision line where applicable.
- Log Analytics tables: `Categories: <list>`, the learn.microsoft.com URL, and the scraped
  date. (These docs have no prose description — the frontmatter description is boilerplate.)

**Bounds** (from `LIMITS` in `api/validate.js`): notes truncated to 5,000 characters; a blank
or missing type becomes `unknown`; a table exceeding 500 columns is truncated at 500 with a
warning printed and a note line appended — none is expected to.

## Error handling

- A clone failure aborts the run with the git error — no partial output file is written.
- A file that fails to parse (no H1, no columns table) is skipped and named in the end-of-run
  summary; it never aborts the run.
- Writing the output file happens once, at the end, after all parsing succeeds.

## Testing

`scripts/__tests__/fetch-schemas.test.js` (vitest), using fixture markdown strings modelled on
the verified real formats. `vitest.config.js`'s `include` gains
`scripts/__tests__/**/*.test.js`. Covered:

- Azure Monitor parser: happy path, categories extraction, missing Columns section → `null`,
  blank type → `unknown`.
- Defender parser: happy path, backtick stripping, description extraction with links
  flattened, `-function.md`-style files (no columns table) → `null`.
- `buildImportRows`: Security-category filter, `SENTINEL_TABLES` union, Defender-wins
  collision with the extra note line, notes truncation at 5,000, 500-column truncation,
  output sorted by name.

`main()` (clone + filesystem) is not unit-tested; it is thin orchestration exercised by
running the script.

## Out of scope (deliberate)

- No direct `PUT /api/schemas/:name` pushes — the UI importer's preview is the review gate.
- No wiring into the linter, table picker or badges (`docs/schemas.md` already marks that
  convergence as a separate future project).
- No scheduled re-runs, no CI job.
- No ASIM parser schemas — parsers are functions, not tables; a future run could add them.
