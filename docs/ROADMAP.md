# PaperPilot live-service roadmap

This roadmap keeps the broad product ambition—Zotero, scholarly discovery, uploads, governed crawling, WebMCP/MCP intake, source-grounded reading, evidence, and collaboration—while enforcing release gates that prevent quiet data loss or cross-workspace access.

## Active priority reset — WebMCP provenance first

As of 2026-08-29, new product work is focused on the browser-mediated WebMCP provenance loop described in [WEBMCP-PROVENANCE-SCOPE.md](./WEBMCP-PROVENANCE-SCOPE.md).

**Now:** expose a closed PaperPilot WebMCP capture tool, let a browser agent stage one bounded webpage passage, require human review, and preserve the source fragment, locator, hashes, tool trail, and final decision as durable evidence.

**Next:** multi-passage sessions, drift/re-anchor, a common web/PDF source abstraction, captured-source comparison, and stronger independent archival authority.

**Later:** new crawler/network breadth, Zotero expansion, remote MCP authorization, collaboration breadth, horizontal scale, and generalized production operations.

The completed foundations below remain available, but their remaining tasks are not part of the active release gate. The collaboration/operations hardening loop is paused in-place and must be reconciled before its pending migration is applied.

## Product principles

1. **Discover first.** A researcher should reach useful scholarly results before configuring a complex workspace.
2. **Every import is reviewable.** Provider, identifier, retrieval time, access state, version, duplicate decision, and destination remain visible.
3. **Metadata is not full text.** Reader and citation controls unlock only after a verified document is processed.
4. **Evidence carries custody.** Claim, source excerpt, interpretation, confidence, author, and locator remain distinguishable.
5. **The server proves authority.** Sessions, membership, role, and tenant ownership are resolved at the data boundary.
6. **Connectors are replaceable ports.** OpenAlex, Zotero, uploads, crawlers, and MCP sources normalize into the same Inbox/provenance lifecycle.
7. **Broad scope does not mean uncontrolled fetching.** Crawling and agent-assisted capture remain allowlisted, policy-aware, and user-confirmed.

## Loop 1 — interactive hackathon prototype

Status: complete.

- Clickable Discover, Workspace, Inbox, Sources, project, Reader, Evidence, and Collections views.
- Live server-mediated OpenAlex search with deterministic demo fallback as an explicit mode, not a silent provider fallback.
- Browser-local projects/imports and guided demo reading.
- Clear live/demo/preview/upcoming labels.

Exit evidence: navigation and demo loop exercised in the browser; lint, typecheck, and production build passed.

## Loop 2 — authenticated service foundation

Status: application foundation complete; deployment prerequisites remain.

- Browser snapshot v3 includes projects, imports, Inbox, notes, collections, and active project.
- Shared async `WorkspaceClient` contract with expected versions and operation IDs.
- Demo adapter provides atomic mutations, replay receipts, deep clones, and rollback behavior.
- Better Auth database sessions and organization-backed workspaces.
- Prisma 7/PostgreSQL schema and committed migrations.
- Server-owned workspace bootstrap and project creation.
- Durable idempotency receipts, optimistic organization revisions, and audit event creation.
- Compound PostgreSQL tenant foreign keys prevent cross-workspace joins throughout projects, imports, evidence, Zotero, jobs, and documents.
- Browser mutations enforce trusted origin, strict media types, bounded streaming bodies, runtime schemas, and fail-closed role checks.
- `/app` opens on authenticated Discover and creates PostgreSQL-backed projects in Workspace.
- First server-only, read-only Zotero Web API v3 adapter boundary.
- Transactional verification and password-recovery delivery boundary with token-scrubbing recovery UI.
- Database-backed Better Auth throttling plus shared PostgreSQL discovery and workspace quotas.
- Unit, database integration, production build, and browser account/project flows pass.

Remaining deployment work in this loop:

- deploy and validate the configured transactional-email receiver before public registration;
- configure and verify the trusted-proxy/IP topology for the production host;
- decide and establish the Git repository boundary.

## Loop 3 — authenticated intake and browser migration

Goal: a live discovery result reaches a durable project without touching `localStorage`.

Status: durable Discover, Inbox, project detail, collection, and evidence commands are implemented and verified; browser-data migration remains.

Build:

