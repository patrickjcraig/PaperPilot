# PaperPilot document extractor

This package is the isolated, runtime-dependency-free HTTP boundary that turns
an already validated PDF into bounded embedded text. It does not perform OCR,
infer sections or figures, calculate character offsets, or mutate PaperPilot
records. Requests are stateless and idempotent.

## Wire request

The default endpoint is `POST /v1/extract-pdf`. It accepts the raw PDF body and
requires exactly one of each header:

- `Authorization: Bearer <secret>`
- `Accept: application/json`
- `Cache-Control: no-store`
- `Content-Type: application/pdf`
- canonical positive `Content-Length`
- lowercase `X-PaperPilot-Content-SHA256`
- bounded `X-PaperPilot-Storage-Version`
- exact `X-PaperPilot-Extraction-Policy`

The service rejects transfer/content encodings, trailers, `Expect`, duplicate
security headers, query strings, and unknown `X-PaperPilot-*` headers. It
streams the body into a unique private file, hashes it during the write,
changes it to mode 0400 on POSIX, runs extraction, re-hashes it after every tool
has stopped, and deletes it before returning success. Every error response
closes its connection so unread bytes cannot become state for another request.

`GET /livez` is public process liveness. `GET /readyz` requires the bearer
secret and probes both configured Poppler tools. Health requests accept no body;
only absent `Content-Length` or literal `Content-Length: 0` is allowed.
Readiness fails during shutdown and while extraction admission is full.
Successful readiness is HTTP 200 with literal `Content-Type: application/json`
and this exact closed identity (with deployment values substituted):

```json
{"schemaVersion":1,"status":"ready","policyVersion":"paperpilot-text-extraction-v1","toolchainDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","engine":"poppler","engineVersion":"25.03.0"}
```

Both Poppler version probes must agree, and the engine version must be a
canonical bounded safe identifier. Missing, malformed, mismatched, or open
readiness output fails closed as `not_ready`; no tool diagnostics are returned.

## Exact v1 success response

Success is HTTP 200 with literal `Content-Type: application/json`, no charset,
and this exact closed JSON shape:

```json
{
  "schemaVersion": 1,
  "policyVersion": "paperpilot-text-extraction-v1",
  "storageVersion": "local-quarantine-v2",
  "toolchainDigest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "verdict": "extracted",
  "input": {
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "sizeBytes": "12345"
  },
  "extraction": {
    "engine": "poppler",
    "engineVersion": "25.06.0",
    "pageCount": 2,
    "chunkCount": 2,
    "textBytes": 49,
    "extractedAt": "2026-08-28T16:00:00.000Z",
    "durationMs": 125
  },
  "chunks": [
    {
      "sequence": 0,
      "pageNumber": 1,
      "paragraphId": "p1-p1",
      "text": "First normalized paragraph."
    },
    {
      "sequence": 1,
      "pageNumber": 2,
      "paragraphId": "p2-p1",
      "text": "Second page paragraph."
    }
  ],
  "completedAt": "2026-08-28T16:00:00.010Z",
  "totalDurationMs": 135
}
```

Every object rejects unknown or missing keys. The following invariants are part
of the contract:

- `verdict` is exactly `extracted` or `no_text`.
- `engine` is literally `poppler`; identifiers are bounded safe opaque values.
- `input.sha256`, decimal `input.sizeBytes`, storage version, and policy version
  bind exactly to the request and deployment configuration.
- `pageCount` is 1 through 2,000.
- `sequence` is contiguous, zero-based array order. `pageNumber` is one-based,
  nondecreasing, and never exceeds `pageCount`.
- Each logical normalized paragraph receives the deterministic page-local ID
  `p{pageNumber}-p{paragraphOrdinal}`. If one paragraph exceeds the per-chunk
  byte limit, its deterministic ordered pieces repeat that paragraph ID.
  `sequence` disambiguates those response chunks; after persistence, the
  database `documentChunkId` is the authoritative chunk identity.
- A chunk contains one nonempty NFC-normalized text slice, has no control or
  Unicode format characters, and is at most 8 KiB in UTF-8.
- `chunkCount` equals `chunks.length` and is at most 4,096.
- `textBytes` is exactly the sum of each chunk's UTF-8 byte length and is at
  most 4 MiB.
- `no_text` requires an empty chunk array and zero chunk/text counts.
  `extracted` requires positive chunk and text counts.
- `extractedAt <= completedAt`, and `totalDurationMs >= extraction.durationMs`.
- The complete pre-serialized UTF-8 JSON body must fit the 8 MiB response cap.
  JSON escaping is included in this final check; responses are never truncated.

Malformed PDFs or tool output, encrypted input, page/text/chunk/output bombs,
timeouts, caller aborts, file mutation, and unavailable tools produce fixed
non-200 JSON errors. Closed deterministic wrapper failures use HTTP 422:
`extraction_input_unsupported` for unsupported/protocol-invalid input and
`extraction_resource_limit` for a bounded page/text/chunk/output ceiling.
Spawn failures, tool exit/unavailability, aborts, and timeouts use the redacted
HTTP 503 `extraction_unavailable`. These failures are not represented as a
third success verdict and never expose tool output, paths, extracted text, or
diagnostics.

## Embedded-text and chunk semantics

The wrapper runs `pdfinfo` for a bounded positive page count and requires
`Encrypted: no`. It runs `pdftotext` with enforced `-enc UTF-8 -eol unix` and
stdout output. Default Poppler form-feed page delimiters must agree exactly with
the `pdfinfo` count, allowing only Poppler's one terminal empty delimiter.

