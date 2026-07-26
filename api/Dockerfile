# syntax=docker/dockerfile:1
#
# Two stages, so npm's install step has the tools it needs without them reaching the
# runtime image.
#
# better-sqlite3 is a native addon and how it obtains its binary differs by version:
#
#   11.x, 12.x  declare an install script (`prebuild-install || node-gyp rebuild`) that
#               DOWNLOADS a prebuilt binary. Scripts must run, so --ignore-scripts breaks
#               them outright.
#   13.x        declares no install script at all, but ships a binding.gyp, so npm falls
#               back to its implicit default and runs `node-gyp rebuild`. That needs
#               python3 and fails without it — even though a perfectly good
#               prebuilds/linuxmusl-x64.node is already sitting in the package and is what
#               actually gets loaded at require time.
#
# A builder stage carrying python3, make and g++ is the one arrangement that satisfies both:
# scripts run for 11.x/12.x, and node-gyp completes for 13.x.
#
# On Node 24 the toolchain is not merely insurance — it is load-bearing. better-sqlite3
# 11.x publishes prebuilds only up to the Node 22 ABI (127), so on Node 24 (ABI 137)
# prebuild-install finds nothing and node-gyp compiles the addon for real: measured, a
# clean install leaves 3 object files and sqlite3.a in build/Release. That build succeeds
# and costs nothing noticeable (npm ci: 113s on Node 22 with a prebuild, 109s on Node 24
# compiling), but it does mean g++ cannot be removed from the deps stage while the API is
# on better-sqlite3 11.x. Moving to 13.x removes the compile entirely, because 13.x ships
# N-API prebuilds that are ABI-independent — see the pending better-sqlite3 bump.
#
# Do NOT "simplify" this to a single stage with --ignore-scripts. It is tempting, and it
# does work for 13.x, but measured on this project it produces a 301 MB image against
# 273 MB here, because npm's cache stays in the layer. It would also break 11.x and 12.x.
#
# Base image is declared once, below, and both stages inherit it. Two independent digest
# literals would let the stages drift, and node_modules is musl- and ABI-specific: a
# mismatch builds green and dies at container start with "Exec format error".
#
# Node 24 is the Active LTS line (LTS since 2025-10-28, security support to 2028-04-30).
# Do not let this drift onto whatever tag is newest: Node 26 is Current, not LTS until
# 2026-10-28, and better-sqlite3 11.x does not compile against its V8 headers at all —
# Node 26 removed v8::Object::GetPrototype, v8::Context::GetIsolate and
# PropertyCallbackInfo::This, which 11.x still calls.
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS base

FROM base AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++

# npm ci, never npm install. The previous form was
#   npm ci --omit=dev 2>/dev/null || npm install --omit=dev
# which swallowed the error and fell back to a resolver that ignores the lockfile — so a
# lockfile that failed to install produced a DIFFERENT dependency tree instead of a failed
# build, silently defeating the reason the lockfile is committed at all.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base
WORKDIR /app

# Only the resolved tree crosses the boundary; python3, make and g++ stay behind.
# api/.dockerignore must continue to exclude node_modules, or the COPY below would
# overwrite this with whatever happens to be on the build host.
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN mkdir -p /data && chown 1000:1000 /data

USER 1000

EXPOSE 3000

VOLUME ["/data"]

CMD ["node", "server.js"]
