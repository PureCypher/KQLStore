// ---------------------------------------------------------------------------
// Kubernetes manifest validator for CI.
//
// This is a parse-and-wiring check, not a schema check. A cluster is not available in
// CI and `kubectl --dry-run=server` would need one; the failures this guards against
// are cheaper and more common anyway, and share a symptom — the deploy reports success
// and the cluster is not what you think it is:
//
//   * a manifest that no longer parses
//   * a manifest that lost its kind or name in an edit
//   * a manifest that exists in k8s/ but is missing from kustomization.yaml, so
//     `kubectl apply -k` never applies it
//
// The third is the one worth having a job for. An unreferenced NetworkPolicy is
// invisible: every pod stays up, the app works, and the only thing that changed is
// that the API is reachable from the whole cluster again.
//
// Multi-document files are handled explicitly, because YAML's `---` separator means a
// broken second document cannot be found by parsing only the first.
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { parseAllDocuments } from 'yaml';

const MANIFEST_DIR = 'k8s';

// Kinds that legitimately carry no namespace of their own.
const CLUSTER_SCOPED = new Set(['Namespace']);

// A Kustomization is build-time configuration rather than an API object: it has no
// metadata.name, and it sets `namespace` at the top level instead of under metadata.
// Checking it like a resource produces two false positives and teaches people to
// ignore this job.
const KUSTOMIZATION_KIND = 'Kustomization';

const failures = [];
let documentCount = 0;
let embeddedScriptCount = 0;
let kustomization = null;

const files = readdirSync(MANIFEST_DIR)
  .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
  .sort();

if (files.length === 0) {
  console.error(`No manifests found in ${MANIFEST_DIR}/`);
  process.exit(1);
}

// Parse everything before checking anything. The namespace rule below depends on
// whether a Kustomization exists at all, and deciding that mid-loop would make the
// verdict depend on where kustomization.yaml happens to sort alphabetically —
// manifests read before it would be held to a stricter rule than manifests read after.
const parsed = [];

for (const file of files) {
  const path = join(MANIFEST_DIR, file);
  const documents = parseAllDocuments(readFileSync(path, 'utf8'));

  documents.forEach((document, index) => {
    const location = documents.length > 1 ? `${path}[doc ${index}]` : path;

    // The yaml package collects syntax problems rather than throwing, so an empty
    // errors array is the only evidence the document is well-formed.
    for (const error of document.errors) {
      failures.push(`${location}: ${error.message}`);
    }
    if (document.errors.length > 0) return;

    const object = document.toJS();

    // A trailing `---` yields an empty document. Harmless, and not worth counting.
    if (object === null || object === undefined) return;

    if (typeof object !== 'object' || Array.isArray(object)) {
      failures.push(`${location}: top level is not a mapping`);
      return;
    }

    if (object.kind === KUSTOMIZATION_KIND) {
      if (kustomization) {
        failures.push(`${location}: a second ${KUSTOMIZATION_KIND} — kustomize builds only one`);
        return;
      }
      kustomization = { file, object };
      return;
    }

    parsed.push({ location, object });
  });
}

for (const { location, object } of parsed) {
  documentCount += 1;

  if (!object.apiVersion) failures.push(`${location}: missing apiVersion`);
  if (!object.kind) failures.push(`${location}: missing kind`);
  if (!object.metadata?.name) failures.push(`${location}: missing metadata.name`);

  // kustomize sets the namespace for everything it builds, so a manifest is only
  // required to declare its own when it can also be applied directly with -f.
  if (
    !kustomization &&
    object.kind &&
    !CLUSTER_SCOPED.has(object.kind) &&
    !object.metadata?.namespace
  ) {
    failures.push(`${location}: ${object.kind}/${object.metadata?.name} has no metadata.namespace`);
  }
}

// -------------------------------------------------------------------------
// Embedded scripts: `command: [node, -e, <source>]` must at least parse.
//
// The backup CronJobs carry their logic inline rather than baking a second image, which
// is the right trade for this repo but moves a whole class of error past every check it
// has. A YAML block scalar holding broken JavaScript is still valid YAML: it parses, it
// applies, the CronJob is created, and nothing complains until the container starts at
// 03:17 and exits non-zero. This was not hypothetical — an edit once put a `#` comment
// inside one of these blocks, which is not JavaScript, and only a hand-run `node --check`
// caught it before it shipped.
//
// Compiling with vm.Script parses without executing, so a script that would delete or
// upload something does neither here. It compiles as CommonJS, matching how `node -e`
// runs it: `require` is fine, top-level `await` is not, and the scripts wrap async work
// in an IIFE for exactly that reason.
// -------------------------------------------------------------------------
function checkEmbeddedScripts(node, location, path = []) {
  if (Array.isArray(node)) {
    node.forEach((item, index) => checkEmbeddedScripts(item, location, [...path, index]));
    return;
  }
  if (!node || typeof node !== 'object') return;

  const command = node.command;
  if (
    Array.isArray(command) &&
    command.length >= 3 &&
    typeof command[0] === 'string' &&
    /(^|\/)node$/.test(command[0]) &&
    command[1] === '-e' &&
    typeof command[2] === 'string'
  ) {
    const where = node.name ? `container "${node.name}"` : path.join('.');
    embeddedScriptCount += 1;
    try {
      new Script(command[2], { filename: `${location} ${where}` });
    } catch (error) {
      failures.push(
        `${location}: ${where} has a "node -e" script that does not parse — ` +
          `${error.message}. It would apply cleanly and fail at container start.`,
      );
    }
  }

  for (const [key, value] of Object.entries(node)) {
    checkEmbeddedScripts(value, location, [...path, key]);
  }
}

for (const { location, object } of parsed) {
  checkEmbeddedScripts(object, location);
}

// -------------------------------------------------------------------------
// Wiring: kustomization.yaml must reference every manifest, and only manifests
// that exist. Both directions matter — a stale entry breaks the build loudly, a
// missing entry drops a resource silently.
// -------------------------------------------------------------------------
if (kustomization) {
  const listed = kustomization.object.resources ?? [];
  if (!Array.isArray(listed)) {
    failures.push(`${MANIFEST_DIR}/${kustomization.file}: "resources" is not a list`);
  } else {
    for (const resource of listed) {
      if (!existsSync(join(MANIFEST_DIR, resource))) {
        failures.push(`${MANIFEST_DIR}/${kustomization.file}: resource "${resource}" does not exist`);
      }
    }

    const referenced = new Set(listed);
    for (const file of files) {
      if (file === kustomization.file) continue;
      if (!referenced.has(file)) {
        failures.push(
          `${MANIFEST_DIR}/${file} is not listed in ${kustomization.file} — ` +
            'kubectl apply -k would silently skip it',
        );
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s) found:\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

const wiring = kustomization ? `, all wired into ${kustomization.file}` : '';
const scripts = embeddedScriptCount
  ? `, ${embeddedScriptCount} embedded script(s) parse`
  : '';
console.log(`OK — ${documentCount} resource(s) across ${files.length} manifest(s)${wiring}${scripts}`);
