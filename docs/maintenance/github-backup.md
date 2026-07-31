# Versioned copy in git

The other two backups are snapshots. The local PVC copy and the off-node MinIO copy both
answer *"what did the store look like on the night of the 3rd"*, and both answer it well.
Neither answers the question a detection library actually raises six months later:

> When did this detection change, and what did it say before?

`k8s/api-backup-github-cronjob.yaml` answers that by committing **one file per query** to a
private git repository, so `git log queries/<name>.json` is the history of a single detection.

Files are named from the query's name, slugged to `[a-z0-9-]`, because a directory of UUIDs
is unreadable and being readable is the whole point of this copy:

```
queries/authentication-failure-pattern-analysis-password-spray-and-brute-force-detection.json
queries/ai-platform-usage-tracker-user-activity-trend-analysis.json
queries/dcsync.json
```

Three consequences, all handled:

- **Names are not unique.** The first claimant of a slug — by id order, which is stable —
  keeps the bare name; later ones take a short id suffix (`suspicious-logon-bbbbbbbb.json`).
  Suffixing *everything* on collision would rename an existing file whenever an unrelated
  query happened to collide with it, so it does not do that.
- **Names can be empty, non-latin, or enormous.** Empty becomes `untitled`, characters
  outside `[a-z0-9]` are stripped, and the slug is capped at 80 characters. A name written
  entirely in a non-latin script slugs to nothing and falls back to `untitled`, then takes
  an id suffix if that collides — unreadable, but never lost or overwritten.
- **Renaming a query renames its file**, so git records a delete and an add rather than an
  edit. Nothing avoids that while filenames carry meaning. The content is byte-identical
  across the rename, so git's rename detection links them: reach for
  `git log --follow queries/<name>.json` when a detection's history appears to start
  abruptly.

It ships unconfigured and fails until you configure it, the same as the off-node job.

---

## It is not a restore path

With `REDACT_DISCLOSURES` on — the default — the committed queries are deliberately **not**
byte-faithful. Watchlist names, internal addresses and similar are replaced with
`REDACTED-<fingerprint>` markers. A restore from git would produce queries that parse and
do not run.

**Restore from the MinIO copy.** See [offsite-backup.md](offsite-backup.md) and
[restore-runbook.md](restore-runbook.md). This job is history and off-site index, nothing
more. If you decide the destination repository's privacy is protection enough, set
`REDACT_DISCLOSURES: "false"` and the copy becomes faithful and restorable — read the scan
output first, and read the next section before you do.

---

## The repository must be private, and the job enforces it

A detection library discloses as much by omission as by content: what you hunt for implies
what you do not. Before the first run the job reads the repository's own metadata and
**refuses to publish if it reports `private: false`**. Nothing is pushed; the Job goes red.

That check exists because this is the one mistake with no undo. A repository made public by
accident cannot be un-published — forks, clones and search indexes outlive the setting.

**GitHub's push protection does not help here.** It scans for credentials. A scan of the
maintainer's own 48 queries found zero credentials and, in the same pass, the complete
inventory of Sentinel watchlist names — including honeytoken lists and an RC4 exception
list. Every one of those would sail through push protection untouched. The privacy of the
destination is the control; the platform is not.

---

## What the scan does

The `scan` step sorts findings into two classes and treats them very differently.

| Class | Examples | Behaviour |
| --- | --- | --- |
| **SECRET** | AWS keys, SAS tokens, JWTs, bearer tokens, private key blocks, `password=…` | **Fails the job.** Nothing leaves the cluster. |
| **DISCLOSURE** | Private IPv4, emails/UPNs, UNC paths, GUIDs, watchlist names, internal hostnames | Replaced with `REDACTED-<fingerprint>` when redaction is on. |

A credential is **not** redacted and waved through. If a key reached the query store, a
human needs to know tonight and the key needs rotating; quietly redacting it would hide an
incident behind a green tick. The job stops and the log names the query.

### What is deliberately not redacted

- **Microsoft AD extended-rights GUIDs** (`1131f6aa-…`, `89e95b76-…` and friends). Public
  schema constants in every DCSync detection ever written. They are in `SCAN_ALLOWLIST`
  because redacting them breaks the detection and protects nothing.
