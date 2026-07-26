<!--
Keep the sections that apply and delete the rest. An honest "not tested" is more
useful than a ticked box that was not earned — the point of the test plan is to tell
the reviewer where to look hardest, not to be complete.
-->

## What this changes

<!-- The behaviour that differs after this merges, not a restatement of the diff. -->

## Why

<!-- The problem being solved. Link the issue if there is one. -->

## Test plan

CI covers lint, the API test suite, both image builds and manifest parsing. This
section is for what CI cannot reach.

**Always**

- [ ] `eslint .` passes with no new suppressions (a new `eslint-disable` is a change
      that needs justifying in this PR, not a way to get green)
- [ ] Both images build: `docker build -t kqlstore:test .` and
      `docker build -t kqlstore-api:test ./api`

**If the SPA changed**

- [ ] Typed into the search box past the debounce without losing focus
- [ ] Opened the query editor, typed, switched category, and confirmed the in-progress
      edit survived — this is where re-created components have bitten before
- [ ] Keyboard shortcuts still work, including from inside a text field
- [ ] Checked the browser console for errors and React warnings during the above

**If the API or the schema changed**

- [ ] Ran against a database created by the *previous* version, not a fresh one —
      a migration that only works on an empty table is the failure that reaches the PVC
- [ ] Create, edit, favourite, delete and usage-count increment all persist across a
      pod restart
- [ ] Rejected payloads still return 400 with a useful message rather than a 500
- [ ] `/api/health` still responds while the store holds a realistic number of queries

**If import/export changed**

- [ ] Exported, re-imported into an empty store, and diffed the result
- [ ] Imported a file from an older schema version
- [ ] Imported deliberately malformed JSON and confirmed it fails cleanly

**If Kubernetes manifests changed**

- [ ] `kubectl apply -k k8s/ --dry-run=server` against the real cluster — `-k`, not
      `-f`: `-f` submits `kustomization.yaml` itself as a resource and applies the rest
      in lexical order, ahead of the namespace they need (see the README)
- [ ] Confirmed the API is still reachable only from the frontend pods — the
      NetworkPolicy is the access control, since authentication is handled at the
      Cloudflare Access edge and the API has none of its own

## Deployment notes

<!--
Anything that has to happen around the merge rather than in it: a manifest to apply,
a migration that runs on first start, an image that must be rebuilt before rollout.
Write "none" if there is none.
-->

## Risk

<!-- What breaks if this is wrong, and how it would be rolled back. -->
