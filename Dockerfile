# syntax=docker/dockerfile:1
#
# Base images are pinned by digest, not by tag. A floating tag means two builds of the same
# commit can produce different bytes, so "rebuild and compare" stops being a usable incident
# response step. Update these deliberately.
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS build
WORKDIR /build

# Dependencies come from the committed lockfile via `npm ci`, never a bare `npm install`
# which resolves to whatever the registry serves at build time. --ignore-scripts removes the
# largest install-time execution surface: this tree includes a bundler and a CSS compiler,
# both of which write the JavaScript that is then served from a trusted origin.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tailwind.config.js ./
COPY index.html ./
COPY src ./src
RUN npm run build

FROM nginx:1.31-alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752
COPY nginx.conf /etc/nginx/nginx.conf
COPY index.html /usr/share/nginx/html/
COPY --from=build /build/dist/app.js /build/dist/app.css /usr/share/nginx/html/
# tests.html is deliberately NOT shipped: a test harness on the production surface can touch
# the same origin's storage, and it served no purpose here because it never ran.
USER 101
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
