# Off-node backup — configuration

The nightly backup job writes to a second PersistentVolumeClaim. That claim is
`local-path` storage on the same node as the live store, because the job has to run there
to mount the ReadWriteOnce data volume at all. Two copies, one machine.

That is real protection against the mistakes — a bad import, an application bug, deleting
the wrong claim — and no protection at all against the failure that actually destroys the
store, which is losing the node. `k8s/api-backup-offsite-cronjob.yaml` closes that gap by
pushing the verified nightly backup to an S3-compatible endpoint.

**It ships unconfigured and it fails until you configure it.** That is deliberate. See
[The failure you should see first](#the-failure-you-should-see-first).

---

## Choosing a destination

"Off-node" is the bar that matters, and it is lower than "off-site". Anything that is not
the machine running the store is an improvement on today. Pick the tier you will actually
maintain — an unmaintained cloud bucket protects nothing.

| Destination | Survives | `OFFSITE_PROVIDER` | Notes |
|---|---|---|---|
| MinIO on another node / NAS | node loss, disk loss | `Minio` | No egress cost, no bill, no third party. The realistic homelab answer. |
| Backblaze B2 | the building | `Other` | Cheapest credible cloud tier. Endpoint is region-specific. |
| Cloudflare R2 | the building | `Cloudflare` | No egress charges, which suits the nightly round-trip verification. Region is `auto`. |
| AWS S3 | the building | `AWS` | Set the real region. Path-style addressing is off for this provider, which is correct. |
| Anything else S3-shaped (Garage, SeaweedFS, Wasabi, Storj) | varies | `Other` | `Other` keeps path-style addressing on, which is what most self-hosted gateways need. |

The bucket must already exist. The job will not create it: creating buckets needs a
credential far broader than "write objects into one prefix", and a typo in a bucket name
that silently creates a second one is how you end up with an empty archive you believe in.

---

## Configure it

**1. Fill in the destination** in `k8s/api-backup-offsite-config.yaml`. Edit it in git and
apply — do not `kubectl edit` the live ConfigMap. `kubectl apply -k k8s/` overwrites it,
so an in-cluster edit will be silently reverted by the next unrelated deploy. (This is not
hypothetical; it happened during testing, which is why it is the first thing said here.)

```yaml
OFFSITE_ENDPOINT: "https://s3.us-west-004.backblazeb2.com"
OFFSITE_BUCKET:   "kqlstore-backups"
OFFSITE_PREFIX:   "kqlstore"
OFFSITE_PROVIDER: "Other"
OFFSITE_REGION:   "us-west-004"
```

**2. Create the credentials.** These are *not* in git and must never be — see
[offsite-backup-secret.example.yaml](offsite-backup-secret.example.yaml) for the full
reasoning and for a template if you prefer a file. The short version:

```sh
kubectl -n kqlstore create secret generic kqlstore-backup-offsite \
  --from-literal=OFFSITE_ACCESS_KEY_ID='...' \
  --from-literal=OFFSITE_SECRET_ACCESS_KEY='...'
```

Scope the key to this bucket and prefix. It needs `PutObject`, `GetObject`, `ListBucket`
and `DeleteObject`, and nothing else — no bucket creation (the job sets
`RCLONE_S3_NO_CHECK_BUCKET` so it never issues `HeadBucket`).

**3. Apply and prove it works.** Do not wait for 03:47 to find out:

```sh
kubectl apply -k k8s/
kubectl -n kqlstore create job --from=cronjob/kqlstore-api-backup-offsite offsite-test
kubectl -n kqlstore get pods -l job-name=offsite-test -w
```

A good run looks like this, one container at a time:

```sh
kubectl -n kqlstore logs job/offsite-test -c stage
  staged kqlstore-2026-07-26T13-27-55Z.db: 16384 bytes, 18 queries, integrity ok, age 0.0h
  sha256 ac774b320d907ee3d42a87bd59c8e981af9f0774045f25a456bed2f8416ba044

kubectl -n kqlstore logs job/offsite-test -c upload
  upload ok: offsite:kqlstore-backups/kqlstore/kqlstore-2026-07-26T13-27-55Z.db (16384 bytes)

kubectl -n kqlstore logs job/offsite-test -c verify-restore
  off-node copy verified: kqlstore-2026-07-26T13-27-55Z.db restored from
    kqlstore-backups/kqlstore, 16384 bytes, 18 queries, integrity ok

kubectl -n kqlstore logs job/offsite-test -c prune
  retention: 1 copies, 0 older than 30d, floor 7, deleting 0
  off-node backup complete: 1 copies retained at offsite:kqlstore-backups/kqlstore
```

Delete the test Job afterwards: `kubectl -n kqlstore delete job offsite-test`.

**4. Read the restore runbook** — [restore-runbook.md](restore-runbook.md) — and follow
Procedure B once, deliberately, on a day when nothing is wrong. A backup you have never
restored is a hypothesis.

---

## The failure you should see first

Before you configure anything, the job fails, and it says why:

```
OFF-NODE BACKUP IS NOT CONFIGURED - refusing to run.

  OFFSITE_ENDPOINT is unset or still REPLACE-ME  (ConfigMap kqlstore-backup-offsite)
  OFFSITE_BUCKET is unset or still REPLACE-ME  (ConfigMap kqlstore-backup-offsite)
  OFFSITE_ACCESS_KEY_ID is unset or still REPLACE-ME  (Secret kqlstore-backup-offsite)
  OFFSITE_SECRET_ACCESS_KEY is unset or still REPLACE-ME  (Secret kqlstore-backup-offsite)

Nothing has been uploaded. Fix the objects above, then:
  kubectl -n kqlstore create job --from=cronjob/kqlstore-api-backup-offsite offsite-test
```

This is the design, not a bug. The alternative — skipping quietly when unconfigured — is
worse than having no job at all, because `kubectl get cronjob` would then show a backup
that has never once run, next to a green tick.

Two details exist purely to make sure you can read that message:

- The Secret is referenced with `optional: true`. A required `secretRef` would wedge the
  pod in `CreateContainerConfigError` and you would have to go digging in events.
- `restartPolicy: Never`, not `OnFailure`. With `OnFailure` the Job controller deletes the
  pod when it gives up, and the message goes with it — `kubectl logs job/...` returns
  "error: timed out waiting for the condition". This was found by running it.

---

## What the job actually does

Five steps, in order, each of which must succeed before the next runs:

| # | Container | Image | Does |
|---|---|---|---|
| 1 | `stage` | API image | Preflight the config; pick the newest local backup; copy it to scratch; `integrity_check`; count rows; sha256. |
| 2 | `upload` | rclone | PUT the file and a `.sha256` sidecar; compare the remote size. |
| 3 | `verify-download` | rclone | GET the object back into a *separate* volume. |
| 4 | `verify-restore` | API image | sha256 must match; open it; `integrity_check`; row count must match. |
| 5 | `prune` | rclone | Retention — last, because it is the only step that deletes. |

It uploads the file the **local** job already produced and verified, rather than taking a
second snapshot of the live database. One reader on the store instead of two, one lineage,
one checksum end to end. The cost is a dependency on the local job, handled by
`OFFSITE_MAX_AGE_HOURS`: if the newest local backup is stale the off-node job fails rather
than re-uploading the same file every night and reporting success.

### Why the round trip

Step 3 downloads the object it just uploaded, and step 4 opens it with SQLite. It would be
cheaper to trust the upload. It would also mean nobody has ever opened these files, and
"the bytes transferred without error" is not the same claim as "this is a database you can
restore".

Disable it with `OFFSITE_VERIFY_ROUNDTRIP: "false"` if egress is billed and you have
decided you would rather not know — the job then says so, loudly, three times, in its log.
R2 and a LAN MinIO charge nothing for this.

### Retention, and why there is a floor

`OFFSITE_RETENTION_DAYS` (30) with `OFFSITE_MIN_COPIES` (7). The floor wins.

Prune-by-age quietly assumes backups keep arriving. Suppose the job breaks for five weeks
— a rotated credential, a full bucket, a dead uplink — and is then fixed. The next run
uploads one fresh copy and, on an age-only rule, deletes every copy older than 30 days:
all of them. The archive collapses from 30 copies to 1 at the exact moment you are least
sure the store is healthy, and if today's copy is a faithful backup of an already-damaged
database, there is nothing to go back to.

Measured with 13 copies, 12 of them over 30 days old: 6 deleted, 7 retained. Age alone
would have left 1.

The same floor now applies to the local backup job (`MIN_COPIES`, default 7).

### Rotating credentials

```sh
kubectl -n kqlstore delete secret kqlstore-backup-offsite
kubectl -n kqlstore create secret generic kqlstore-backup-offsite \
  --from-literal=OFFSITE_ACCESS_KEY_ID='...' \
  --from-literal=OFFSITE_SECRET_ACCESS_KEY='...'
kubectl -n kqlstore create job --from=cronjob/kqlstore-api-backup-offsite offsite-rotate-check
kubectl -n kqlstore logs job/offsite-rotate-check -c upload
```

Always run the job by hand after rotating. Otherwise the first thing that tells you the
new key is wrong is a failed Job at 03:47, and the second thing is a restore that has
nothing to restore from.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `OFF-NODE BACKUP IS NOT CONFIGURED` | Working as designed. Fill in the ConfigMap and create the Secret. |
| `newest local backup ... is 51.2h old` | The **local** job is broken. Fix that first: `kubectl -n kqlstore logs -l app=kqlstore-api-backup --tail=50`. |
| `no backup found in /backup` | The local job has never succeeded, or you are looking at a rebuilt node. |
| `NoSuchBucket` on the PUT | Bucket does not exist, or the name is wrong. The job does not create buckets. |
| `SignatureDoesNotMatch` / `InvalidAccessKeyId` | Wrong credentials, or wrong `OFFSITE_REGION` — several providers sign with the region. |
| rclone hangs, then the Job hits `activeDeadlineSeconds` | Egress blocked. Check the NetworkPolicy in `api-backup-offsite-cronjob.yaml` covers your endpoint's port; it allows 443, 80 and 9000. |
| `sha256 mismatch` on `verify-restore` | The object in the bucket is not what was uploaded. Do not trust it as a restore source. Investigate the endpoint before anything else. |
| Job Pending forever | `podAffinity` cannot find the API pod. The job must run on the API's node to mount the backup PVC. |
| The destination reverted to `REPLACE-ME` | Someone ran `kubectl apply -k k8s/` after editing the live ConfigMap. Edit it in git. |