- ✅ `POST /api/workspaces/:id/imports` stages a strictly normalized paper/provider snapshot in the Inbox;
- ✅ transactional Inbox-to-project filing uses canonical DOI/provider deduplication, optimistic versions, and durable replay receipts;
- ✅ discovery and import provenance plus audit records are created with server-derived tenant/actor context;
- ✅ project detail read model and authenticated Inbox/project UI;
- ✅ project collection creation plus paper/evidence membership commands;
- ✅ structured source-custody evidence creation with manual assertions forced to `needs-verification`;
- ✅ per-user/workspace OpenAlex and workspace-mutation quotas with shared PostgreSQL enforcement;
- an explicit, previewable browser-v3-to-server migration with count/hash verification and a retained local backup;
- production anonymous OpenAlex access remains disabled unless explicitly enabled for local evaluation.

Exit criteria:

- Save from authenticated Discover → choose Inbox/project → refresh/new session → same paper and provenance remain.
- Parallel identical imports produce one canonical workspace paper and replay-safe command responses.
- Cross-tenant project, paper, Inbox, and provenance IDs always return the same non-enumerating denial.
- A migration retry cannot duplicate or delete browser data.

## Loop 4 — Zotero OAuth and inbound metadata synchronization

Goal: connect personal and selected group libraries safely, then keep metadata current.

Status: the application-side OAuth, permission discovery, explicit library selection, durable cursored metadata synchronization, provider backoff, tombstones, observable runs, and Inbox/provenance projection are implemented and verified. Deployment registration and operations remain: PaperPilot has not provisioned a public Zotero OAuth application or production worker fleet.

Build:

- deployment registration of the Zotero OAuth 1.0a application and exact callback;
- ✅ signed, one-time state and encrypted request-token-secret storage with atomic callback replay protection;
- ✅ rotation-capable envelope encryption boundary for the long-lived Zotero key;
- ✅ bounded `/keys/current` verification, user-ID matching, and effective permission capture;
- ✅ owner/admin-only read-only scope selection, credential-free status UI, clean callback redirects, and disconnect;
- ✅ claimed-callback leases, ambiguous-commit reconciliation, and an encrypted generation-safe revocation outbox with critical manual-cleanup alerting;
- ✅ personal/group library discovery, effective-permission re-verification, and explicit optimistic selection;
- ✅ inbound metadata-only sync with per-library cursors, run-owned staging, fenced leases, exact stable-version passes, tombstones, and atomic cursor commits;
- ✅ persistent `Backoff`/`Retry-After` scheduling, default periodic pulls, duplicate-trigger coalescing, and observable sanitized sync runs;
- ✅ repeated persistent-job cycles, concurrent-claim retry, exact queued/coalesced counts, terminal-failure scheduler suppression/fair candidate filtering, connection-generation fencing, revoked-key-versus-library-ACL revalidation, atomic late-CAS rollback, and explicit response/object/decoded-byte admission ceilings;
- ✅ source-specific Inbox snapshots and append-only provenance mapping from Zotero objects into the existing filing/canonicalization lifecycle;
- ✅ sanitized, tombstone-aware attachment projection with no provider paths, signed URLs, credentials, or raw metadata;
- ✅ disconnect that prevents local use, erases the encrypted key, and best-effort revokes remotely.

Exit criteria:

- ✅ expired/replayed/wrong-user OAuth callbacks fail without retaining a key;
- ✅ a failed or concurrent reconnect cannot revoke a provider key already committed in this or another workspace;
- ✅ a mid-run library-version change restarts without advancing the cursor;
- ✅ remote deletion tombstones the Zotero source object and any still-pending source Inbox row but never deletes a filed paper or user evidence;
- ✅ personal and group objects with the same DOI remain distinct source records and can share canonical scholarly metadata only through explicit Inbox filing;
- ✅ no credential appears in browser code, clean callback URLs, sanitized errors, audit events, critical logs, or database plaintext.

Application deployment requirements for this loop are: register the exact HTTPS callback, supply independent OAuth/state/encryption/fingerprint secrets, apply the committed migrations, and supervise `npm run worker:zotero` separately from the web process against the same database and keyring. A connected account with no selected library—or queued jobs with no worker—does not import metadata.

The metadata pass strips note/annotation bodies and never downloads attachment bytes. It may publish sanitized eligibility records; attachment-byte custody begins only after a separate explicit command and follows the quarantine/validation/extraction pipeline in Loop 5. Opt-in note/annotation content, streaming-notification wiring, and two-way write-back wait for their own policy/conflict-resolution releases.

## Loop 5 — uploads, verified documents, and policy-aware web intake

Goal: move from metadata records to citation-grade documents without trusting incoming bytes.

