# Security Policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on
<https://github.com/PureCypher/KQLStore>. That opens a private advisory visible only to the
maintainer. Please do not open a public issue for anything exploitable, and please do not put
proof-of-concept exploit code in a public pull request.

A useful report includes the commit you tested, the deployment shape (Docker, or Kubernetes with
or without Cloudflare Access in front), the request or input that triggers it, and what an
attacker gets out of it. A `curl` reproduction is worth more than a scanner output.

This is a single-maintainer project with no service-level commitment attached to it. Expect an
acknowledgement within a week. Fixes land on `main`; there is no backport branch and no LTS.

## Scope

**In scope**

- The API in `api/` — injection, authorisation logic, input handling, resource exhaustion,
  anything that corrupts or discloses the query store.
- The SPA in `src/` — cross-site scripting, particularly through the syntax highlighter in
  `src/domain/highlight.js`, whose output is rendered as markup; prototype pollution through
  imported JSON; anything that turns stored data into executed code; a CSP bypass.
- The export generators in `src/export/` — an injection that turns stored query text into
  something harmful in the *consumer* of the file, such as YAML that breaks out of the block scalar
  it is emitted in, or a `references` entry carrying a non-`http` scheme into a downstream tool.
- The container images and `k8s/` manifests — privilege escalation, an over-broad NetworkPolicy,
  a writable path that should not be writable, a secret that ends up in an image layer, a backup
  that is not a valid restore.
- Data loss and integrity: a request that silently drops or overwrites stored queries.
- The build and CI supply chain in `.github/` — an unpinned action, a step that turns a pull
  request into a write to the repository.

**Out of scope**

- **The API having no authentication of its own.** This is deliberate and is described below.
  Reports amounting to "unauthenticated `POST /api/queries` succeeds" will be closed.
- Anything that requires the origin to be exposed to the internet without Cloudflare Access in
  front of it. That is a deployment error, and the README and this file both say so.
- Missing rate limiting on an interface reachable only by authenticated staff through Access.
- `style-src 'unsafe-inline'` in the Content-Security-Policy. It is a known, documented
  concession for React's `style` prop; inline styles cannot execute script, and `script-src` is
  strict. A demonstrated exploit through it is of course in scope.
- Findings from an automated scanner with no demonstrated impact.

## Deployment security posture

The design assumption is a private, self-hosted deployment behind an identity-aware proxy. Every
control below follows from that assumption; they are not independent, and removing the first one
invalidates several of the others.

### Authentication happens at the edge, and only at the edge

**Cloudflare Access authenticates every request before it reaches the cluster.** It is the
user-facing authentication and authorisation layer, it terminates outside Kubernetes, and it is
the reason there is no Ingress in this repository — the operator fronts the application
themselves.

**The API has no built-in authentication, by design.** `api/app.js` supports an optional
`API_TOKEN` bearer check, and the shipped manifests deliberately leave it unset. There is no
sensible place to put a shared secret in this architecture: anything the browser holds is readable
by anyone who can load the page, so a frontend-held token is not a secret. A token would have to be
injected by nginx from a Kubernetes Secret, which is defence in depth against a lateral attacker,
not user authentication — Access already does the authentication properly, with real identity.

**The obligation this creates:** the origin must not be reachable except through Cloudflare.
Anything that can open a TCP connection to the frontend Service, the node port, or the API pod
gets full read and write access to every stored query, with no credential and no record of who it
was. Bind the tunnel, not a LoadBalancer. Do not port-forward the Service onto a shared network and
leave it running. If you deploy this without an identity-aware proxy in front of it, you have an
unauthenticated database on your network, and the fault is not in the code.

### In-cluster controls

- **NetworkPolicy** (`k8s/api-networkpolicy.yaml`). A ClusterIP Service is reachable by every pod
  in the cluster, so this is the primary in-cluster access control: only pods labelled
  `app=kqlstore` may open TCP 3000 to the API. The API's egress is denied entirely — it talks to
  nothing but its own file on disk, so a compromised dependency has nowhere to send the query
  store. The frontend's egress is limited to the API and kube-dns. The nightly backup Job carries
  its own deny-all policy, both directions, alongside the CronJob.
- **Non-root, read-only root filesystem.** Both Deployments and the backup Job set `runAsNonRoot`,
  drop `ALL` capabilities, set `allowPrivilegeEscalation: false`, apply the `RuntimeDefault`
  seccomp profile and mount the root filesystem read-only. The API runs as UID 1000 and the
  frontend as UID 101. The only writable paths are `emptyDir` scratch mounts and, for the API,
  the PVC at `/data`. CI fails the build if either image reverts to running as root.
- **No ServiceAccount tokens.** Every pod sets `automountServiceAccountToken: false`. Nothing here
  talks to the Kubernetes API, so a mounted token would exist only to hand a cluster credential to
  anyone who achieved code execution in a container.
- **Resource limits** on every workload. The two Node workloads — the API and the backup Job —
  additionally cap `NODE_OPTIONS=--max-old-space-size` below the memory limit so V8 collects
  rather than being OOMKilled.

### Application controls

- **Parameterised SQL, everywhere.** Every statement in `api/routes/` is a `better-sqlite3`
  prepared statement with bound parameters. There is no string-concatenated SQL in the codebase.
