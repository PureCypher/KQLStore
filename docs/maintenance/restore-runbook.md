# Restore runbook

The half nobody tests. Every procedure below was executed end to end against a real
three-node Kubernetes cluster before it was written down — including destroying the node
that held the store and bringing it back on a different one. What was tested, and what
was not, is recorded at the bottom.

Read the first two sections before you touch anything. The rest is the procedures.

---

## Before you start

**Which copy do you want?**

| Situation | Use | Why |
|---|---|---|
| Bad import, mangled rows, someone deleted the wrong thing | **A — local backup PVC** | Fastest. No network, no credentials, the file is already on the node. |
| Backup PVC gone, but the node is alive | **B — off-node bucket** | The local copies are gone with the claim; the bucket is not. |
| Node is dead, degraded or being rebuilt | **C — node loss** | Both PVCs live on that node. Only the bucket survived. |

**Take stock first.** You cannot make a good decision about which backup to restore
without knowing what is in them:

```sh
kubectl -n kqlstore get pods -o wide            # is the API up? which node?
kubectl -n kqlstore get pvc                     # are both claims Bound?
kubectl -n kqlstore get jobs                    # did the backups run?
kubectl -n kqlstore logs job/<newest-backup-job>
```

A healthy local backup job log looks like this — the row counts are the point, and the
second number is the live store at the moment the snapshot was taken:

```
backup ok: /backup/kqlstore-2026-07-26T13-27-55Z.db (16384 bytes, 18 queries, store had 18)
retention: 2 copies kept (14d, floor 7), 0 pruned
```

**Restoring loses data.** Everything written after the backup's timestamp is gone. The
procedures below move the current database aside rather than deleting it, so you can
change your mind; do not skip that step to save a line of typing.

---

## The two things that ruin a restore

### 1. Scale the API to zero first

The API holds the database file open. Replacing a file underneath a live SQLite
connection does not produce an error — it produces a process reading pages from a file
that no longer exists alongside a WAL that describes a different one. That is how a
restore turns one problem into two.

```sh
kubectl -n kqlstore scale deploy/kqlstore-api --replicas=0
kubectl -n kqlstore wait --for=delete pod -l app=kqlstore-api --timeout=120s
```

Wait for the pod to actually be **gone**, not merely Terminating. The `wait` above is not
decoration.

The store is offline from here until you scale back up. On a single-writer datastore
behind Cloudflare Access that is a few minutes of 502 for one person, which is the
correct trade.

### 2. The WAL sidecars must go with the database they belong to

The store runs in WAL mode (`api/db.js` sets `journal_mode = WAL`). Committed data lives
in `kqlstore.db-wal` until a checkpoint folds it into `kqlstore.db`. Measured on the test
cluster, mid-drill, with 20 queries in the store:

```
-rw-r--r-- 1 node node   4096 kqlstore.db        <- 4 KB
-rw-r--r-- 1 node node  32768 kqlstore.db-shm
-rw-r--r-- 1 node node 276072 kqlstore.db-wal    <- 276 KB, i.e. all of it
```

Two consequences:

- **Never `cp kqlstore.db` as a backup.** You would have copied 4 KB of an empty-looking
  database and left the entire dataset behind. This is exactly why the CronJob uses
  SQLite's online backup API instead.
- **When restoring, the old `-wal` and `-shm` must not be left in place.** SQLite will
  find them next to the file you just restored, decide they are that file's journal, and
  replay them over the top of it. You get a database that is neither the backup nor the
  original.

The backup files themselves have no sidecars — the CronJob takes each copy out of WAL
mode (`journal_mode = DELETE`) precisely so a restore is a single self-contained file.

After a **clean** shutdown SQLite checkpoints and removes the sidecars, so you may find
only `kqlstore.db`. After a crash or a node failure they will still be there. The
procedures below handle both without you having to check.

---

## Procedure A — restore from the local backup PVC

The everyday case. Takes about two minutes.

**A1. Start the maintenance pod.**

```sh
kubectl apply -f docs/maintenance/backup-shell.yaml
kubectl -n kqlstore wait --for=condition=Ready pod/kqlstore-maint --timeout=180s
```

> The maintenance pod has a `podAffinity` on `app: kqlstore-api` — it must land on the
> API's node to mount the ReadWriteOnce claims. **It therefore needs a running API pod to
> anchor to.** Apply it *before* you scale the API to zero, or it will sit Pending
> forever. This trips people up in Procedure C; see the note there.