Status: the live upload-to-Reader custody path, its Reader scalability slice, Zotero stored-PDF intake, governed explicit one-PDF crawler intake and user-directed custody retirement, metadata-only WebMCP proposal intake, digest-bound human review/OpenAlex-backed canonical promotion, exact grounded-evidence capture, and explicit immutable review/re-anchor successor workflow are implemented. A workspace member can reserve an idempotent browser transfer, explicitly select one eligible Zotero PDF, queue one rights-affirmed query-free HTTPS PDF under a frozen policy, retire an authorized crawler copy through a separately confirmed deletion ledger, or stage and review a bounded WebMCP bibliographic proposal. The crawler has a no-raw-locator public ledger, cross-policy byte-identical acquisition/deletion replay, a tenant-bound durable authority graph, a separately supervised worker, RFC 9309 robots evaluation, all-public DNS admission, hostname-verified pinned TLS, strict redirect rejection, shared origin budgets, bounded streaming into attempt-specific private quarantine, immutable receipts, fenced retry/cleanup/deletion, storage-generation-bound absence proof, evidence-aware extracted-text retirement, and shared validation handoff. It never searches, autonomously follows links, files a paper, or grants Reader authority. WebMCP metadata receives server-assigned actor/source/time/provenance and cannot create documents, assets, intakes, receipts, jobs, or Reader authority. Generic filing remains blocked; the separate approval command binds the staged digest, explicit duplicate/project decision, fresh visibility/version checks, independently verified provider metadata, and a trigger-guarded retained approval graph. Any later user-supplied PDF retains browser-upload custody. Fail-closed validation, exact-identity extraction readiness, database-owned lease timing, credential/policy/source-generation fencing, cleanup-retained quotas, no-budget pre-admission deferral, deterministic dead-letter classification, immutable attestations/generations, trigger-protected manifest admission and project-paper custody, generation-bound signed pagination, bounded keyset reads, dedicated authenticated Reader quotas, honest unavailable/processing/no-text Reader states, UTF-8 byte-exact quote reconstruction, independent review/source-currentness states, idempotent revision replay, head-only filing projections, and hidden-lineage non-disclosure are implemented. Platform image build/scanning/pinning and per-request production isolation, exact-version object storage, append-only WebMCP duplicate refresh, direct MCP authorization/remote-WebMCP acquisition, autonomous discovery, and OCR remain next. This environment has no Docker daemon, so no extractor or validator image build is claimed; crawler production enablement still requires reviewed deployment policy, durable version-addressable storage, supervised workers, monitoring, and public-origin/deletion-race adversarial drills.

Build:

