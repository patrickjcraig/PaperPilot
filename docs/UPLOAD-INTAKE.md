# Authenticated PDF intake and validation

PaperPilot treats every incoming PDF as hostile until a separate validation service proves otherwise. The web process can reserve and stream bytes into private quarantine, but it cannot parse the PDF, serve it, attach it to a prompt, or mark it ready. A leased background worker opens one exact immutable quarantine object, verifies its size and SHA-256, streams it to an isolated malware/PDF validator, validates a bounded content-bound attestation, and performs the only allowed `READY` promotion transaction.

The external validator is a separately deployed security boundary. This repository contains the durable queue, reconciler, streaming client, strict response contract, worker, immutable attestation storage, and promotion/rejection logic. It does not pretend that a parser running in the Next.js process is isolation.

## HTTP protocol

All routes require a valid Better Auth session. Workspace membership and mutation role are resolved on the server. Mutation routes also enforce exact same-origin and shared workspace-rate-limit boundaries.

### 1. Reserve a transfer

`POST /api/workspaces/{workspaceId}/uploads`

```json
{
  "clientOperationId": "upload:client-generated-id",
  "expectedVersion": 12,
  "fileName": "paper.pdf",
  "sizeBytes": 1842210,
  "declaredMimeType": "application/pdf"
}
```

The operation ID is durable and idempotent within the workspace. Replaying the same normalized intent returns the original reservation; reusing the ID for different intent is rejected. `Idempotency-Key` may supply the same ID through the common command boundary. A successful new reservation returns `201`; a replay returns `200`.

The response contains a credential-free Inbox entry plus an opaque upload-session ID, expiry, configured byte ceiling, and same-origin `contentUrl`. It never contains a path, quarantine object key, digest, worker lease, scanner output, or engine version.

### 2. Stream the PDF bytes

`PUT /api/workspaces/{workspaceId}/uploads/{uploadSessionId}/content`

Send the `File` itself as the request body—not multipart, JSON, or base64—with exact parameter-free `Content-Type: application/pdf`. If `Content-Length` is present, it must equal the reservation. Compressed request encodings are rejected.

Only the creator can write a reservation. The server creates a durable attempt-specific receive lease before reading bytes. It streams sequentially with backpressure, enforces idle and absolute deadlines, counts actual bytes, computes SHA-256, retains a bounded trailer window, syncs the temporary file, and exclusively finalizes one immutable attempt object. It then records `WRITTEN`, commits the custody transition and one validation job atomically, and returns `202` with stage `quarantined`.

The synchronous PDF check is deliberately shallow: supported `%PDF-1.x` or `%PDF-2.0` at byte zero, plus a final `%%EOF` marker followed only by PDF whitespace. It is an envelope check, not structural validation or a malware verdict.

### 3. Reconcile an ambiguous client result

`GET /api/workspaces/{workspaceId}/uploads/{uploadSessionId}`

Any authenticated workspace member can retrieve the credential-free status DTO. The browser uses this after a timeout or lost response, avoiding a duplicate reservation merely because the first response was ambiguous. Responses are private and `no-store`.

Public stages are derived from the composite server state and fail closed on contradictions:

| Public stage | Authoritative persisted state |
| --- | --- |
| `awaiting-bytes` | `ISSUED` + `UPLOADING` + `PENDING` |
| `receiving` | `RECEIVING` + `UPLOADING` + `PENDING` |
| `quarantined` | `STORED` + `QUARANTINED` + `PENDING` |
| `validating` | `STORED` + `SCANNING` + `PROCESSING` |
| `ready` | `STORED` + `READY` + `READY` |
| `failed` | Explicit rejection/failure/deletion/archive or an inconsistent combination |
| `expired` | `UploadSession.EXPIRED` |

The DTO emits fixed public failure categories only. It never copies a stored diagnostic, provider body, filesystem error, scanner message, internal validation code, or object identity into the browser.

## Durable worker lifecycle

The upload-finalization transaction creates exactly one deduplicated `DOCUMENT_VALIDATE` job with an authoritative organization, document, and asset target. The job payload contains only a schema version, policy/storage version, source kind, and upload-session ID; it is never used as authorization.

The worker lifecycle is:

1. Parse all endpoint, secret, policy, timeout, freshness, and storage configuration before claiming a job. Broken configuration burns no attempts.
2. Probe the validator's exact same-origin readiness endpoint with the independent bearer credential. A retryable outage or deadline backs off without consuming an attempt; authentication, redirect, endpoint, and configuration failures stop the worker.
3. Claim one due row with `FOR UPDATE SKIP LOCKED`, create a unique `JobAttempt`, and assign a bounded lease ID, worker ID, and expiry.
4. Re-read the tenant-scoped `Document`, `Asset`, `DocumentAsset.ORIGINAL`, and `UploadSession.STORED` links. A payload cannot redirect the worker to another tenant or object.
5. Atomically move `Asset.QUARANTINED` / `Document.PENDING` to `SCANNING` / `PROCESSING`.
6. Open the exact generated local object through a verified file handle. On non-Windows systems the adapter uses `O_NOFOLLOW`; it requires one regular link and compares handle identity before and after validation.
7. Compute SHA-256 from that handle and compare it with the committed custody identity before making an external request.
8. Stream the same open handle as raw `application/pdf` to the exact configured validator endpoint. Redirects, endpoint changes, credentialed URLs, unexpected statuses/media types, oversized responses, invalid UTF-8/JSON, and unknown fields fail closed.
9. Require the response to bind exact SHA-256, size, storage version, policy version, toolchain digest, fresh malware signatures, canonical timestamps, and internally consistent malware/PDF verdicts.
10. Recheck the live lease and target state, insert one immutable attestation, and atomically accept or reject.

An accepted attestation requires `CLEAN` malware, structurally `VALID` PDF, a positive page count, and no rejection code. It sets both asset and document to `READY`. A policy or content rejection records the bounded attestation, sets `Asset.REJECTED` and `Document/Inbox.FAILED`, and never unlocks Reader. Validator execution failures retry with bounded exponential backoff; retry state returns to `QUARANTINED` / `PENDING`. Exhaustion produces `DEAD_LETTER` plus a safe operator/user-visible failure. A stale worker cannot heartbeat, complete, reject, or promote after losing its lease.

`ImportBatch` remains `RUNNING` while validation is queued or active. It becomes `SUCCEEDED` only after accepted validation and `FAILED` after content rejection or terminal worker failure.

## Reconciliation and cleanup

The validation worker loop runs the bounded upload reconciler periodically. Multiple reconcilers can run safely:

- expired reservations transition exactly once to `EXPIRED` and emit one audit event;
- stale receive leases become durable `ABANDONED` attempts and the reservation returns to `ISSUED` when its overall lifetime remains open;
- a `STORED` upload missing its deduplicated validation job gets exactly one repaired job after authoritative target checks;
- terminal receive attempts obtain a cleanup lease before filesystem work;
- cleanup retries durably with bounded backoff after a crash or storage error;
- an attempt object already adopted by an authoritative stored asset is never deleted;
- cleanup accepts only the generated tenant/asset/attempt key and never recursively deletes directories.

Each upload attempt has its own immutable final filename. A stale attempt therefore cannot overwrite or delete a newer attempt's bytes.

## Configuration

Local development defaults to `<workspace>/.paperpilot-data/quarantine`, which is ignored by Git. Production fails closed unless `PAPERPILOT_UPLOAD_QUARANTINE_ROOT` names a pre-provisioned absolute canonical directory outside application-served paths. The root cannot be a filesystem root, symlink/junction alias, `public`, or `.next/static`.

| Upload variable | Default | Meaning |
| --- | ---: | --- |
| `PAPERPILOT_UPLOAD_QUARANTINE_ROOT` | Local private data directory; no production default | Durable server-private quarantine root |
| `PAPERPILOT_UPLOAD_MAX_BYTES` | `26214400` | Maximum bytes for one PDF |
| `PAPERPILOT_UPLOAD_SESSION_TTL_SECONDS` | `900` | Reservation lifetime |
| `PAPERPILOT_UPLOAD_LEASE_TTL_SECONDS` | `600` | Exclusive receive lease; longer than the absolute stream deadline |
| `PAPERPILOT_UPLOAD_STREAM_IDLE_TIMEOUT_SECONDS` | `30` | Maximum delay between body chunks |
| `PAPERPILOT_UPLOAD_STREAM_ABSOLUTE_TIMEOUT_SECONDS` | `300` | Maximum total body-stream duration |
| `PAPERPILOT_UPLOAD_MAX_CONCURRENT_PER_USER` | `2` | Active reservations per user |
| `PAPERPILOT_UPLOAD_MAX_CONCURRENT_PER_WORKSPACE` | `10` | Active reservations per workspace |
| `PAPERPILOT_UPLOAD_MAX_RETAINED_BYTES_PER_WORKSPACE` | `262144000` | Workspace quarantine reservation/retention ceiling |

