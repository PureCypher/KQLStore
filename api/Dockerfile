# syntax=docker/dockerfile:1
#
# Two stages, so npm's working state — its cache above all — resolves the dependency tree
# without any of it reaching the runtime image. It no longer exists to hide a compiler:
# there is not one to hide any more, which is the point of the note below.
#
# better-sqlite3 is a native addon and how it obtains its binary differs by version:
#
#   11.x, 12.x  declare an install script (`prebuild-install || node-gyp rebuild`) that
#               DOWNLOADS an ABI-specific prebuilt binary. Scripts must run, so
#               --ignore-scripts breaks them outright.
#   13.x        declares no install script at all. It ships ABI-independent N-API
#               prebuilds in the package (prebuilds/linuxmusl-x64.node and friends), which
#               is what gets loaded at require time. It does still carry a binding.gyp, so
#               without --ignore-scripts npm falls back to its implicit default and runs
#               `node-gyp rebuild` — which needs python3 and fails without it, pointlessly,
#               since the binary it would build is already sitting in the package.
#
# The API is on 13.x, so the install needs neither a toolchain nor an install script. The
# prebuild it ships is N-API, which is ABI-independent — the same binary loads on Node 20,
# 24 and 26 alike, so nothing has to be compiled or downloaded at install time.
#
# --ignore-scripts is therefore possible here as well as in the frontend build, and it is
# worth having: it is the largest install-time execution surface, and the API image is what
# holds the database. Measured on this project, it also turns a 96s deps stage into 5s,
# because npm's implicit node-gyp fallback (triggered by binding.gyp, NOT by any script
# better-sqlite3 declares) no longer runs at all.
#
# The risk --ignore-scripts introduces is real but is closed below: with no script and no
# toolchain, a platform with no matching prebuild would install "successfully" and then
# fail at container start with a module-not-found. The `node -e` line in the deps stage
# turns that into a failed build instead. Verified by deleting prebuilds/ and confirming
# the build stops.
#
# Do NOT "simplify" this to a single stage. Measured on the same lockfile it produces a
# 301 MB image against 275 MB here, because npm's cache stays in the layer.
#
# If better-sqlite3 is ever downgraded to 11.x or 12.x, this arrangement breaks: those
# versions DO declare an install script (`prebuild-install || node-gyp rebuild`) that
# downloads the binary, and --ignore-scripts stops it running. They would need the
# toolchain and the scripts back.
#
# Base image is declared once, below, and both stages inherit it. Two independent digest
# literals would let the stages drift, and node_modules is musl- and ABI-specific: a
# mismatch builds green and dies at container start with "Exec format error".
#
# Node 24 is the Active LTS line (LTS since 2025-10-28, security support to 2028-04-30).
# Do not let this drift onto whatever tag is newest: Node 26 is Current and does not become
# LTS until 2026-10-28. better-sqlite3 13.x does run on Node 26 — that was verified, and it
# is no longer the constraint it was under 11.x, which could not compile against Node 26's
# V8 headers. The remaining reason to stay is the release line, not the dependency.
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS base

FROM base AS deps
WORKDIR /app

# npm ci, never npm install. The previous form was
#   npm ci --omit=dev 2>/dev/null || npm install --omit=dev
# which swallowed the error and fell back to a resolver that ignores the lockfile — so a
# lockfile that failed to install produced a DIFFERENT dependency tree instead of a failed
# build, silently defeating the reason the lockfile is committed at all.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Prove the native binding actually loads before the image is assembled. --ignore-scripts
# means nothing would compile a fallback, so a missing or wrong-architecture prebuild would
# otherwise sail through the build and only surface when the container starts — as a crash
# loop on the machine holding the database. This turns it into a failed build.
RUN node -e "const D=require('better-sqlite3'); const d=new D(':memory:'); d.exec('create table t(a)'); d.prepare('insert into t values (?)').run('ok'); if (d.prepare('select a from t').get().a !== 'ok') throw new Error('better-sqlite3 round-trip failed'); console.log('better-sqlite3 binding OK, sqlite ' + d.prepare('select sqlite_version() v').get().v)"

FROM base
WORKDIR /app

# Only the resolved tree crosses the boundary, and it is already proven to load.
# api/.dockerignore must continue to exclude node_modules, or the COPY below would
# overwrite this with whatever happens to be on the build host.
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN mkdir -p /data && chown 1000:1000 /data

USER 1000

EXPOSE 3000

VOLUME ["/data"]

CMD ["node", "server.js"]