- ✅ authenticated, tenant-bound upload reservations with optimistic revision checks, durable idempotency, concurrency/retained-byte quotas, expiry, and receive leases;
- a closed LOCAL/S3 quarantine-storage port plus immutable provider/bucket/key/object-version identity before horizontally scaled deployment; keep browser transfers server-mediated until a separate direct-upload protocol can preserve admission, byte, lease, and quota invariants;
- ✅ parameter-free media type, normalized filename, declared/actual size, and shallow PDF-envelope enforcement before and during fixed-memory streaming;
- ✅ exclusive private quarantine finalization, server-computed SHA-256 custody digest, safe failure states, status reconciliation, and document-only Inbox presentation;
- ✅ bounded background expiry, abandoned-lease, missing-job, and durable attempt-object cleanup reconciliation;
- ✅ fail-closed raw-stream client contract for an isolated malware scanner and structural PDF validator;
- ✅ fenced validation leases, heartbeats, retries, dead-letter state, immutable attestations, and explicit atomic `READY`/rejection transitions;
- ✅ standalone dependency-free validator service with hostile-request bounds, private temporary custody, ClamAV/qpdf subprocess wrappers, authenticated readiness, definition freshness, and redacted structured telemetry;
- ✅ reference non-root/read-only validator container plus private ClamAV network, persistent signature volume, loopback-only development ingress, resource ceilings, and production release checklist;
- ✅ fail-closed raw-stream client contract and standalone dependency-free Poppler service for deterministic embedded text, with an exact closed readiness identity (`policyVersion`, independently expected `toolchainDigest`, `poppler` engine/version), strict request/result bounds, shell-free subprocess wrappers, private temporary custody, redacted telemetry, and process-tree deadlines;
- ✅ accepted-validation-to-extraction handoff, database-owned lease time, fenced leases/heartbeats, exact input re-verification, no-attempt-cost rewind when explicit pre-admission busy wins the readiness race, deterministic unsupported/resource-limit dead letters, bounded transient retries, and immutable extraction manifests plus page/paragraph chunks;
- ✅ tenant/document/asset/job/attempt/attestation binding and deferred database aggregate checks for contiguous chunk sequences, byte totals, locator identity, and explicit `NO_TEXT` generations;
- ✅ reference non-root/read-only/no-egress extractor container topology with bounded temporary storage/resources, concurrency one, single-use shutdown after one admitted request, `restart: always`, loopback-only development ingress, and a production release checklist;
- build, scan, sign or measure, pin by immutable digest, deploy, and operate those workloads on the target platform with private HTTPS/workload identity, alerts, and recovery drills; the service's self-reported digest detects deployment drift but is not cryptographic proof;
- replace the reference extractor process boundary in production with a new disposable container or microVM per request using distinct mount, PID, and user namespaces; single-use/restart is only an immediate mitigation for the shared-UID risk;
- tenant-safe physical deduplication after trusted-content and information-leak rules are defined;
- ✅ explicit, idempotent, optimistic validated-document-to-existing-visible-`WorkspacePaper` linking with conflict denial, provenance, and audit custody;
- ✅ bounded, authorization-checked Reader API/UI that serves only the linked document's current accepted validation/current-policy extraction generation and reports unavailable, processing, and no-text without stale fallback;
- ✅ one shared fail-closed validation/extraction authority for Reader, bootstrap, and direct upload status, including private-project visibility, exact durable job counters, generation custody, and compact database-admitted manifest integrity;
- ✅ durable Inbox link/extraction status with polling while validation or extraction is active;
- ✅ immutable one-to-one manifest admissions created by deferred PostgreSQL verification, exact historical backfill, user/workspace/paper-bound HMAC cursors, at-most-101-row keyset reads, stale-generation restart handling, compact batch bootstrap/status projection, and atomic user/workspace/trusted-IP Reader quotas;
- isolated OCR, section, and figure processing generations after embedded-text serving is production-proven;
- ✅ sanitized Zotero attachment discovery, optimistic `DISABLED`/`MANUAL` policy, explicit one-file idempotency, effective file-permission checks, source/credential/policy-generation fencing, allowlisted credential-stripped redirect handling, provider MD5/size/PDF identity, attempt-specific quarantine, immutable receipt, and shared validation/extraction lifecycle;
- ✅ attachment retry semantics that preserve immutable failed/cancelled attempts, coalesce active/attention/ready source generations, use database-authoritative leases, cap provider backoff, retain quota until exact cleanup proof, and continue cleanup after logical dead-letter;
- ✅ Sources accession-register UI with policy control, library/eligibility filters, paginated sanitized records, explicit import/retry, custody rail, and Inbox handoff;
- ✅ closed allowlisted crawler command and frozen authority graph covering rights, robots, host/path/query/port, public-address admission, hostname-verified pinned TLS, redirect rejection, shared origin pacing, response framing, byte/deadline bounds, private quarantine, immutable receipts, retries, cleanup, retained principals, and shared validation handoff;
- ✅ explicit crawler custody retirement with owner/admin or requester-member authorization, immediate Reader closure and raw-locator redaction, reload-safe exact idempotent retries, cross-process writer exclusion, immutable storage-authority generation binding, final/partial namespace absence proof before quota release, evidence-aware whole-generation text retention, truthful consent copy, and reciprocal terminal database guards;
- ✅ authenticated WebMCP metadata intake as a bounded, idempotent, optimistic proposal command with server-assigned `WEB_MCP` Inbox/provenance identity, exact retries, same-source conflict detection, no byte-custody side effects, strict snapshot decoding, and generic-filing denial;
- ✅ digest-bound WebMCP human approval with complete assertion disclosure, exact OpenAlex singleton verification, provider-only canonical metadata/identifiers, explicit canonical duplicate/project decisions, fresh visibility/version checks, metadata-only custody, strict client response binding, and a retained trigger-guarded approval graph;
- direct MCP proposal authorization through a separate narrow capability-token boundary; never reuse cookie/origin handlers as bearer-token APIs and never let a proposal approve itself or assert custody;
- ✅ evidence passage capture directly from authoritative Reader chunks, with exact manifest/chunk/hash/locator identity, zero-based end-exclusive UTF-8 boundaries, server reconstruction, 50,000-byte public limit, idempotent optimistic writes, immutable anchors, provenance, and source-currentness projection;
- ✅ explicit immutable `verify` and `reanchor` successors with one-successor race protection, strict service chronology, dynamic replay hydration, visible-membership inheritance, source-retrieval preservation for review, current-Reader reconstruction for re-anchor, head-only project/collection projections, and a revision-ledger/review-folio UI;
- broader document retry/dead-letter operator controls and recovery UI.