| Validation-worker variable | Default | Meaning |
| --- | ---: | --- |
| `PAPERPILOT_VALIDATION_SERVICE_ENDPOINT` | Required | Exact HTTPS validator endpoint; loopback HTTP is development-only |
| `PAPERPILOT_VALIDATION_SERVICE_READINESS_ENDPOINT` | Same origin at `/readyz` | Exact authenticated readiness URL checked before claiming an attempt |
| `PAPERPILOT_VALIDATION_SERVICE_BEARER_SECRET` | Required | Independent non-placeholder visible-ASCII secret, 32–4096 characters |
| `PAPERPILOT_VALIDATION_POLICY_VERSION` | Required | Must be `paperpilot-document-validation-v1` for this worker build |
| `PAPERPILOT_VALIDATION_TIMEOUT_SECONDS` | `30` | Absolute external validation deadline, maximum 120 seconds |
| `PAPERPILOT_VALIDATION_MAX_RESPONSE_BYTES` | `16384` | Response ceiling; cannot exceed the compiled 16 KiB hard limit |
| `PAPERPILOT_VALIDATION_SIGNATURE_MAX_AGE_SECONDS` | `86400` | Maximum malware-signature age |
| `PAPERPILOT_VALIDATION_FUTURE_CLOCK_SKEW_SECONDS` | `300` | Bounded validator clock skew |
| `PAPERPILOT_VALIDATION_WORKER_ID` | Generated host/process/UUID | Optional bounded operator-visible worker identity |

Every numeric setting uses canonical positive-integer syntax. Internal maxima remain compiled in, so an environment value cannot expand critical response/deadline boundaries without a reviewed code change.

Start the worker only after the isolated validator is reachable:

```powershell
npm run worker:validation
```

The worker exits before claiming work if configuration is absent or invalid. It also probes authenticated readiness before every claim: retryable unavailability waits without incrementing `Job.attempts`, while a redirect, endpoint mismatch, bad credential, or invalid response fails closed. The readiness probe is an operational guard, not an attestation or authorization shortcut; the full PDF request and response contract is still enforced for every claimed job. Do not set a placeholder secret just to make it start.

## Production storage and isolation boundary

The current local adapter requires one persistent private volume shared by the upload-serving application and validation worker. Do not use ephemeral storage or independent per-instance volumes. On Windows, inherited ACLs cannot be made reliably private by Node `chmod`; therefore the worker refuses the local adapter in production on Windows. Use a protected Linux volume for the current adapter or implement the planned object-storage adapter.

The validator must run outside the web/worker trust boundary with hard CPU, memory, process, file, page, recursion, decompression, and wall-clock limits; no outbound network; a read-once request body; current malware signatures; and a maintained structural PDF toolchain. The bearer secret authenticates the caller but does not replace network isolation, workload sandboxing, or image provenance.

Still required for a horizontally scaled complete service:

1. Direct private object storage with short-lived operations and an equivalent handle/version binding.
2. A deployed hardened validator image/service and production health/attestation monitoring.
3. Isolated extraction/OCR jobs that consume only accepted assets and create page/section/paragraph/figure locators.
4. Reader/download routes that require `READY` plus an accepted attestation and safe content-disposition policy.
5. Tenant-safe deduplication only after trusted-content and information-leak rules are defined.
6. Zotero attachments, then allowlisted rights-/robots-aware crawler and user-reviewed WebMCP/MCP intake, all routed through the same custody lifecycle.

Until the extraction and serving gates exist, a `READY` private document is verified storage—not yet a bibliographic `Paper`, project membership, citation-grade text chunk, or Reader payload.
