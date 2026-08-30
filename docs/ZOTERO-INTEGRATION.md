# Zotero integration design

PaperPilot targets Zotero Web API v3 at `https://api.zotero.org`. Zotero currently supports OAuth 1.0a—not OAuth 2.0—for obtaining a long-lived API key. The key remains server-side for its entire lifetime.

Authoritative references:

- [OAuth key exchange](https://www.zotero.org/support/dev/web_api/v3/oauth)
- [Web API basics, authentication, pagination, and throttling](https://www.zotero.org/support/dev/web_api/v3/basics)
- [Incremental synchronization](https://www.zotero.org/support/dev/web_api/v3/syncing)
- [Write requests and preconditions](https://www.zotero.org/support/dev/web_api/v3/write_requests)
- [File download/upload](https://www.zotero.org/support/dev/web_api/v3/file_upload)
- [Full-text endpoints](https://www.zotero.org/support/dev/web_api/v3/fulltext_content)
- [Streaming notifications](https://www.zotero.org/support/dev/web_api/v3/streaming_api)

## Release sequence

1. ✅ OAuth connect/callback/status/disconnect and `/keys/current` verification.
2. ✅ Personal/group library discovery and explicit, optimistic selection.
3. ✅ Inbound item/collection metadata synchronization with durable cursors, staged atomic commits, tombstones, provider backoff, observable runs, and Inbox/provenance projection.
4. ✅ Sanitized attachment projection plus opt-in, one-file stored-PDF copies into PaperPilot's quarantine/validation/extraction pipeline.
5. Notes and annotation body import as a separate opt-in policy.
6. Streaming notifications as a scheduling optimization.
7. Optional write-back only after conflict resolution exists.

Steps 1–4 are implemented in this repository. They are not a claim that a public PaperPilot deployment or a Zotero OAuth application has been provisioned. A deployment must register its own exact HTTPS callback, configure the server-only secrets and attachment redirect allowlist, apply the database migrations, and supervise the metadata and attachment workers separately from the web process.

## OAuth boundary

Endpoints:

```text
POST   /api/workspaces/:workspaceId/integrations/zotero/oauth/start
GET    /api/integrations/zotero/oauth/callback
GET    /api/workspaces/:workspaceId/integrations/zotero
POST   /api/workspaces/:workspaceId/integrations/zotero/:connectionId/libraries/discover
PUT    /api/workspaces/:workspaceId/integrations/zotero/:connectionId/libraries/selection
POST   /api/workspaces/:workspaceId/integrations/zotero/:connectionId/sync-runs
GET    /api/workspaces/:workspaceId/integrations/zotero/:connectionId/attachment-policy
PUT    /api/workspaces/:workspaceId/integrations/zotero/:connectionId/attachment-policy
GET    /api/workspaces/:workspaceId/integrations/zotero/:connectionId/attachments
POST   /api/workspaces/:workspaceId/integrations/zotero/:connectionId/attachments/:attachmentId/imports
DELETE /api/workspaces/:workspaceId/integrations/zotero/:connectionId
```

`oauth/start` accepts one documented read-only scope profile, creates a signed short-lived state/nonce, and stores only keyed hashes plus an envelope-encrypted temporary request-token secret. The callback reauthenticates the user, validates state, workspace, request token, verifier, expiry, callback binding, and one-time consumption, atomically erases the temporary secret, and only then performs the provider exchange. It immediately redirects to a clean same-origin Sources URL with no OAuth values.

The start body is `{}` for the default `personal_metadata` scope or exactly `{ "scopeProfile": <profile> }`, where `<profile>` is one of `personal_metadata`, `personal_metadata_notes`, `personal_group_metadata`, or `personal_group_metadata_notes`. A successful start returns `201` with only `authorizationUrl`, `expiresAt`, and the resolved `scopeProfile`.

Default first-release scope: inbound metadata read. Notes and group access require explicit user choices. Write access will not be requested until PaperPilot can display and resolve conflicts.

The access token returned by Zotero is the long-lived API key. PaperPilot stores only envelope-encrypted ciphertext, a non-secret keyed fingerprint, and a key version. Only the server lifecycle/connector boundary may decrypt it; browser clients operate on an opaque PaperPilot connection ID and credential-free summaries. Disconnect erases the local envelope before a bounded best-effort provider key deletion.

An access key exchanged by a callback that cannot durably attribute it is never automatically deleted: Zotero keys are provider-global, so a concurrent workspace may have committed the same key. PaperPilot writes a sanitized manual-cleanup audit record instead. Production logging and alerting must page on `zotero_oauth_critical_audit_failed`; this CRITICAL signal means every durable audit-write retry failed and operations must investigate the request ID without expecting a token or provider credential in logs.

Before constructing the read-only adapter, the service must authorize workspace membership and resolve the connection through the compound `(organizationId, id)` key. The adapter's credential boundary requires both `{ organizationId, connectionId }`; the workspace ID is supplied by the authenticated server context, never request JSON. The resolver must additionally require `provider=ZOTERO`, a usable status, and library ownership before decrypting or fetching. A foreign connection ID must fail before the resolver returns a token or any network call begins.

Starting OAuth, discovery, selection, manual synchronization, attachment-policy changes, and disconnect require an authenticated workspace owner or admin. Authenticated members may inspect credential-free connection, policy, and attachment summaries. Owners, admins, and members may explicitly import one eligible stored PDF only while the connection-level policy is `MANUAL`; viewers cannot mutate it.

The new metadata routes use exact JSON command shapes.

`POST /api/workspaces/:workspaceId/integrations/zotero/:connectionId/libraries/discover`

```json
{}
```

`PUT /api/workspaces/:workspaceId/integrations/zotero/:connectionId/libraries/selection`

```json
{
  "clientOperationId": "opaque-replay-key",
  "expectedSelectionRevision": 0,
  "selectedLibraryIds": ["paperpilot-zotero-library-id"]
}
```

`POST /api/workspaces/:workspaceId/integrations/zotero/:connectionId/sync-runs`

```json
{
  "clientOperationId": "opaque-replay-key"
}
```

Discovery returns `{ "discovered": true, "libraries": [...] }`. Selection returns an `applied`, `noop`, or replay-normalized `replayed` outcome with the new `selectionRevision` and library summaries. For selection and sync, an optional `Idempotency-Key` header must exactly equal `clientOperationId`. Selection rejects stale revisions and foreign, duplicate, or unreadable library IDs. A manual sync returns `202` with `outcome: "queued"` when it creates any work, or `200` with `outcome: "coalesced"` when every selected library already has active work. The response includes exact `queuedCount` and `coalescedCount` dispositions plus one sanitized run summary per selected readable library. These routes enqueue or describe durable work; the separately supervised worker performs provider calls.

## Library identity and permissions

Personal libraries use `/users/<numericUserID>`; group libraries use `/groups/<numericGroupID>`. Every source object is addressed by:

```text
(connectionId, libraryKind, libraryId, objectType, objectKey)
```

Do not deduplicate source objects solely by DOI. The same work can legitimately exist in personal and multiple group libraries.

PaperPilot calls `/keys/current` after connection and again during discovery. Effective `library`, `files`, `notes`, `write`, and group permissions are authoritative; requested OAuth options are not. Re-running discovery is the current permission-refresh operation; an automatic long-interval permission re-verification job remains operations hardening.

Discovery re-verifies `/keys/current`, enumerates readable personal and group libraries, updates effective permissions, records access loss without silently preserving selection as readable, and never selects a library merely because it was discovered. Selection is explicit user intent and has its own optimistic revision.

## Incremental synchronization

Each selected library owns a cursor and lock. Versions remain opaque decimal strings because Zotero versions are monotonic but not sequential.

Stable read pass:

1. Start at the last committed `Last-Modified-Version`, or `0`.
2. Fetch the all-item version manifest with `includeTrashed=1` and the collection version manifest, both with `since=<cursor>` and an `If-Modified-Since-Version` precondition.
3. Fetch changed bodies in batches of at most 50 keys.
4. Fetch `/deleted?since=<cursor>` and stage item/collection tombstones.
5. Require every response in the pass to report the same `Last-Modified-Version`.
6. If it changes mid-run—or any batch is incomplete or disagrees with its manifest—discard the run-owned stage, retry with increasing delay, and do not advance the cursor.
7. While the worker still owns its fenced lease, atomically publish objects, tombstones, Inbox snapshots, append-only provenance, run/job completion, and the new cursor; then clear the stage.

Metadata normalization deliberately removes `note`, `annotationText`, and `annotationComment`. Only top-level bibliographic items with a usable title become reviewable Inbox snapshots. Attachment items receive a separate sanitized projection containing only stable library/object identity, parent key, admitted link mode/content type/file name, source version, MD5/mtime identity, a projection hash, eligibility/reason, and tombstone state. Provider paths, download locations, signed URLs, credentials, and raw metadata never enter that projection. Notes, annotations, child items, and collections can remain connector metadata/provenance records without pretending to be papers or possessed full text.

Source identity includes the connection, personal/group library, object kind, and Zotero key. The same DOI in a personal library and one or more groups therefore remains distinct source custody. A researcher can later file the Inbox record through the existing canonicalization flow.

A Zotero deletion tombstones the source object and rejects a still-pending source Inbox row with `zotero_source_deleted`. It never cascade-deletes a filed PaperPilot paper, project membership, quotation, evidence note, or its prior provenance. If the source record reappears, synchronization can restore its pending Inbox state.

## Provider limits and recovery

- Multi-object pages use `limit=100` and strict same-origin `Link rel="next"` traversal.
- Changed object bodies use at most 50 keys per request.
- One provider response is capped at 5 MiB by default. A sync pass admits at most 10,000 changed/tombstoned objects and 64 MiB of decoded object JSON; exceeding any supported limit is a terminal `zotero_sync_resource_limit`, not an automatic retry storm.
- A `Backoff` header may appear on any response, including success; persist the deadline and stop calls for that connection.
- Respect `Retry-After` on `429` and `503`; otherwise use the worker's bounded retry schedule.
- The current worker processes one claimed library pass at a time and heartbeats a fenced database lease.
- Coalesce manual and scheduled triggers into one active job per library. The data model accepts a future streaming-trigger reason, but streaming notifications are not connected yet.
- The worker checks due selected libraries every minute by default and schedules a library after the default 15-minute cadence. Those are implementation defaults, not service-level guarantees.

Read-only metadata status handling:

- `401`: mark the connection revoked and require reconnection.
- library `403`: revalidate `/keys/current`; revoke the connection when the key itself is rejected, otherwise mark only that library unreadable and require the user to review its permissions/selection.
- `429` and `503`: respect provider retry timing and persist observable backoff.
- transport, timeout, inconsistent-version, and malformed-response failures retry through the durable job lease up to the bounded attempt limit, then dead-letter. Provider/manifest resource limits are terminal and require an explicit manual retry after remediation.
- automatic scheduling excludes active and terminal-attention jobs before batching, so backed-off libraries do not starve later libraries and permanent failures are not silently resurrected with a fresh attempt budget.
- no failed, backing-off, or lease-lost pass advances the committed library cursor.

## Running the implemented connector slices

Local or production-shaped setup requires a registered Zotero OAuth 1.0a application with an exact HTTPS callback and these server-only values. The OAuth/keyring values are represented in `.env.example`; the worker ID is optional:

- `ZOTERO_OAUTH_CONSUMER_KEY`
- `ZOTERO_OAUTH_CONSUMER_SECRET`
- `ZOTERO_OAUTH_STATE_SECRET`
- `ZOTERO_OAUTH_CALLBACK_URL`
- `PAPERPILOT_CREDENTIAL_ACTIVE_KEY_VERSION`
- `PAPERPILOT_CREDENTIAL_ENCRYPTION_KEYS`
- `PAPERPILOT_CREDENTIAL_FINGERPRINT_KEY`
- optional `PAPERPILOT_ZOTERO_WORKER_ID` for a stable, bounded operator-visible worker identity
- `PAPERPILOT_ZOTERO_ATTACHMENT_BLOB_ALLOWLIST`, a required non-empty JSON list for the attachment worker; use either an exact default-port public HTTPS origin or a path-style S3 origin plus one exact bucket
- optional `PAPERPILOT_ZOTERO_ATTACHMENT_WORKER_ID` for a stable, bounded attachment-worker identity

Apply/generate the database artifacts and start the application:

```powershell
npm run db:deploy
npm run db:generate
npm run dev -- --hostname 127.0.0.1
```

In a separate supervised process, using the same database and credential keyring configuration, run:

```powershell
npm run worker:zotero
```

When stored-PDF imports are enabled, run a second independently supervised process with the same database, keyring, and private quarantine storage view:

```powershell
npm run worker:zotero-attachments
```

The web process does not execute connector jobs in-process. If the metadata worker is absent, selection and manual sync triggers remain durable and visible but queued metadata work will not contact Zotero. If the attachment worker is absent, explicit file commands remain queued without downloading bytes. Production must supervise and restart both workers, give them the same migration-compatible schema and secret versions as the web nodes, and alert on stale queued/backing-off/dead-letter work. This repository does not claim those deployment operations have been completed.

## Attachments

Binary ingestion is deliberately separate from metadata synchronization. Absence of a policy row is `DISABLED`; changing between `DISABLED` and `MANUAL` increments an optimistic revision. Metadata sync may project eligible attachment records while disabled, but it never downloads their bytes.

One explicit import command binds the connection, selected readable library, attachment object, source version, projection hash, provider MD5, policy revision, credential generation, actor, and idempotency key. The command reserves workspace-retained bytes and atomically creates an attempt-scoped document/asset/intake, one-item ImportBatch, closed Zotero Inbox payload, import record, and minimal `DOCUMENT_DOWNLOAD` job. Replaying one operation returns its original attempt. A fresh operation may retry an immutable `FAILED` or `CANCELLED` attempt; active, `ATTENTION`, and `READY` generations coalesce.

The separately supervised attachment worker then:

1. Claims work with a database-authoritative clock and an exact job/import/connection/library/document/asset/intake binding.
2. Re-verifies the connection credential generation/fingerprint/key version, policy revision, selected readable library, effective file-access tri-state, source version, projection hash, provider MD5, and cancellation state before credential resolution and again before adoption.
3. Calls the authenticated Zotero `/file` endpoint without exposing the key to the browser. `UNKNOWN` file access may probe that exact endpoint; only known `UNAVAILABLE` is pre-denied.
4. Removes authorization before following the one admitted blob redirect. Redirect destinations are HTTPS, public, bounded, and deployment-allowlisted by exact origin or exact path-style S3 bucket; job payloads and database rows cannot expand the allowlist.
5. Streams into an attempt-specific private quarantine object under byte, idle, absolute-time, PDF-envelope, MD5, and response-identity limits. It calculates SHA-256 and adopts the object only while every fence still matches.
6. Creates an immutable ingest receipt and validation job, then projects `QUARANTINED → VALIDATING → EXTRACTING → READY` through the shared intake, Zotero import, Inbox, and one-item batch lifecycle. Validation rejection closes `FAILED`; terminal extraction becomes `ATTENTION`, and an explicit recovery can return it through `EXTRACTING` to `READY`.

Provider retry timing is credential-fenced and capped to a six-hour operational horizon. A failed physical write remains charged until exact deletion is proven. Repeated cleanup failure eventually dead-letters the logical import while retaining quota and continuing cleanup independently; only the later successful deletion releases that charge. Credentials, signed blob URLs, private paths, file bytes, raw provider errors, and note content are excluded from leases, payloads, receipts, audit metadata, and public responses.

Zotero `/fulltext` is useful for fast search/bootstrap, but it is not citation-grade page geometry. PaperPilot should parse the verified PDF when evidence must cite a page or figure.

## OAuth release verification

- ✅ parallel/replayed/expired/wrong-user/wrong-workspace/wrong-token callback behavior;
- ✅ foreign-workspace connection/library IDs rejected before credential resolution or fetch;
- ✅ temporary-token exchange failure, one-time consumption, and redaction;
- ✅ credential-envelope integrity, row-binding, reconnect convergence, leased superseded/disconnect revocation, uncertain-key manual-cleanup signaling, and disconnect erasure;
- ✅ claimed-callback expiry, ambiguous commits, fingerprint rotation, same-key cross-workspace concurrency, mixed revocation queues, and critical-audit retry/fallback;
- ✅ exact provider origins, bounded bodies, fatal UTF-8, timeouts, clean callback redirects, and read-only browser authorization validation;

## Metadata and attachment verification

The implemented connector paths have unit and PostgreSQL integration coverage for provider contracts, discovery/selection authorization and replay, stable atomic metadata commits, coalescing, persistent backoff, tombstones that preserve canonical evidence, attachment policy/command admission, terminal-attempt retries, exact download authority, redirect/credential stripping, checksum/size/PDF identity, database clock skew, cancellation, cleanup dead-lettering/eventual quota release, and shared validation/extraction lifecycle projection. Run the complete project gate with the configured development database available:

```powershell
npm test
npm run test:integration
npm run lint
npm run typecheck
npx prisma validate
npx prisma migrate status
npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code
npm run build
```

The following remain production release gates, not claims made by the local implementation:

- live end-to-end exercises against a deployment-owned Zotero OAuth application and its reviewed current blob destinations;
- deployment, image/SBOM scanning, immutable pinning, private workload identity, and adversarial operation of the validator and per-request isolated extractor;
- replacement of local shared-volume quarantine with short-lived direct object operations before horizontal scaling;
- write conflicts (`409`, `412`, `428`) and explicit three-way conflict resolution;
- opt-in note/annotation body retention, redaction, deletion, and export policy.