Exit criteria:

- ✅ oversized, size-mismatched, malformed-envelope, cross-tenant, and stale-session transfers remain quarantined/rejected without creating a paper, text, or Reader control; only a valid stored transfer creates its deduplicated validation job;
- ✅ metadata and quarantined bytes never unlock Reader; the fenced promotion transaction is the only component that may move an asset/document pair to `READY`;
- ✅ the application streams untrusted PDFs only to the external validation boundary and never parses them in the web process; production exit still requires deploying the sandboxed validator implementation;
- ✅ every extracted chunk can point back to a verified asset hash, accepted validation attestation, extraction generation, page, and paragraph locator;
- ✅ only an explicit link to an existing visible workspace paper can expose a current, accepted, authoritative extraction generation through the bounded Reader API/UI; missing, active, no-text, and unavailable states never fall back to stale text;
- ✅ every bounded Reader page requires the exact database-admitted generation, cannot cross generations through a continuation, remains under the 100-chunk/800-KiB response ceilings, and is admitted through authenticated shared quotas; bootstrap and upload polling fetch no text;
- ✅ Zotero metadata sync alone never copies bytes; every stored-PDF import requires an enabled policy plus an explicit user command, and no credential, signed URL, private locator, or raw provider error crosses the public/job/receipt/audit contracts;
- ✅ WebMCP proposal JSON cannot assert tenant, actor, source, status, storage, document, receipt, job, validation, extraction, or Reader authority; a candidate PDF URL remains metadata with `hasFullText: false`, stored snapshots fail closed on authority drift, generic filing is denied, and private-project dedupe remains undisclosed;
- the production extractor runs each request in a new disposable container or microVM with distinct mount, PID, and user namespaces over private HTTPS/workload identity, backed by signed or measured immutable release provenance;
- ✅ crawler fetches are bounded by explicit host/path/query/port, robots, all-public DNS, pinned hostname-verified sockets, shared origin rate, response framing, byte/deadline, redirect, quarantine, receipt, lease, retry, cleanup, and frozen-policy controls; production exit still requires a reviewed public-origin adversarial exercise under the deployment runtime role and storage topology.
- ✅ confirmed crawler custody retirement cannot release quota against the wrong storage generation, race a late writer, reactivate Reader through child-table mutation, or imply whole-record erasure; production exit still requires backup/snapshot retention policy and an adversarial deletion drill on the deployed storage backend.

Next implementation order:

1. Build, scan, sign or measure, pin, and deploy validator/ClamAV plus a per-request disposable Poppler extraction workload on the target platform; add private workload identity, worker health/dead-letter operations controls, alerts, and recovery drills.
2. Exercise the attachment worker against a deployment-owned Zotero application and reviewed current blob destinations; add worker health/dead-letter operator controls and cleanup alerts.
3. Add immutable storage-provider/bucket/key/object-version identity and a closed LOCAL/S3 quarantine port, then implement exact-version server-mediated S3 operations before horizontal scaling.
4. Add an append-only WebMCP duplicate-refresh successor so a newly canonized identifier race can produce a new explicit review without rewriting the original proposal or silently changing `create_new` to `use_existing`.
5. ✅ Add the rolling-compatible retained-audit-principal expand phase and dual-write WebMCP Inbox/provenance/approval/audit identity. Next, run the strict legacy-graph backfill and principal-only contract migration before enabling account erasure; generic Better Auth organization deletion remains disabled until the application-owned external-storage/credential erasure workflow exists.
6. ✅ Turn provider verification into a short-lived one-use review challenge whose final schema-v2 human command binds the exact evidence digest and random capability. Preparation verifies outside the transaction; final consent performs no provider I/O and atomically consumes a database-guarded retained challenge. Staging snapshot v2, domain-separated hashing, code-point canonicalization, and the retained unversioned-v1 decoder are complete.
7. ✅ Add the allowlisted crawler command/policy/worker/receipt path and explicit custody-retirement workflow; the first mode is limited to one explicit query-free HTTPS PDF on port 443 with an indefinite-custody rights grant, bounded all-public DNS, hostname-verified pinned connections, strict redirect rejection, shared origin pacing, private quarantine, attempt-specific receipts, exact cleanup proof, storage-generation-bound deletion, and evidence-aware retention. Next, deploy it behind reviewed production values and exercise the full denial/retry/deletion-race matrix against controlled public origins and the deployment storage backend before enabling it for users.
8. Add a direct MCP proposal scope through a separate capability-token authorization boundary; retain human review and keep remote acquisition as a separately approved command.
9. Add OCR/section/figure generations only after the embedded-text and successor-revision paths are production-proven.