- **Public domains** — `api.openai.com`, `gemini.google.com` and so on. The hostname rule
  matches only internal suffixes (`.local`, `.internal`, `.corp`, `.lan`, `.intra`,
  `.home`, `.ad`), so a shadow-AI hunt keeps working. A detection that looks for
  `api.openai.com` discloses nothing by naming it.

### Why the fingerprint, rather than a bare `REDACTED`

`REDACTED-<8 hex>` is `HMAC-SHA256(REDACTION_SALT, value)`, truncated. Two properties, both
load-bearing:

- **Stable.** The same value always yields the same marker, so an unchanged store produces
  an identical tree and therefore **no commit**. A bare random placeholder would rewrite
  every file nightly and the history would stop meaning anything.
- **Distinguishing.** A diff still shows a query moving from one watchlist to another
  without naming either.

The salt is what makes it non-reversible: watchlist names are short and guessable, so an
unsalted hash falls to a wordlist in seconds. Rotating the salt rewrites every marker and
produces one large diff — generate it once and leave it alone.

---

## Configure it

**1. Create a private repository.** Empty is fine; the job creates the branch on first run.
Do not point it at KQLStore.

**2. Fill in the destination** in `k8s/api-backup-github-config.yaml`. Edit it in git and
apply — `kubectl apply -k k8s/` overwrites the live ConfigMap, so an in-cluster edit is
reverted by the next unrelated deploy.

```yaml
GITHUB_REPO:   "your-org/kqlstore-queries"
GITHUB_BRANCH: "main"
GITHUB_PATH:   "queries"
```

**3. Create the credentials.** Not in git, ever — see
[github-backup-secret.example.yaml](github-backup-secret.example.yaml) for the full
reasoning.

```sh
kubectl -n kqlstore create secret generic kqlstore-backup-github \
  --from-literal=GITHUB_TOKEN='github_pat_...' \
  --from-literal=REDACTION_SALT="$(openssl rand -base64 32)"
```

The token is a **fine-grained PAT scoped to that one repository** with `Contents: Read and
write` and nothing else. A classic `repo`-scoped token grants write to everything you can
see; do not use one.

**4. Apply and prove it, rather than waiting for 04:17:**

```sh
kubectl apply -k k8s/
kubectl -n kqlstore create job --from=cronjob/kqlstore-api-backup-github gh-test
kubectl -n kqlstore get pods -l job-name=gh-test -w
```

A good first run, one container at a time:

```sh
kubectl -n kqlstore logs job/gh-test -c stage
  staged 48 queries from kqlstore-2026-07-30T22-18-42Z.db (age 0.4h, integrity ok)

kubectl -n kqlstore logs job/gh-test -c scan
  scanned 48 queries — 0 secrets
  redacted:
    Watchlist name: 28
    Private IPv4: 3
  wrote 49 files to the staging tree

kubectl -n kqlstore logs job/gh-test -c verify-private
  destination your-org/kqlstore-queries is private, default branch main

kubectl -n kqlstore logs job/gh-test -c publish
  committed 4f2a91c8 to your-org/kqlstore-queries@main
  49 files, 48 queries, redaction enabled
```

The second run, with nothing changed, should say:

```
no change since the last run — nothing committed
```

If it commits every night with no real edits, something upstream is unstable — check that
`REDACTION_SALT` is set and has not changed.

---

## The failure you should see first

Applied without configuring, the Job fails in about two seconds having touched nothing:

```
refusing to run — the destination is not configured:
  GITHUB_REPO (ConfigMap kqlstore-backup-github) is unset or still REPLACE-ME
  GITHUB_TOKEN (Secret kqlstore-backup-github) is unset or still REPLACE-ME
see docs/maintenance/github-backup.md
```

That is the intended state of a fresh `apply -k`, and it is deliberate. A backup job that
quietly does nothing is worse than no backup job: it manufactures confidence.

---

## Ordering

| | Schedule | What it writes |
| --- | --- | --- |
| `kqlstore-api-backup` | 03:17 | Verified `.db` on the backup PVC, 14 days |
| `kqlstore-api-backup-offsite` | 03:47 | Same file to MinIO, 30 days, round-trip verified |
| `kqlstore-api-backup-github` | 04:17 | One JSON file per query, committed if changed |

This job reads what the 03:17 job wrote, so it must not race it. `MAX_AGE_HOURS` (26 by
default) turns a silently failing local backup into a loud failure here, rather than a
nightly no-change commit against a file that stopped moving a week ago.
