# The starter pack

[`content/starter-pack.json`](../content/starter-pack.json) is 15 queries in the native export
format, provided so a first run is not an empty box with nothing to search and no worked example of
the metadata model. It is not shipped inside the images and nothing loads it automatically — you
import it, or you do not.

## Read this before you enable anything

> Starting points, not finished detections. Every entry needs baselining against your own estate
> before it is enabled as an analytics rule — read the `falsePositives` and `tuningNotes` fields on
> each. These have not been validated against live data in your tenant.

That is `meta.notice` from the file itself, and it is the honest description. These queries were
written against the documented schemas of the tables they read; **none of them has been run against
a real tenant's data**, so nobody can tell you what volume they will produce in your estate. The
`lastValidated` date on every entry is the date the pack was authored, not the date someone
confirmed it still fires.

Every query carries at least one `falsePositives` entry and a `tuningNotes` paragraph saying what to
baseline. Those fields are the point of the pack as much as the KQL is.

## What is in it

| | |
| --- | --- |
| Queries | 15 |
| Tables | 8 — `DeviceProcessEvents`, `DeviceNetworkEvents`, `SigninLogs`, `AuditLogs`, `OfficeActivity`, `EmailPostDeliveryEvents`, `UrlClickEvents`, `AzureActivity` |
| ATT&CK | 10 tactics, 16 techniques |
| `queryType` | 10 `AnalyticsRule`, 4 `Hunting`, 1 `Investigation` |
| `severity` | 4 Critical, 6 High, 5 Medium |
| Connectors | `MicrosoftThreatProtection`, `AzureActiveDirectory`, `Office365`, `AzureActivity` |
| Licence | CC0-1.0, stated in `meta.license` and on every record |

Every entry bounds its own time range, is multi-line, names the table it reads, and carries ATT&CK
tactics and techniques, false positives, tuning notes, references, a severity and a lookback.
Thirteen of the fifteen also carry entity mappings; the two that do not are hunts whose output is a
stacked aggregate, which has no per-row entity to map.

## Loading it

**Through the UI.** *Import*, choose the file, review the preview, confirm. The preview reports what
will be added, what will be skipped as a duplicate id, what matches an existing query body, and
anything that fails validation — nothing is written until you confirm.

**Through the API**, which is the route for a scripted first run. The file can be posted as-is: the
import endpoint reads `queries` out of it and ignores `schemaVersion` and `meta`.

```console
$ curl -s -X POST http://localhost:8080/api/queries/import \
    -H 'Content-Type: application/json' \
    --data-binary @content/starter-pack.json
{"mode":"insert","total":15,"imported":15,"inserted":15,"updated":0,
 "skippedOlder":0,"skippedExisting":0,"results":[…],"rejected":[]}
```

In a cluster, run it from a frontend pod — the NetworkPolicy admits nothing else to the API:

```bash
kubectl -n kqlstore exec -i deploy/kqlstore -- \
  curl -s -X POST http://kqlstore-api:3000/api/queries/import \
  -H 'Content-Type: application/json' --data-binary @- < content/starter-pack.json
```

**Re-importing is safe.** The ids are stable UUIDs, so a second import reports
`{"inserted":0,"skippedExisting":15}` and changes nothing. If you have edited an entry and want the
shipped version back, delete that query first — an `upsert` will not help you, because the pack's
`updated` timestamps are older than your edit and upsert only overwrites with something strictly
newer.

## Using it as a schema example

The pack is the reference for [docs/schema.md](schema.md): it is validated in CI against the real
`validateQuery` with **zero errors**, not merely sanitised into shape, and the same suite asserts
that every entry exports as a Sentinel rule with no unexpected defaults and that the Navigator layer
covers every technique in the pack. If you are filling in the detection block by hand, copy the
shape from a record here.

```bash
npx vitest run content        # 22 tests
```

## Contributing queries

Do not open a pull request that adds queries to this file. The pack is deliberately small and every
entry has to be reviewable by someone who cannot run it in your tenant; propose one through the
*Detection query submission* issue template instead. See
[CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-query).