## Loop 6 — source-grounded evidence and collaboration

Goal: make the live Reader/evidence workflow as complete as the demo, then make it safely collaborative.

Status: structured evidence/collection commands, the verified live Reader, exact authoritative passage capture, immutable review/re-anchor successors, visible revision history, and collaborative workspace access v1 are implemented. The collaboration slice includes invitation decisions, workspace switching, owner/admin/member/viewer authority, manager rosters, private-project removal preflight, optimistic/idempotent mutations, retained audit principals, and database owner guards. Saved review views, exports, comment/mention activity, ownership transfer, and richer real-time collaboration remain.

Build:

- ✅ structured evidence fields: title, claim, excerpt, interpretation, open question, confidence, verification state, tags, and source locator;
- ✅ Reader passage selection that creates evidence bound to the authoritative extraction generation, admitted manifest, exact UTF-8 quote range, and page/paragraph locator;
- ✅ evidence revisions/supersession rather than destructive history loss: verify preserves source custody, re-anchor binds a fresh admitted Reader selection, durable replays remain lineage-current, the Notes ledger exposes visible history, and stale/delayed client responses cannot create a second head;
- ✅ project collection creation and replay-safe paper/evidence filing;
- saved review views;
- ✅ owner/admin/member/viewer permissions with verified-email production admission, invitation inbox/decisions, workspace switching, manager rosters, role changes, removal preflight, and owner protection;
- durable invitation-email outbox delivery with provider idempotency and retry/dead-letter operations; until then invitations are intentionally labeled and delivered only in-app;
- ✅ project/evidence optimistic versions and grounded-capture conflict/reselection UI;
- comment/mention/activity feed with notification preferences;
- exports to BibTeX/RIS/CSL-JSON and evidence tables;
- optional Zotero note write-back only after three-way merge/conflict handling exists.

Exit criteria:

- a collaborator cannot mutate outside their role;
- simultaneous edits never silently overwrite another author;
- every exported claim retains source and locator;
- rejected/superseded evidence remains auditable.

## Loop 7 — production reliability, privacy, and evaluation

Goal: operate PaperPilot as a service rather than a long-running prototype.

Build:

- managed worker queue, concurrency controls, retries, dead letters, and job leases;
- structured logs with request/job/sync IDs and credential/content redaction;
- metrics, traces, SLOs, provider health, alerts, and operator runbooks;
- database/object-store backups plus tested restore procedures;
- secret/key rotation and connector re-encryption;
- retention/export/delete controls and privacy documentation;
- dependency/SBOM/scanning process;
- accessibility audit and keyboard/screen-reader regression suite;
- research-quality evaluation against real systematic-review and evidence-mapping tasks.

Candidate service objectives:

- authenticated workspace API availability ≥ 99.9%;
- p95 workspace reads < 500 ms excluding external-provider latency;
- p95 project mutations < 750 ms;
- ≥ 99.5% successful cursor-safe Zotero sync runs excluding revoked credentials;
- zero cursor advances after partial sync failures;
- zero cross-tenant data disclosures;
- 100% of evidence exports with source ID and locator completeness where the document supports locators.

## Long-term product measures

- time from first query to first project-worthy paper;
- fraction of imports with stable identifier and complete provenance;
- duplicate resolution precision/recall;
- time from document ingestion to verified, citable Reader state;
- evidence notes with explicit excerpt, interpretation, confidence, and locator;
- unresolved sync/conflict age;
- researcher return rate to an active project;
- successful reproducibility audits by another workspace member.

## Deliberate non-goals

- scraping Google Scholar directly in violation of its access constraints;
- claiming scientific quality from citation count or provider relevance;
- showing a metadata landing page as if PaperPilot possesses full text;
- accepting a Zotero key before server-side encryption and revocation handling exist;
- broad, unaudited crawling;
- automatic two-way connector writes without conflict resolution and explicit user intent.
