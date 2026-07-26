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
# A builder stage carrying python3 and make is the one arrangement that satisfies both:
# scripts run for 11.x/12.x, and node-gyp's configure step completes for 13.x. Nothing is
# genuinely compiled by either — verified: after a clean install the build/ tree contains
# only .stamp files and zero object files. g++ is kept purely as insurance against a
# future version that does compile for real; it is not exercised today.
#
# Do NOT "simplify" this to a single stage with --ignore-scripts. It is tempting, and it
# does work for 13.x, but measured on this project it produces a 78.7 MB image against
# 59.3 MB here, because npm's cache stays in the layer. It would also break 11.x and 12.x.
#
# Base image is declared once, below, and both stages inherit it. Two independent digest
# literals would let the stages drift, and node_modules is musl- and ABI-specific: a
# mismatch builds green and dies at container start with "Exec format error".
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS base

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
