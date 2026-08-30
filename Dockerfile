# syntax=docker/dockerfile:1.7

# Keep the application and its two TypeScript workers on the same reviewed
# Node base as the existing validator/extractor images. Refresh this digest as
# one deliberate dependency change; never replace it with a moving tag during
# a release build.
ARG NODE_IMAGE=node:24.20.0-trixie-slim@sha256:50c3b2f6988dfc307b86e5301d69611af31f4789bdf232863b07d3b02fe55ae0

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /build

# Prisma's postinstall generator reads the datasource URL but does not connect
# to it. This build-only loopback value keeps credentials out of image layers.
ENV DATABASE_URL=postgresql://paperpilot_runtime:build-only@127.0.0.1:5432/paperpilot_build?sslmode=disable

COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci

FROM dependencies AS build

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    BETTER_AUTH_URL=https://build.paperpilot.invalid \
    BETTER_AUTH_SECRET=build-only-secret-with-more-than-thirty-two-characters \
    PAPERPILOT_RELEASE_ID=container-build \
    PAPERPILOT_ALLOW_LOCAL_PRISMA_DEV=0 \
    PAPERPILOT_ALLOW_INSECURE_ORIGIN=0

COPY next.config.ts next-env.d.ts tsconfig.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS runtime

ARG DEBIAN_FRONTEND=noninteractive
ARG CA_CERTIFICATES_DEBIAN_VERSION=20250419
ARG TINI_DEBIAN_VERSION=0.19.0-3+b7
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      "ca-certificates=${CA_CERTIFICATES_DEBIAN_VERSION}" \
      "tini=${TINI_DEBIAN_VERSION}" \
    && test "$(dpkg-query --show ca-certificates | cut --fields=2)" = "${CA_CERTIFICATES_DEBIAN_VERSION}" \
    && test "$(dpkg-query --show tini | cut --fields=2)" = "${TINI_DEBIAN_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

WORKDIR /srv/paperpilot

# Retain the reviewed dependency tree in this first single-image deployment:
# the supervised workers intentionally execute their TypeScript entry points
# with the repository's pinned tsx binary. A later worker compilation split is
# an image-hardening change, not a prerequisite for the Gate 0 topology.
COPY --from=dependencies --chown=node:node /build/node_modules ./node_modules
COPY --from=build --chown=node:node /build/.next ./.next
COPY --from=build --chown=node:node /build/src ./src
COPY --from=build --chown=node:node /build/prisma ./prisma
COPY --from=build --chown=node:node /build/prisma.config.ts ./prisma.config.ts
COPY --chown=node:node package.json package-lock.json next.config.ts next-env.d.ts tsconfig.json ./
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node deploy/postgres ./deploy/postgres

USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/livez',{signal:AbortSignal.timeout(2000)}).then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "run", "start"]
