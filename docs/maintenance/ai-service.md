# The `kqlstore-ai` service

The AI assistant is a third Deployment that exists to keep the network story of this
repo sound. The pod that holds the query store (`kqlstore-api`) has `egress: []` — it
cannot reach the network at all. The pod that talks to a third party (`kqlstore-ai`)
holds no database, no volume and no session state. What it is allowed to reach is
broad, so what it can reveal must be narrow. See [the AI-assist feature guide](../ai-assist.md)
for what leaves the cluster and why.

## What the pod is and is not allowed to do

| | Allowed | Not allowed |
| --- | --- | --- |
| Inbound | `kqlstore` frontend pods only, port 3001 (NetworkPolicy) | the API pod, other namespaces, anything else |
| Outbound | DNS to kube-dns (port 53), TCP 443 to anything outside RFC1918 | the API pod, the query PVC, the Kubernetes API |
| Data | query text in a request body, schemas, the response | a mounted PVC, `better-sqlite3`, any store |

The last row is the one that matters. A compromise of this pod yields what is *in
flight*, not the library.

## Why egress cannot be a CIDR

Ollama Cloud's addresses move. The NetworkPolicy therefore reads "443 to anywhere
outside RFC1918 and the cluster's own ranges" rather than a specific provider CIDR.
That is meaningfully weaker than `egress: []`, and it is the actual price of this
feature. Confining it to a pod with no data access is what makes the price acceptable.
Do not "tighten" this to a CIDR you happen to have seen resolved; it will break the
moment the provider rotates, and the failure is a silent hang, not an error.

## The cross-node NetworkPolicy hazard

`from: podSelector` ingress rules on this cluster are unreliable. Cross-node SNAT
erases pod identity, so such a rule permits or denies depending on where the scheduler
happens to place the pods. The `kqlstore → kqlstore-ai` rule has the same shape as the
pre-existing `kqlstore → kqlstore-api` rule, which works — that establishes that
*current* placement is favourable, not that the pattern is sound.

Re-test it deliberately after any change to the node pool, scheduling, or the policy
itself, with the pods forced onto different nodes:

```bash
kubectl -n kqlstore get pods -o wide          # note the nodes
kubectl -n kqlstore cordon <node-running-kqlstore-ai>
kubectl -n kqlstore rollout restart deploy/kqlstore-ai
kubectl -n kqlstore uncordon <node>

# ALLOW: from an nginx pod, the health endpoint must answer.
kubectl -n kqlstore exec deploy/kqlstore -- wget -qO- http://kqlstore-ai:3001/api/ai/health

# DENY: from a pod that is NOT labelled app=kqlstore, it must NOT answer.
kubectl -n kqlstore run netpol-probe --rm -it --restart=Never \
  --image=busybox --labels=app=probe -- \
  wget -T 5 -qO- http://kqlstore-ai:3001/api/ai/health
```

If the allow case fails once the pods are on different nodes, the fix is to widen the
rule's `from:` to a `namespaceSelector` on `kubernetes.io/metadata.name: kqlstore`
(any pod in the namespace may reach the AI service). That is weaker but correct, and
record the reason here when you do it. Do not ship UI that depends on the AI path
until this has been verified with pods on different nodes.

## Verifying egress reaches Ollama

```bash
kubectl -n kqlstore exec deploy/kqlstore-ai -- \
  node -e "fetch('https://ollama.com/api/tags',{headers:{Authorization:'Bearer '+process.env.OLLAMA_API_KEY}}).then(r=>console.log(r.status)).catch(e=>{console.error('FAILED',e.message);process.exit(1)})"
```

`200` means the network and the key both work. `401` means the key is wrong but the
network is right. A hang means the egress rule or DNS is wrong.

## Rotating `OLLAMA_API_KEY`

The key is injected as an environment variable at container start, so rotation is:

```bash
kubectl -n kqlstore create secret generic kqlstore-ai \
  --from-literal=OLLAMA_API_KEY='<new key>' --dry-run=client -o yaml | kubectl apply -f -
kubectl -n kqlstore rollout restart deploy/kqlstore-ai
```

Then prove the new key works with the egress check above. The Secret is mounted
`optional: true`, so applying the repo before the Secret exists leaves the pod running
with `configured:false` and the assist toggle hidden — not a crash loop.

## Disabling the feature

```bash
kubectl -n kqlstore scale deploy/kqlstore-ai --replicas=0
```

The SPA fetches `/api/ai/health` on load and hides the assist toggle when the service
is unreachable. Forking, schema editing and manual authoring are unaffected — the
toggle is hidden, not disabled, and nothing in the editor depends on the AI service.
Scale back to 1 to re-enable.