- **Server-side input validation** (`api/validate.js`) on every write path, enforcing type, length
  and enumeration bounds independently of the browser: name 200 characters, query 50 000,
  description 1 000, table 200, at most 20 tags of 50 characters, a detection metadata block of
  20 000 characters serialised, at most 1 000 items per import, a maximum page size of 1 000, and
  `category` restricted to a fixed list. The detection block is bounded as a whole rather than
  field by field — the API's job there is to stop it being used as unbounded storage, and the
  vocabulary checks are the SPA's, which is stated as a residual risk below. The body parser is
  capped at 2 MB and nginx's `client_max_body_size` matches, so an oversized body is rejected at
  the proxy rather than parsed. Without these bounds a single request could write enough into the
  PVC to make every subsequent `GET /api/queries` exhaust the pod's memory — while `/api/health`
  still reported `ok`, so the pod would restart straight back into the same failure.
- **A health endpoint that discloses nothing.** `/api/health` is unauthenticated because kubelet
  cannot be given a credential. It used to return the query count, which handed anyone who could
  reach the port the size of the estate's detection library for free; it now reports only status,
  writability and a timestamp.
- **Defensive parsing of stored data.** Two columns hold JSON — `tags` and the v4 `metadata`
  document — and both are parsed inside a guard that coerces the result to the expected shape, so one
  malformed row cannot take down list, get and export together.
- **URL fields are restricted to `http` and `https`.** A query's `references` are parsed with
  `new URL()` and any other scheme is rejected: that field is a link, not a script sink.
- **CORS off by default.** In the shipped topology nginx makes the browser same-origin, so the
  CORS middleware is not mounted at all unless `CORS_ORIGIN` is set explicitly. It previously
  reflected every origin, which let any page on the network read and write the entire store.
- **A strict Content-Security-Policy**, which is only possible because the application bundles
  React, lucide and Tailwind at build time rather than loading them from CDNs, and ships no inline
  `<script>`: `default-src 'self'`, `script-src 'self'` with neither `unsafe-inline` nor
  `unsafe-eval`, `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'`. Alongside it:
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy:
  strict-origin-when-cross-origin`, and same-origin `Cross-Origin-Opener-Policy` and
  `Cross-Origin-Resource-Policy`.

### Supply chain

- Both images pin their base images by digest rather than by tag — `node:24-alpine` and
  `nginx:1.31-alpine` for the frontend, `node:24-alpine` for the API — so two builds of the same
  commit produce the same bytes and "rebuild and compare" remains a usable incident-response step.
  The API declares its base once and both of its stages inherit it, so the two cannot drift apart.
- Dependencies install from committed lockfiles. The frontend build uses `npm ci --ignore-scripts`
  — the largest install-time execution surface in a tree that contains a bundler and a CSS
  compiler, both of which write the JavaScript later served from a trusted origin. The API image
  now does the same: `npm ci --omit=dev --ignore-scripts` in a builder stage. That became possible
  with better-sqlite3 13.x, which ships ABI-independent N-API prebuilds and declares no install
  script — 11.x and 12.x fetched their binary from one, so it had to be trusted by necessity. No
  package in the API tree now executes code at install time, and the deps stage carries no
  compiler or interpreter beyond Node itself. Because nothing would compile a fallback, the build
  asserts that the native binding actually loads before the image is assembled, so a missing or
  wrong-architecture prebuild fails the build rather than the running container. It no longer
  falls back to `npm install` — the previous form swallowed
  the error and resolved versions afresh, which silently produced a different dependency tree than
  the lockfile describes. Treat a lockfile change in a pull request as a supply-chain change.
- GitHub Actions are pinned to full commit SHAs; the workflow's default token is read-only.

### Known residual risk

- **No audit trail.** Schema v4 added an `author` field, but it is self-declared metadata typed
  into a form, not attribution: nothing verifies it and nothing stops the next editor changing it.
  The API logs no history. Access knows who authenticated; the application does not record who
  changed what. Anyone who can reach the app can delete every query, and nothing in the database
  will say who did.
- **Detection metadata is validated in the browser, not at the API.** `api/validate.js` bounds the
  block's serialised size and rejects a non-object; the ATT&CK, severity and entity vocabularies are
  enforced by `src/domain/validate.js`, which a direct caller does not run. The consequence is
  bad data rather than a foothold — a technique ID that matches nothing in the Navigator layer —
  but it is client-side validation being load-bearing for correctness, and it is written down here
  rather than assumed.
- **Stored query text is rendered as markup.** The syntax highlighter is the highest-value target
  in the codebase and has needed fixing before. Treat any escaping change there as
  security-relevant.
- **Backups do not leave the node.** `local-path` is node-local and the backup CronJob is pinned
  to the API's node, so the live store and every retained copy share one disk and one machine.
  That is protection against mistakes, not against hardware. Copying them off the box is left to
  the operator — see the README.
- **`style-src 'unsafe-inline'`.** Required by React's `style` prop, which produces inline style
  attributes. Removing it means moving every dynamic colour into a class.
- **Base image digests are pinned but not automatically updated.** A pinned digest never picks up a
  security patch on its own. Dependabot is configured to rewrite them, but a rebuild is still
  required for the fix to reach a running pod.
- **No secrets management, because there are no secrets.** The application stores none, reads no
  credentials and holds no connection to Microsoft. The sensitive asset is the query store itself
  — your detection logic, which tells a reader precisely what you do and do not detect. Schema v4
  sharpened that: an ATT&CK Navigator layer exported from the store is a map of your coverage *and*
  its gaps on one page, and the `falsePositives` and `tuningNotes` fields describe what you have
  chosen to exclude. Treat backups and exports as sensitive documents, not as data dumps.
