# Document-validator deployment

This stack is the runnable local/reference topology for PaperPilot's hostile-PDF
boundary. The validator accepts bytes, writes them only to an ephemeral private
filesystem, streams them to a separate Clam daemon, invokes qpdf locally, emits
a closed attestation, and deletes the request directory. It never receives a
database or object-store credential.

## Topology and trust boundaries

- `validator` runs as the image's unprivileged `node` user with a read-only root
  filesystem, all Linux capabilities dropped, a PID/file-descriptor ceiling,
  and a bounded `noexec` tmpfs.
- `validator` is attached only to the internal `scan` network. It has no normal
  internet route. Its port is bound to host loopback by default.
- `clamav` is the only workload attached to both `scan` and
  `signature_updates`. It persists `/var/lib/clamav` so FreshClam can update
  definitions without redownloading the full database at every start.
- TCP 3310 is exposed only inside `scan`; it is never published. Clam's TCP
  protocol is not an authenticated or encrypted public service.
- The application worker authenticates to the validator with a dedicated
  bearer secret. Production traffic must use a private HTTPS proxy or service
  mesh with an exact endpoint; this service does not terminate TLS itself.

The official ClamAV guidance recommends a persistent volume with a `_base`
image and warns that the engine needs substantial memory. The reference stack
therefore reserves 4 GiB for Clam. The first start can remain unhealthy while
the initial signature database downloads.

## Local start

Docker Compose v2 is required. Docker is not available in every PaperPilot
development environment, so this repository's normal test suite validates the
wire protocol without requiring a container daemon.

1. Copy `compose.env.example` to `.env` in this directory.
2. Generate a unique bearer secret and put it in `.env`.
3. Build the validator image, resolve both resulting images to immutable image
   IDs/digests, and create a small canonical provenance manifest that also
   names the policy and the scanner/parser configuration.
4. SHA-256 that exact manifest and set its lowercase 64-character digest as
   `PAPERPILOT_VALIDATOR_TOOLCHAIN_DIGEST`. Retain the manifest and generated
   SBOM with the release; the value is evidence, not a random startup token.
5. Start and inspect the stack:

   ```text
   docker compose --env-file .env build validator
   docker compose --env-file .env up -d
   docker compose --env-file .env ps
   docker compose --env-file .env logs --no-log-prefix validator
   ```

6. From the host, `GET http://127.0.0.1:4010/livez` should return
   `{"status":"live"}`. `GET /readyz` requires
   `Authorization: Bearer <the secret>` and becomes ready only when qpdf,
   ClamAV, signature freshness, and admission capacity all pass.
7. Configure `npm run worker:validation` with the same bearer secret and policy,
   plus the loopback validation and readiness URLs shown in the root
   `.env.example`.

`livez` proves only that the HTTP process runs. Route jobs only when the
authenticated `readyz` succeeds. During a durable Clam outage or stale
definitions, the PaperPilot worker probes readiness before claiming a job, so
the outage does not consume validation attempts.

## Production release gates

The Compose file is a reference, not a substitute for platform controls. A
release must additionally:

1. Independently resolve and approve the Node and Clam tag-plus-digest
   references, and publish the built validator under an immutable registry
   digest; record qpdf, clamdscan, clamd, and definition versions in the
   release inventory. Never remove a digest just to pick up a newer tag.
2. Build from a reviewed package snapshot or otherwise lock OS packages. A
   moving Debian package repository is not a reproducible production build.
3. Generate and retain an SBOM and vulnerability scan, then compute the
   attested toolchain digest from the immutable artifacts and policy.
4. Put the validator behind private HTTPS/mTLS ingress. Do not publish 3310 or
   expose validator liveness/readiness to the public internet.
5. Enforce validator egress denial at the orchestrator/firewall layer. In
   Kubernetes, run Clam and validator in separate pods because NetworkPolicy is
   pod-scoped; a sidecar would inherit the updater's network reachability.
6. Enforce CPU, memory, PID, file-descriptor, request-size, concurrency, and
   ephemeral-storage quotas at both workload and namespace/account boundaries.
7. Alert on stale definitions, sustained not-ready responses, failed scans,
   dead-letter growth, tmpfs pressure, OOM/restarts, and policy/toolchain drift.
8. Rotate the bearer secret without logging it, keep old/new worker and service
   rollout overlap bounded, and confirm the old secret fails after rollout.
9. Exercise clean, infected, malformed, resource-exhaustion, timeout,
   disconnect, Clam outage, stale-signature, and graceful-shutdown scenarios
   before routing production jobs.

Application logs deliberately contain only bounded event names, safe status
codes, verdict classes, sizes, and durations. They never contain PDF bytes,
content hashes, temporary paths, request headers, bearer values, or raw scanner
output. Aggregate those JSON-line events in the platform telemetry pipeline;
do not add an unauthenticated metrics endpoint to this hostile-input service.
