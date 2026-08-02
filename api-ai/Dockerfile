# syntax=docker/dockerfile:1
#
# kqlstore-ai: a stateless chat proxy to Ollama Cloud. No database, no volume,
# no session state — its entire contract is accept a request from nginx, redact,
# forward, return. That is what makes the broad egress in k8s/ai-networkpolicy.yaml
# acceptable: what it can reach is wide, so what it can reveal must be narrow.
#
# The base digest is the same node:24-alpine both existing images pin, so the
# supply chain stays one image line. express is the only runtime dependency;
# the HTTP client is Node's built-in fetch and the repo takes the same line here
# it takes everywhere — a dependency is a dependency a contributor has to trust.
#
# --ignore-scripts matches the other images' installs. express declares no
# install scripts, so this is not a concession, but if a future dependency needs
# one, the image build is where that should break (see the API Dockerfile's note
# on the same choice).
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

WORKDIR /app

# npm ci, never npm install: it fails when package.json and package-lock.json
# have drifted, which is worth catching on its own.
COPY api-ai/package.json api-ai/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY api-ai/ ./
# One definition of "sensitive", shared with the backup job. Copied rather than
# duplicated: two drifting rule tables is exactly the failure this avoids. The
# build context is the repository root (see .github/workflows/ci.yml).
COPY api/lib/redact.js ./lib/redact.js

USER node
EXPOSE 3001
CMD ["node", "server.js"]
