# syntax=docker/dockerfile:1.7

# Immutable multi-platform index reviewed for this reference release. Re-resolve,
# scan, and deliberately update it together with the Debian package pins.
ARG NODE_IMAGE=node:24.20.0-trixie-slim@sha256:50c3b2f6988dfc307b86e5301d69611af31f4789bdf232863b07d3b02fe55ae0

FROM ${NODE_IMAGE} AS build
WORKDIR /build

COPY services/document-extractor/package.json services/document-extractor/package-lock.json ./
RUN npm ci --ignore-scripts

COPY services/document-extractor/tsconfig.json ./tsconfig.json
COPY services/document-extractor/src ./src
COPY services/document-extractor/wrappers ./wrappers
RUN npm run build

FROM ${NODE_IMAGE} AS runtime

ARG DEBIAN_FRONTEND=noninteractive
ARG CA_CERTIFICATES_DEBIAN_VERSION=20250419
ARG POPPLER_DEBIAN_VERSION=25.03.0-5+deb13u4
ARG TINI_DEBIAN_VERSION=0.19.0-3+b7
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      "ca-certificates=${CA_CERTIFICATES_DEBIAN_VERSION}" \
      "libpoppler147=${POPPLER_DEBIAN_VERSION}" \
      "poppler-utils=${POPPLER_DEBIAN_VERSION}" \
      "tini=${TINI_DEBIAN_VERSION}" \
    && test "$(dpkg-query --show ca-certificates | cut --fields=2)" = "${CA_CERTIFICATES_DEBIAN_VERSION}" \
    && test "$(dpkg-query --show libpoppler147 | cut --fields=2)" = "${POPPLER_DEBIAN_VERSION}" \
    && test "$(dpkg-query --show poppler-utils | cut --fields=2)" = "${POPPLER_DEBIAN_VERSION}" \
    && test "$(dpkg-query --show tini | cut --fields=2)" = "${TINI_DEBIAN_VERSION}" \
    && command -v pdfinfo >/dev/null \
    && command -v pdftotext >/dev/null \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PAPERPILOT_EXTRACTOR_HOST=0.0.0.0 \
    PAPERPILOT_EXTRACTOR_PORT=4020 \
    PAPERPILOT_EXTRACTOR_TEMP_ROOT=/tmp/paperpilot-extractor

WORKDIR /srv/paperpilot-extractor
COPY --from=build --chown=node:node /build/dist ./dist

USER node
EXPOSE 4020

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const p=process.env.PAPERPILOT_EXTRACTOR_PORT||'4020';fetch('http://127.0.0.1:'+p+'/livez',{signal:AbortSignal.timeout(2000)}).then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/src/main.js"]