Text decoding is fatal UTF-8. Normalization maps CRLF/CR and Unicode line
separators to LF, applies NFC, converts horizontal Unicode spacing and tabs to
single ASCII spaces, joins consecutive nonblank physical lines with one space,
and uses blank lines as paragraph boundaries. All Unicode format controls,
other control characters, and Unicode noncharacters are rejected rather than
hidden or rewritten. Paragraphs never cross pages. Oversized paragraphs split
at the last complete UTF-8 code point, preferring a word boundary, until each
piece fits. The service does not dehyphenate, classify headings, infer reading
sections, discover figures, or claim character offsets.

An image-only PDF produces `no_text`; OCR is intentionally outside this
service. Poppler output is deterministic only for a fixed Poppler binary,
wrapper source, arguments, and extraction policy, so all are inputs to the
deployment toolchain digest.

## Tool and process boundary

The HTTP process runs a bundled wrapper through a bounded closed JSON protocol.
The wrapper invokes stock `pdftotext` and `pdfinfo` without a shell. Both
versions must parse and match. Commands, arguments, timeouts, and raw-output
ceilings are injectable for deployments and tests:

- `PAPERPILOT_EXTRACTOR_PDFTOTEXT_COMMAND` / `_ARGS_JSON` / `_VERSION_ARGS_JSON`
- `PAPERPILOT_EXTRACTOR_PDFINFO_COMMAND` / `_ARGS_JSON` / `_VERSION_ARGS_JSON`
- `PAPERPILOT_EXTRACTOR_POPPLER_COMMAND_TIMEOUT_MS`
- `PAPERPILOT_EXTRACTOR_POPPLER_MAX_RAW_TEXT_BYTES`

Subprocesses receive a small allowlisted environment, never PaperPilot secrets.
Timeout and abort signal the whole POSIX process group and escalate to SIGKILL.
Windows development uses `taskkill /T /F`. Outer wrapper grace is longer than
inner tool grace so nested process trees are reaped safely.

The configured `PAPERPILOT_EXTRACTOR_TOOLCHAIN_DIGEST` is a deployment-supplied
lowercase SHA-256. Its stable preimage should cover the immutable image/SBOM,
service and wrapper source, extraction policy and arguments, and exact Poppler
binaries. It must not be derived from request content.

## Configuration and hard ceilings

Required:

- `PAPERPILOT_EXTRACTOR_BEARER_SECRET` (or
  `PAPERPILOT_EXTRACTION_SERVICE_BEARER_SECRET`), 32-4096 visible non-placeholder
  ASCII characters
- `PAPERPILOT_EXTRACTOR_POLICY_VERSION` (or
  `PAPERPILOT_EXTRACTION_POLICY_VERSION`)
- `PAPERPILOT_EXTRACTOR_TOOLCHAIN_DIGEST`, 64 lowercase hex characters

The compiled maximums are 25 MiB input, 2,000 pages, 4 MiB normalized chunk
text, 4,096 chunks, 8 KiB per chunk, 8 MiB serialized response, eight concurrent
extractions, and 16 KiB HTTP headers. Defaults use two concurrent extractions,
a 5-second absolute body deadline, and a 45-second extraction deadline, leaving
margin inside a 60-second worker request. Raw Poppler stdout multiplied by
admission concurrency may not exceed 64 MiB.

`PAPERPILOT_EXTRACTOR_SINGLE_USE` is exactly `0` or `1`. When it is `1`,
`PAPERPILOT_EXTRACTOR_MAX_CONCURRENT` must be exactly `1`; after the one admitted
POST reaches a terminal response, the HTTP server closes so the runtime can
replace the container. Liveness and authenticated readiness probes do not
consume that admission. `NODE_ENV=production` fails closed unless single-use
mode and concurrency one are both configured.

The temporary root must be a canonical, non-symlinked, mode-0700 directory
owned by the service user. Production is Linux-only. Configuration fails closed
on Windows because private DACL creation and verification are not implemented.
Tests or deliberate local development may explicitly acknowledge this with
`PAPERPILOT_EXTRACTOR_ALLOW_INSECURE_WINDOWS_DEVELOPMENT=1`; the override is
rejected when `NODE_ENV=production` and must never process hostile documents.
The root must be instance-exclusive and ephemeral because an abrupt process or
host crash cannot execute application cleanup.

Single-use mode and concurrency one are only an immediate containment
mitigation. Production must schedule every extraction into a newly disposable
container or microVM with a distinct mount namespace, PID namespace, and user
namespace, then destroy that isolation boundary after the response. The
current HTTP service and Poppler wrapper share one UID and process/container
boundary; neither this mode nor a Compose restart makes that shared-UID design
a complete multi-tenant sandbox without per-request orchestration.

## Telemetry and operations

The bounded JSON-line telemetry surface emits fixed events such as
`extraction_completed`, `request_rejected`, `request_failed`,
`service_listening`, and `service_stopped`. Only allowlisted counters, verdicts,
safe codes, and durations cross the logger boundary. There is no unauthenticated
metrics endpoint and no extracted text, hash, bearer, header, path, raw error,
or command output in logs.

Run `npm install`, `npm test`, and `npm start`. Production additionally requires
private exact HTTPS routing, no outbound network, non-root execution, a
read-only image, bounded CPU/memory/PIDs/files, an ephemeral private temp volume,
and pinned/scanned Poppler binaries, plus a disposable per-request isolation
boundary as described above. Application timeouts, single-use shutdown, and
process-tree termination are defense in depth, not substitutes for those
runtime controls.