**A2. Choose a backup and prove it is good before trusting it.**

```sh
kubectl -n kqlstore exec kqlstore-maint -c shell -- ls -l /backup

BK=kqlstore-2026-07-26T13-27-55Z.db          # newest, or whichever predates the damage

kubectl -n kqlstore exec kqlstore-maint -c shell -- node -e "
const Database = require('better-sqlite3');
const db = new Database('/backup/$BK', { readonly: true, fileMustExist: true });
console.log('integrity:', db.pragma('integrity_check', { simple: true }));
console.log('rows:', db.prepare('SELECT COUNT(*) AS n FROM queries').get().n);
db.close();"
```

Expected:

```
integrity: ok
rows: 18
```

If the row count is not roughly what you expect, stop and pick a different file. This
check costs seconds and is the difference between restoring a backup and restoring a
problem. (There is no `sqlite3` CLI in the image — the `shell` container runs the API
image, and better-sqlite3 is how you talk to the file.)

**A3. Scale the API to zero.** See above.

**A4. Move the current database aside and put the backup in place.**

```sh
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

kubectl -n kqlstore exec kqlstore-maint -c shell -- sh -c "
  cd /data
  for f in kqlstore.db kqlstore.db-wal kqlstore.db-shm; do
    [ -e \$f ] && mv \$f \$f.pre-restore-$STAMP
  done
  cp /backup/$BK /data/kqlstore.db
  ls -l /data"
```

Move, do not delete. The renamed file is your way back if the restore turns out to be
the wrong call, and it stays on the PVC rather than in a container that is about to
disappear. Renaming also satisfies the WAL rule — the old sidecars are no longer named
like `kqlstore.db`'s journal, so SQLite will not replay them.

Clean it up once you are confident:
`kubectl -n kqlstore exec kqlstore-maint -c shell -- sh -c 'rm -f /data/*.pre-restore-*'`

**A5. Bring the API back and check.**

```sh
kubectl -n kqlstore scale deploy/kqlstore-api --replicas=1
kubectl -n kqlstore rollout status deploy/kqlstore-api --timeout=180s
kubectl -n kqlstore port-forward deploy/kqlstore-api 18080:3000 &
# GET /api/queries returns a bare JSON array, not an envelope
curl -s http://127.0.0.1:18080/api/queries | python3 -c 'import json,sys; print(len(json.load(sys.stdin)), "queries")'
```

Compare that number against the row count you saw in A2. They must match: the API reading
the same count out of the file you verified is the only evidence that the restore actually
took, as opposed to the API having quietly recreated an empty schema over a file it could
not read.

**A6. Delete the maintenance pod.** It holds a mount on the API's node.

```sh
kubectl -n kqlstore delete -f docs/maintenance/backup-shell.yaml
```

---

## Procedure B — restore from the off-node bucket

Same shape as A, but the file comes from the S3-compatible endpoint. Use this when the
backup PVC is gone or suspect and the node is still alive. Requires
`k8s/api-backup-offsite-config.yaml` and the `kqlstore-backup-offsite` Secret to be
configured — see [offsite-backup.md](offsite-backup.md).

The maintenance pod carries a second container, `fetch`, running the same rclone image
and the same credentials as the CronJob, so there is nothing new to configure while you
are already having a bad day.

**B1. Start the maintenance pod** (as A1) **and see what is in the bucket.**

```sh
kubectl -n kqlstore exec kqlstore-maint -c fetch -- \
  rclone lsl offsite:$BUCKET/$PREFIX/
```

```
    16384 2026-07-26 13:28:25.372 kqlstore-2026-07-26T13-27-55Z.db
       99 2026-07-26 13:28:25.372 kqlstore-2026-07-26T13-27-55Z.db.sha256
```

**B2. Download the copy and its checksum, and verify the transfer.**

```sh
BK=kqlstore-2026-07-26T13-27-55Z.db

kubectl -n kqlstore exec kqlstore-maint -c fetch -- sh -c "
  rclone copyto offsite:$BUCKET/$PREFIX/$BK        /restore/$BK &&
  rclone copyto offsite:$BUCKET/$PREFIX/$BK.sha256 /restore/$BK.sha256 &&
  cd /restore && sha256sum -c $BK.sha256"
```

```
kqlstore-2026-07-26T13-27-55Z.db: OK
```

It downloads to `/restore`, never to `/data`. The `fetch` container deliberately does not
mount the live store: it has network access and bucket credentials, and it has no
business being able to write to the database. A failed download therefore leaves you with
a broken file in scratch space rather than a broken store.

