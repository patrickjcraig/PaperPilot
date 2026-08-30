# Document-extractor deployment

This is the production-shaped local/reference deployment for PaperPilot's
embedded-PDF-text boundary. The extractor accepts an already validated raw PDF,
keeps it only on a private ephemeral filesystem, invokes local Poppler tools,
returns a closed bounded extraction response, and deletes the request directory.
It receives no database or object-store credentials and performs no OCR.

## Topology and trust boundaries

- `extractor` runs as the image's unprivileged `node` user with a read-only root
  filesystem, all Linux capabilities dropped, `no-new-privileges`, bounded
  CPU/memory/PIDs/file descriptors, and a `noexec` private tmpfs.
- Its only Compose network is `internal: true`, so the reference has no ordinary
  container egress route. No Poppler updater or other sidecar is required.
- Port 4020 is published to host loopback only by default. Changing the bind
  address is an explicit trust-boundary change, not a production TLS solution.
- The PaperPilot worker authenticates with a dedicated bearer secret. Production
  traffic must use a private exact HTTPS or mTLS ingress; this service does not
  terminate TLS itself.
- `pdftotext` and `pdfinfo` run inside the same constrained container without a
  shell. Their output, time, process tree, page count, text, chunk, and response
  sizes are independently bounded by the service.
- The reference fixes extraction concurrency at one and enables single-use
  mode. After its one admitted POST reaches a terminal response, the main HTTP
  process closes and Compose's `restart: always` starts the service again.
  Health probes do not consume the single admission.

The Compose network is useful reference defense in depth, but production must
also deny egress in the orchestrator/firewall. Host networking, daemon policy,
DNS, and platform-specific control planes are outside Compose's assurance.

Single-use and single-concurrency are only an immediate mitigation. A
production orchestrator must create a disposable container or microVM for each
request, give it distinct mount, PID, and user namespaces, and destroy it after
that request. This reference service and Poppler share a UID inside one
container, and a Compose restart does not make that shared-UID boundary a
complete multi-tenant sandbox. Do not route mutually untrusted tenants through
it without the per-request isolation orchestration above.

## Local start

Docker Compose v2 is required. Docker is unavailable in some PaperPilot
development environments, so the normal service tests use fake Poppler
executables and do not require a daemon.

1. Copy `compose.env.example` to `.env` in this directory.
2. Generate a unique bearer secret and put it in `.env`.
3. Build the extractor, record the resulting immutable image digest, and create
   a canonical provenance manifest naming that digest, the resolved Node base,
   every installed Debian package, the extraction policy, wrapper source, and
   effective Poppler arguments.
4. SHA-256 the exact manifest and set its lowercase 64-character digest as
   `PAPERPILOT_EXTRACTOR_TOOLCHAIN_DIGEST`. Retain the manifest and SBOM with the
   release; this value is evidence, not a random startup token.
5. Start and inspect the service:

   ```text
   docker compose --env-file .env build extractor
   docker compose --env-file .env up -d
   docker compose --env-file .env ps
   docker compose --env-file .env logs --no-log-prefix extractor
   ```

6. From the host, `GET http://127.0.0.1:4020/livez` should return
   `{"status":"live"}`. `GET /readyz` requires
   `Authorization: Bearer <the secret>` and succeeds only when both Poppler
   executables probe successfully and extraction admission is available. Its
   closed response is
   `{"schemaVersion":1,"status":"ready","policyVersion":"...","toolchainDigest":"...","engine":"poppler","engineVersion":"..."}`.
7. Configure the PaperPilot extraction worker with the same bearer secret and
   policy plus the loopback extraction and readiness URLs.

`livez` proves only that the HTTP process runs. Route work only after the
authenticated `readyz` succeeds. The reference container restarts after each
admitted extraction, so a brief unavailable interval between requests is
expected.

## Pinning and build reproducibility

The Dockerfile pins the reviewed Node 24.20.0 trixie-slim multi-platform index,
`poppler-utils` and `libpoppler147` at `25.03.0-5+deb13u4`, `tini` at
`0.19.0-3+b7`, and `ca-certificates` at `20250419`. Build-time `dpkg-query`
checks fail if APT installs different direct versions.

Exact direct-package versions are not a complete reproducible-build mechanism:
APT may resolve unpinned transitive libraries, and ordinary Debian mirrors can
remove superseded binaries. A production build must use an approved immutable
Debian snapshot or internal package repository and retain package filenames,
versions, architectures, and checksums. Refresh pins only through a reviewed
dependency update; never loosen an exact version merely to make a build pass.

## Production release gates

The Compose file is a reference, not a substitute for platform policy. Before
routing production documents, a release must:

1. Put every request in a new disposable container or microVM with distinct
   mount, PID, and user namespaces, destroy it after the request, and verify no
   state or process can survive into the next tenant's request. Treat the
   reference single-use Compose service only as a short-term mitigation.
2. Independently resolve and approve the Node multi-platform index and the
   architecture-specific base manifest, then publish the built extractor under
   an immutable registry digest. Confirm the expected architectures explicitly.
3. Build from an immutable Debian snapshot/internal mirror, verify package
   checksums and signatures, and inventory Poppler plus every transitive library.
4. Generate and retain image and source SBOMs, scan the base, OS packages,
   JavaScript build dependencies, built image, and release configuration, and
   block on the organization's unresolved-vulnerability policy.
5. Compute the toolchain digest from the canonical immutable image/SBOM,
   extraction policy, wrapper, and arguments. Verify the response digest and
   deployed artifact cannot drift independently.
6. Put the extractor behind private exact HTTPS/mTLS ingress. Keep `livez` and
   authenticated `readyz` off the public internet; do not treat the bearer as a
   substitute for transport confidentiality or endpoint identity.
7. Enforce default-deny egress and ingress at the orchestrator/firewall layer,
   and verify denial with a runtime test. The extractor requires no ordinary
   outbound network access.
8. Enforce CPU, memory, PID, file-descriptor, request-size, concurrency, and
   ephemeral-storage quotas at workload and namespace/account boundaries.
9. Alert on sustained not-ready responses, extraction failures, timeouts,
   tmpfs pressure, OOM/restarts, dead-letter growth, and policy/toolchain drift.
10. Rotate the bearer secret without logging it and verify the retired secret
   fails after the bounded worker/service rollout overlap.
11. Exercise multi-page, no-text, malformed, encrypted, resource-exhaustion,
    response-escaping, timeout, disconnect, tool-unavailable, mutation,
    graceful-shutdown, and egress-denial scenarios before release.

Telemetry intentionally contains only bounded safe event fields and counters.
It never contains PDF text or bytes, hashes, paths, headers, bearer values, or
raw Poppler output. Export those JSON lines through the platform pipeline; do
not add an unauthenticated metrics endpoint to this hostile-input service.
