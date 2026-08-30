# syntax=docker/dockerfile:1.7

# The reference is an immutable multi-platform index captured for this release.
# Re-resolve, scan, and deliberately update it during a dependency refresh.
ARG NODE_IMAGE=node:24.20.0-trixie-slim@sha256:50c3b2f6988dfc307b86e5301d69611af31f4789bdf232863b07d3b02fe55ae0

FROM ${NODE_IMAGE} AS build
WORKDIR /build

COPY services/document-validator/package.json services/document-validator/package-lock.json ./
RUN npm ci --ignore-scripts

COPY services/document-validator/tsconfig.json ./tsconfig.json
COPY services/document-validator/src ./src
COPY services/document-validator/wrappers ./wrappers
RUN npm run build

FROM ${NODE_IMAGE} AS runtime

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      ca-certificates \
      clamdscan \
      qpdf \
      tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PAPERPILOT_VALIDATOR_HOST=0.0.0.0 \
    PAPERPILOT_VALIDATOR_PORT=4010 \
    PAPERPILOT_VALIDATOR_TEMP_ROOT=/tmp/paperpilot-validator

WORKDIR /srv/paperpilot-validator
COPY --from=build --chown=node:node /build/dist ./dist

USER node
EXPOSE 4010

HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "const p=process.env.PAPERPILOT_VALIDATOR_PORT||'4010';fetch('http://127.0.0.1:'+p+'/livez',{signal:AbortSignal.timeout(2000)}).then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/src/main.js"]