**B3. Prove it is a working database**, using the `shell` container — the only one with
better-sqlite3:

```sh
kubectl -n kqlstore exec kqlstore-maint -c shell -- node -e "
const Database = require('better-sqlite3');
const db = new Database('/restore/$BK', { readonly: true, fileMustExist: true });
console.log('integrity:', db.pragma('integrity_check', { simple: true }));
console.log('rows:', db.prepare('SELECT COUNT(*) AS n FROM queries').get().n);
db.close();"
```

```
integrity: ok
rows: 18
```

**B4. Scale to zero, install, restart** — exactly as A3–A6, but copying from `/restore`
instead of `/backup`:

```sh
kubectl -n kqlstore exec kqlstore-maint -c shell -- sh -c "
  cd /data
  for f in kqlstore.db kqlstore.db-wal kqlstore.db-shm; do
    [ -e \$f ] && mv \$f \$f.pre-restore-$STAMP
  done
  cp /restore/$BK /data/kqlstore.db"
```

---

## Procedure C — the node is gone

The failure the off-node copy exists for. Both PVCs are node-local: when the node dies,
the live store **and** every local backup go with it. Only the bucket is left.

This was rehearsed by stopping the node outright, and the four steps that are not obvious
are all in here.

**C1. Confirm what you have lost.**

```sh
kubectl get nodes
kubectl get pv -o custom-columns='PV:.metadata.name,CLAIM:.spec.claimRef.name,NODE:.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0]'
```

```
NAME                                  STATUS     ROLES           AGE   VERSION
kqlstore-restore-test-worker          NotReady   <none>          18m   v1.34.0

PV                                         CLAIM                 NODE
pvc-57d54e26-...                           kqlstore-api-data     kqlstore-restore-test-worker
pvc-b242ecd3-...                           kqlstore-api-backup   kqlstore-restore-test-worker
```

Both claims pinned to the dead node. Procedure A is not available to you.

**C2. Stand the workload down and clear the stranded storage.**

```sh
kubectl -n kqlstore scale deploy/kqlstore-api --replicas=0
```

The API pod will hang in `Terminating`: the kubelet on the dead node cannot confirm the
pod is gone, and the `Recreate` strategy will not start a replacement until it does.
Force it, having first made certain the node really is down — force-deleting a pod whose
node is merely unreachable can leave two writers on one database:

```sh
kubectl -n kqlstore delete pod <stuck-pod> --force --grace-period=0
```

The PVCs and PVs also need to go. They will not delete cleanly, because the local-path
provisioner wants to run a cleanup pod on a node that no longer exists, so their
finalizers must be cleared by hand:

```sh
kubectl -n kqlstore delete pvc kqlstore-api-data kqlstore-api-backup --wait=false
kubectl -n kqlstore patch pvc kqlstore-api-data   -p '{"metadata":{"finalizers":null}}' --type=merge
kubectl -n kqlstore patch pvc kqlstore-api-backup -p '{"metadata":{"finalizers":null}}' --type=merge

for pv in $(kubectl get pv -o name); do
  kubectl patch $pv -p '{"metadata":{"finalizers":null}}' --type=merge
  kubectl delete $pv --wait=false
done
```

Only do this once you have accepted that the data on that node is unrecoverable. If the
node might come back — a failed boot rather than a failed disk — fix the node instead and
use Procedure A. It has the fresher data.

**C3. Point the workload at a surviving node and let it create empty volumes.**

If the cluster has more than one eligible node, the scheduler will pick one. Pin it if
you care which:

```sh
kubectl -n kqlstore patch deploy kqlstore-api --type=merge \
  -p '{"spec":{"template":{"spec":{"nodeSelector":{"kubernetes.io/hostname":"<new-node>"}}}}}'

kubectl apply -k k8s/                                    # recreates the PVCs
kubectl -n kqlstore scale deploy/kqlstore-api --replicas=1
kubectl -n kqlstore rollout status deploy/kqlstore-api --timeout=180s
```

The API starts on an empty store and creates the schema. That is expected and it is also
useful: it is what binds the new PersistentVolumes to the new node, and it gives the
maintenance pod something to anchor its `podAffinity` to.

