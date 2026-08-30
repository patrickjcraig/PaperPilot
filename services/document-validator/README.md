# PaperPilot document validator

This package is the isolated HTTP boundary that PaperPilot's validation worker
calls. It is deliberately dependency-free at runtime and compiles with
TypeScript before starting. The validator is stateless and idempotent: retries
may upload the same immutable bytes more than once, and the service never uses a
request as authorization for any other request.

## Wire contract

The default endpoint is `POST /v1/validate-pdf`. It requires exactly one of each
of these headers:

- `Authorization: Bearer <secret>`
- `Accept: application/json`
- `Cache-Control: no-store`
- `Content-Type: application/pdf`
- canonical positive `Content-Length`
- lowercase `X-PaperPilot-Content-SHA256`
- bounded `X-PaperPilot-Storage-Version`
- exact `X-PaperPilot-Validation-Policy`

Transfer/content encoding, trailers, `Expect`, duplicate security headers, query
strings, and unknown `X-PaperPilot-*` headers are rejected. The request body is
streamed once into a unique mode-0600 file under a mode-0700 request directory,
hashed while it is written, inspected only after its declared length and digest
match, switched to mode 0400 on POSIX, re-hashed after both runners stop, and
unlinked before the attestation is returned.

Successful responses are compact `application/json` with no charset and use the
exact closed v1 schema consumed by `src/server/documents/validation-contract.ts`.
The service intentionally adds no signature fields or response-signature
protocol: PaperPilot v1 authenticates the caller with the bearer secret and the
service with its exact private HTTPS endpoint. `signatureVersion` and
`signaturePublishedAt` describe the ClamAV definition database, not an
attestation HMAC.

`GET /livez` is unauthenticated process liveness. `GET /readyz` requires the
same bearer secret and checks both configured tool wrappers. Clam readiness also
requires definition publication metadata inside the configured freshness and
future-clock windows. Readiness fails during shutdown and whenever validation
admission is at capacity. Other methods fail closed.
Health requests accept no body (an explicit canonical `Content-Length: 0` is
allowed); encoded, chunked, or non-empty health bodies are rejected and closed.

## Tool boundary

The HTTP process executes bundled wrapper scripts as subprocesses and accepts
only their bounded, closed JSON protocols. The wrappers then invoke stock tools
without a shell. Command output, temporary paths, request hashes, authorization,
and raw errors are never logged.

The ClamAV wrapper defaults to `clamdscan --no-summary --stream`, accepts exit 0 as clean,
exit 1 as infected, and treats exit 2/other outcomes as an operational failure.
It obtains the engine version, definition version, and definition publication
time from `--version`. When a local `clamd` socket is not provided, set
`PAPERPILOT_VALIDATOR_CLAM_COMMAND=clamscan` and explicitly set
`PAPERPILOT_VALIDATOR_CLAM_ARGS_JSON=["--no-summary"]` because `--stream` is a
`clamdscan` transport option. Command and argument arrays are injectable for
deployment and tests.
Clam's zone-less ctime definition timestamp is interpreted as UTC, and the
wrapper/tool processes run with `TZ=UTC`; a separately operated daemon must use
the same UTC convention.

The qpdf wrapper performs separate bounded `--check`, `--show-npages`,
`--list-attachments`, and `--json --json-key=qpdf` invocations. It rejects qpdf
warnings, encryption, attachments, unsupported versions, output/time limits,
and unverifiable metadata. Object count is the number of `obj:* R` keys in
qpdf's bounded JSON object dictionary. Revision count has one explicit,
conservative meaning: after qpdf reports a warning-free valid file, the wrapper
counts physical literal `startxref` and `%%EOF` byte tokens and requires the
counts to match. Tokens inside streams can over-count this deliberately physical
metric; deployments that prohibit that ambiguity can lower the bounded revision
policy limit (for example, to one).

The configured `PAPERPILOT_VALIDATOR_TOOLCHAIN_DIGEST` is a deployment-supplied
lowercase SHA-256. Its preimage should be the immutable validator image/SBOM,
wrapper source, policy configuration, and scanner/parser binaries. Do not put
the changing Clam definition database in that digest; its independent version
and publication time are already attested.

## Configuration

Required:

- `PAPERPILOT_VALIDATOR_BEARER_SECRET` (or the worker-compatible
  `PAPERPILOT_VALIDATION_SERVICE_BEARER_SECRET`), 32-4096 visible ASCII bytes
- `PAPERPILOT_VALIDATOR_POLICY_VERSION` (or
  `PAPERPILOT_VALIDATION_POLICY_VERSION`)
- `PAPERPILOT_VALIDATOR_TOOLCHAIN_DIGEST`, 64 lowercase hex characters

Important bounded options include:

- `PAPERPILOT_VALIDATOR_HOST` / `PAPERPILOT_VALIDATOR_PORT` / route
- request byte, header, idle, absolute, validation, concurrency, and PDF limits
- `PAPERPILOT_VALIDATOR_TEMP_ROOT` (canonical, non-symlink, private directory)
- Clam/qpdf command, JSON argument arrays, command deadlines, and qpdf metadata
  output ceiling (metadata ceiling times admission concurrency may not exceed
  the compiled 64 MiB aggregate raw-output budget)
- `PAPERPILOT_VALIDATOR_SIGNATURE_READINESS_MAX_AGE_MS` (23h default, leaving
  margin under the worker's 24h attestation ceiling)
- `PAPERPILOT_VALIDATOR_SIGNATURE_FUTURE_CLOCK_SKEW_MS` (5m default)

Default body-absolute and validation ceilings are 5s and 20s respectively, so
the service retains approximately 5s of response/network margin inside the
worker's default 30s end-to-end deadline. If the worker deadline changes, keep
the sum of these two service ceilings safely below it.

Configuration fails closed by default on Windows because Node's POSIX-style
modes do not establish or verify a private DACL. Automated tests and deliberate
local development may acknowledge that limitation with the exact value
`PAPERPILOT_VALIDATOR_ALLOW_INSECURE_WINDOWS_DEVELOPMENT=1`; the override is
rejected when `NODE_ENV=production` and must never be used with real hostile
documents. Production uses the Linux container/runtime boundary. The temp root
must be instance-exclusive and ephemeral because an abrupt host/process crash
cannot run application cleanup.

## Structured telemetry

The JSON-line logger is the bounded metrics surface. Aggregate counters and
latencies from fixed events: `validation_completed` (verdict, malware/PDF
verdict, size, duration), `request_rejected` (safe code/status/duration),
`request_failed`, `service_listening`, and `service_stopped`. The logger copies
only an explicit allowlist of scalar fields; it cannot emit bearer values,
headers, SHA-256 content bindings, temporary paths, raw tool output, or error
objects. No unauthenticated metrics endpoint is exposed from the hostile-input
process.

Run `npm install`, `npm test`, then `npm start`. Production still needs an
external workload sandbox: private network ingress, exact HTTPS routing, no
outbound network, read-only image, bounded memory/CPU/PIDs, current offline
definitions, and an ephemeral private temp volume. Application-level timeouts
and process-tree termination are defense in depth, not substitutes for those
container/runtime controls.