> **The ordering that catches people.** The maintenance pod requires a running
> `app: kqlstore-api` pod on the node. In a node-loss recovery your instinct is to scale
> the API to zero and restore into a clean volume — but then the maintenance pod can never
> schedule. Let the API come up empty first, apply the maintenance pod, and *then* scale
> the API to zero for the restore. Verified: 0 queries on the fresh node before the
> restore, 18 after it.

**C4. Restore from the bucket.** Procedure B, from B1 onward, unchanged.

**C5. Check the whole loop, not just the data.** A recovery is not finished when the rows
are back; it is finished when the thing that protects them is running again on the new
node:

```sh
kubectl -n kqlstore create job --from=cronjob/kqlstore-api-backup post-recovery-check
kubectl -n kqlstore logs job/post-recovery-check
```

```
backup ok: /backup/kqlstore-2026-07-26T13-36-09Z.db (16384 bytes, 18 queries, store had 18)
retention: 1 copies kept (14d, floor 7), 0 pruned
```

Then the off-node one:

```sh
kubectl -n kqlstore create job --from=cronjob/kqlstore-api-backup-offsite post-recovery-offsite
kubectl -n kqlstore logs job/post-recovery-offsite -c verify-restore
```

Note the local backup PVC starts empty on the new node — the retention floor now has one
copy to work with, not fourteen. You have a fresh store with a thin history for the next
couple of weeks.

---

## Restoring onto a workstation

Sometimes you only want to look. The backups are ordinary SQLite files with no sidecars:

```sh
kubectl -n kqlstore cp kqlstore-maint:/backup ./kqlstore-backups -c shell
sqlite3 ./kqlstore-backups/kqlstore-2026-07-26T13-27-55Z.db 'SELECT COUNT(*) FROM queries;'
```

Or from the bucket directly with any S3 client, using the same credentials as the Secret.
The off-node copy is deliberately a plain object with a `.sha256` beside it, not an
archive in some tool's private format: if every part of this system is unavailable, you
can still fetch the file with `curl` and open it.

---

## What was actually tested, and what was not

Executed on 2026-07-26 against kind v0.30.0, Kubernetes v1.34.0, three nodes
(one control-plane, two workers), with MinIO standing in for the S3 endpoint and pinned to
a *different* node from the store. Images: the API image built from `api/Dockerfile`, and
`rclone/rclone:1.74.4@sha256:c61954aa...` as pinned in the manifests. The manifests were
applied as rendered by `kubectl apply -k k8s/`, with three substitutions for the test
environment only: the image reference, `imagePullPolicy`, and `storageClassName`
(`local-path` → kind's `standard`, which is the same rancher local-path provisioner).

Verified:

- Local backup job: online backup, `integrity_check`, row count against the live store
  (`18 queries, store had 18`).
- Retention floor, off-node: 13 copies of which 12 were over 30 days old, floor of 7 →
  6 deleted, 7 retained. An age-only rule would have left exactly 1.
- Off-node pipeline: staged, uploaded, downloaded back, sha256 matched end to end
  (`ac774b32...`), opened, `integrity_check` ok, 18 rows both sides.
- Unconfigured destination: the Job **fails** and names the four missing keys.
- Procedure A: live store diverged to 20 rows, restored to the 15-row backup, post-backup
  rows confirmed gone.
- Move-aside variant: restored to 18 rows while the displaced 19-row database remained on
  the PVC and still opened.
- Procedure C: worker node stopped outright, both PVCs stranded, store rebuilt on the
  second worker from the bucket alone — 18 of 18 queries recovered, and both backup jobs
  confirmed working afterwards on the new node.

**Not** verified:

- **The NetworkPolicies were applied but not enforced.** kind's default CNI (kindnet)
  ignores NetworkPolicy — a pod carrying the deny-all `app: kqlstore-api-backup` label
  reached MinIO anyway during the drill. The policies are syntactically valid and accepted
  by the API server, but their behaviour depends on your cluster running a policy engine
  (Calico, Cilium) and has not been demonstrated here. If your production cluster does
  enforce them, expect the off-node job to need its egress rule pointed at your real
  endpoint and port.
- Backblaze B2, Cloudflare R2 and AWS S3 proper. Only MinIO was exercised. The rclone
  configuration for the others differs by `OFFSITE_PROVIDER` and `OFFSITE_REGION` only,
  but "should work" is not "was tested" — run the job by hand once after configuring it,
  which is the first thing [offsite-backup.md](offsite-backup.md) tells you to do.
- Restores of a store materially larger than a few hundred kilobytes. Timings here are
  not representative of a store that has grown by orders of magnitude.
