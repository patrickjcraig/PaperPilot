# WebMCP metadata intake

PaperPilot's first WebMCP release is a metadata-proposal boundary, not a remote-document fetcher and not a direct bearer-token MCP server. It lets an authenticated workspace member stage a bounded bibliographic assertion for review while keeping discovery provenance separate from PDF byte custody.

## Implemented boundary

The same-origin endpoint is:

```text
POST /api/workspaces/{workspaceId}/integrations/webmcp/proposals
```

It requires:

- a valid PaperPilot browser session;
- an exact trusted mutation origin;
- current workspace membership with a mutating role;
- the shared user/workspace mutation budget;
- `Idempotency-Key` matching `clientOperationId` when the header is present;
- the current optimistic workspace `expectedVersion`; and
- a JSON body no larger than 64 KiB.

The accepted command is closed and versioned:

```json
{
  "schemaVersion": 1,
  "clientOperationId": "proposal-018f...",
  "expectedVersion": 12,
  "proposal": {
    "title": "A source-grounded research paper",
    "authors": ["Ada Evidence", "Linus Provenance"],
    "year": 2026,
    "venue": "Journal of Verifiable Research",
    "publicationType": "journal article",
    "abstract": "Optional bounded abstract text.",
    "identifiers": [
      { "scheme": "doi", "value": "10.5555/example.2026" }
    ],
    "sourcePageUrl": "https://repository.example.org/papers/example-2026",
    "candidatePdfUrl": "https://repository.example.org/papers/example-2026.pdf",
    "isOpenAccess": true,
    "license": "CC-BY-4.0",
    "version": "published-version"
  }
}
```

The optional identifier schemes are `doi`, `arxiv`, `isbn`, and `provider`. DOI, arXiv, and ISBN values are normalized, and duplicate normalized identifiers are collapsed. URLs must be canonical, credential-free HTTPS URLs on an eligible public DNS name. Fragments, IP literals, local/internal-style hostnames, ambiguous encoded paths, and common credential-bearing query keys are rejected.

The server—not the proposal—assigns:

- workspace and actor identity;
- `InboxEntry.source = WEB_MCP`;
- `ProvenanceRecord.kind = WEB_MCP`;
- provider name and retrieval time;
- the provenance access method;
- proposal and provenance IDs;
- Inbox status and duplicate disposition; and
- audit/idempotency state.

Unknown fields fail closed. In particular, callers cannot supply organization, workspace, user, role, project, source kind, provenance kind, access method, status, document, asset, storage, checksum, intake, receipt, job, validation, extraction, or Reader authority.

## Exact effects

On a new accepted proposal, one serializable transaction:

1. re-authorizes membership and mutation role;
2. checks the tenant-local idempotency receipt and workspace version;
3. deduplicates by normalized scholarly identifier or canonical source identity;
4. advances the workspace revision;
5. creates one pending or duplicate-review `InboxEntry`;
6. creates one append-only `WEB_MCP` provenance record;
7. stores a completed idempotency receipt; and
8. appends a bounded audit event.

An exact retry replays the original result. Reusing the operation ID for changed intent conflicts. A new operation proposing the exact same normalized source and intent is a no-op and does not advance the workspace revision. Reusing a source-page identity with different metadata fails as an explicit proposal conflict; the older snapshot is never silently overwritten.

The proposal creates no:

- `ImportBatch`;
- canonical `Paper` or `WorkspacePaper`;
- `Document` or `Asset`;
- `DocumentIntake` or ingress attempt;
- ingest receipt;
- background job;
- validation or extraction claim; or
- Reader authority.

`candidatePdfUrl` is only an untrusted metadata assertion. Even when present, the projected paper has `hasFullText: false`.

## Human-reviewed convergence

```text
WebMCP metadata proposal
        │
        ▼
reviewable WEB_MCP Inbox entry
        │ digest-bound reviewed approval
        ▼
provider-verified identifiers + explicit duplicate decision
        │
        ▼
canonical Paper / visible WorkspacePaper

authenticated raw PDF upload
        │ quarantine → validation → extraction
        ▼
validated BROWSER_UPLOAD document
        │ explicit visible-paper link
        ▼
Reader-authorized paper/document pair
```

Both metadata transitions above are implemented. The generic Inbox filing command still deliberately rejects `WEB_MCP` entries. Promotion uses two noun routes. Preparation first verifies and freezes the exact review dossier:

```text
POST /api/workspaces/{workspaceId}/integrations/webmcp/proposals/{inboxEntryId}/approval-challenges
```

The 16-KiB closed preparation command binds every choice that affects the eventual promotion:

```json
{
  "schemaVersion": 1,
  "expectedVersion": 13,
  "inboxEntryId": "cm...",
  "proposalDigest": "64 lowercase SHA-256 characters",
  "destinationProjectId": "cm...",
  "duplicateDecision": { "kind": "create_new" }
}
```

After independently verifying that intent, PaperPilot persists and returns a five-minute, one-use 256-bit random challenge. Its evidence dossier contains the exact closed authority snapshot, authority version, and evidence digest that the reviewer must see. Final consent is then submitted to:

```text
POST /api/workspaces/{workspaceId}/integrations/webmcp/proposals/{inboxEntryId}/approval
```

The final 16-KiB command repeats the full intent and binds both the opaque challenge capability and the displayed evidence digest:

```json
{
  "schemaVersion": 2,
  "clientOperationId": "approval-018f...",
  "expectedVersion": 13,
  "inboxEntryId": "cm...",
  "proposalDigest": "64 lowercase SHA-256 characters",
  "destinationProjectId": "cm...",
  "duplicateDecision": { "kind": "create_new" },
  "challengeId": "43-character base64url capability",
  "evidenceDigest": "64 lowercase SHA-256 characters"
}
```

If staging found an exact visible canonical match, the only eligible decision is instead:

```json
{
  "kind": "use_existing",
  "canonicalPaperId": "the exact server-staged candidate"
}
```

The Inbox renders a dedicated source dossier before this command can run. It discloses the full staged title, authors, venue, year, type, abstract, identifiers, source origin, access/license/version assertions, candidate PDF location, immutable digest, destination project, and—when present—a custody-free canonical comparison. The reviewer must explicitly acknowledge the constrained duplicate disposition. A changed digest or candidate identity clears that acknowledgement.

The browser now mirrors the server's two-step boundary rather than offering a one-click approval. **Prepare authority evidence** sends only the exact schema-v1 intent and never sends an idempotency key. The returned challenge is accepted only through a closed client decoder that recomputes the canonical authority-snapshot SHA-256 before admission; the Inbox then shows its exact authority name/version, full evidence digest, canonical expiry timestamp, and complete read-only authority snapshot. Final consent stays disabled until the reviewer checks the acknowledgement for that exact challenge. PaperPilot constructs the schema-v2 command once and retains both its operation ID and serialized body; if the final response times out, stalls, is malformed, or the connection fails, **Retry exact approval attempt** reuses those bytes and never prepares replacement evidence. A known expiry, revision conflict, changed proposal/project/duplicate intent, or closed final failure clears the challenge and requires fresh evidence and fresh consent.

Preparation performs the exact singleton OpenAlex lookup outside a database transaction for a normalized DOI or OpenAlex work ID. The verifier is fixed to `https://api.openalex.org/works/{id}`, sends the server-only key as a bearer token, permits only bounded same-origin work redirects, enforces an absolute deadline and a 2-MiB JSON limit, and checks identifier, title, year, and supplied-author coherence. It emits a closed evidence snapshot containing only provider-derived canonical metadata. A short serializable persistence transaction then repeats membership, visibility, revision, staged digest, project, and duplicate checks before storing the challenge. The current OpenAlex API key may be supplied as `OPENALEX_API_KEY`.

Final consent performs no provider I/O. One serializable transaction checks the completed idempotency receipt first (so an exact retry remains safe after consumption), then repeats membership/role, workspace-version, project visibility, Inbox visibility, status, digest, staged-provenance, duplicate-decision, current canonical-identifier, challenge actor, expiry, one-use state, and every challenge intent/evidence binding. It atomically consumes the challenge and then:

1. creates a canonical `Paper` from the verified provider snapshot, or selects the exact staged canonical paper;
2. creates/reuses the tenant's `WorkspacePaper` and exact `ProjectPaper` edge;
3. marks the Inbox proposal imported without changing its reviewed payload;
4. inserts one retained `WebMcpProposalApproval` authority row linked to that exact challenge;
5. appends provider `METADATA` provenance when OpenAlex supplied the canonical record;
6. appends approval-bound `IMPORT` provenance, audit state, and the completed idempotency receipt; and
7. advances the workspace revision exactly once.

Provider verification never copies an unsupported or merely agent-asserted identifier. A proposal containing identifiers must have a supported DOI/OpenAlex claim and pass provider verification; extra ISBN/arXiv/provider assertions are not promoted. An identifier-free proposal may be human-approved, but it creates an identifier-free canonical record. `use_existing` never appends the proposal's metadata or identifiers to the canonical paper. If verified identifiers now belong to another canonical record, `create_new` fails as a duplicate rather than silently changing the reviewer's decision.

PostgreSQL independently guards the retained graph: a challenge is immutable except for its one-way consumption timestamp; a consumed challenge requires its exact retained approval at deferred commit; every new approval must be command schema v2 and exactly reproduce its challenge actor, Inbox, digest, project, revision, duplicate decision, authority version, evidence digest, snapshot, and consumption time; approval rows and staged WebMCP identity/provenance cannot be updated; one staged authority is permitted per Inbox proposal; an imported WebMCP Inbox row requires exactly one matching approval at deferred commit; the canonical `WorkspacePaper`, exact `ProjectPaper`, metadata-only `documentId`, and exact retained `IMPORT`/`METADATA` provenance set are cross-checked; retained approval/provenance/challenge cannot be delete-and-reinserted; and tenant-erasure remains possible only when the transaction removes the retained proposal graph together.

The route cutover is intentionally fail closed. A schema-v1 approval body can never create new state. PaperPilot decodes v1 only long enough to locate an exact, completed pre-cutover idempotency receipt for the same actor, command, and request hash; that historical stored response remains replayable. A missing, unresolved, or changed v1 request receives `webmcp_approval_challenge_required` and must restart at preparation. Historical approval rows retain command schema v1 and a null challenge link; the migration does not rewrite their evidence or stored responses.

Production must use a non-login migration owner and a separate non-owner runtime role. The runtime role must not own tables or functions and must not receive DDL, `BYPASSRLS`, trigger-disabling, or `session_replication_role` authority. Trigger checks prove internal graph consistency, not that arbitrary SQL came from a browser user or OpenAlex; narrowly scoped grants, reviewed write procedures, deployment permission tests, and database-enforced tenant isolation remain required before treating compromise of the runtime credential as contained.

The account-erasure cutover now has a backward-compatible expand phase. Each WebMCP stage/no-op and approval resolves one random, tenant-scoped `RetainedAuditPrincipal`, locks it against concurrent account detachment, and dual-writes that principal across Inbox, provenance, approval, and audit authority. The principal stores no profile data, and composite foreign keys reject cross-tenant injection or principal deletion beneath retained authority. Database guards additionally require every non-null principal written during expand to be live, tenant-bound, and mapped to the adjacent legacy actor. A principal can be inserted only as an unpseudonymized live mapping; callers cannot detach it or choose an erasure timestamp. Only the `User` foreign-key deletion path can clear `liveUserId`, and that path stamps `pseudonymizedAt` with the database's `clock_timestamp()`.

The staged `WEB_MCP` provenance principal must equal its Inbox creator principal. The approval principal independently maps to `approvedById`, while approval-bound `IMPORT` and `METADATA` provenance must equal that reviewer principal; the stager and reviewer are deliberately allowed to be different people. The WebMCP Inbox identity trigger now treats `createdByPrincipalId` as immutable, and retained AuditEvent authority cannot be stripped after it is established. Null principal writes remain accepted for old application nodes during the rolling expand deployment; installing the migration refuses any pre-existing non-null mismatch. References to a principal remain valid after legitimate account erasure, when the legacy actor has been nulled and the random principal has become pseudonymous.

Legacy live-`User` actor columns intentionally remain during this rolling-compatible phase: an approved proposal's restrictive legacy approval FK blocks deletion, and authority provenance still has immutable legacy actor fields. PaperPilot therefore explicitly disables Better Auth self-service account deletion throughout expand/backfill; it does not rely on those mixed FK behaviors as an erasure policy. Deletion stays disabled until strict mapping verification and a principal-only contract migration replace every legacy WebMCP actor dependency. Better Auth's generic organization deletion is also disabled until an application-owned two-phase erasure workflow can remove external bytes/credentials and the complete retained tenant graph.

Cross-tenant canonical previews are suppressed unless the global paper was established by an allowlisted public metadata authority (`OPENALEX`, `CROSSREF`, `PUBMED`, `ARXIV`, or `SEMANTIC_SCHOLAR`). This prevents a guessed identifier from exposing bibliographic metadata created by another tenant's upload, manual record, or WebMCP proposal.

Discovery provenance remains WebMCP. If the user later uploads a PDF, its physical custody remains `BROWSER_UPLOAD`; the application never relabels those bytes as WebMCP merely because the metadata began with an agent proposal.

Retained staging snapshots now have two permanent wire contracts. Historical v1 is the exact unversioned `{ paper, provenance }` payload emitted before snapshot versioning; it remains readable and continues to verify against its original unprefixed SHA-256. Newly staged v2 payloads include top-level `schemaVersion: 2` and use SHA-256 over the NUL-terminated `paperpilot:webmcp:staging-snapshot:v2` domain followed by canonical JSON. Canonical object keys are ordered lexicographically by Unicode code point, never by process locale or UTF-16 code-unit order. The decoders preserve the admitted v1/v2 URL, identifier, shape, custody, and source relationships without invoking the evolvable proposal-command parser. Missing version maps only to the exact historical v1 shape; explicit v1, malformed, and unknown future versions fail closed.

No database backfill is required: the already-retained unversioned shape is the v1 discriminator and its stored provenance digest is unchanged. Rewriting those rows merely to add a field would change their authority digest and is deliberately forbidden. The first new proposal after deployment persists v2 in both the Inbox payload and its matching retained provenance payload.

## What is deliberately not implemented

These endpoints are browser-session mediated. A direct MCP client cannot reuse the cookie/origin handler as a bearer-token API. A future direct tool boundary needs separate issuer, audience, subject, expiry, token-ID, dynamic-membership, workspace-capability, and narrow-scope checks. The initial direct scope should permit proposals only; it must not permit self-approval, remote PDF fetch, linking, custody claims, or Reader activation.

An append-only duplicate-refresh successor is also still required for one race: a proposal may stage with no visible duplicate, then independently verified identifiers may become canonical in another transaction before approval. PaperPilot safely rejects `create_new`, but the immutable original proposal cannot yet acquire the newly verified duplicate candidate for a second human decision. It never silently switches to `use_existing`; operator/user recovery for that race is a subsequent workflow slice.

PaperPilot also does not fetch either submitted URL in this release. The shared URL module performs lexical normalization and public-address classification for future work, but it does not itself resolve DNS, pin a socket destination, evaluate rights or robots policy, follow redirects, or download bytes.

## Governed crawler release gates

Remote acquisition is a separate command and policy lifecycle. Its minimum safe first mode is one explicit, query-free HTTPS PDF URL on port 443 under an allowlisted origin/path. Before enabling it, PaperPilot must add:

- an immutable crawler command row bound to organization, human actor, normalized URL digest, policy revision, intake, document, asset, job, and idempotency key;
- an explicit rights grant that permits PaperPilot's retention behavior;
- robots, host/path, rate, byte, media, timeout, and redirect policy;
- bounded A/AAAA resolution in which every result is globally routable;
- a connection pinned to an approved address, with DNS and policy re-evaluated at every redirect;
- no ambient cookies, authorization, proxy credentials, or signed-query retention;
- an exact crawler ingress attempt and receipt binding enforced by PostgreSQL;
- private quarantine, server-observed size, and server-computed SHA-256;
- lifecycle projection for crawler Inbox state; and
- cleanup, dead-letter, quota-retention, observability, and recovery controls.

Finite-retention promises are not supported until deletion can reconcile evidence anchors and immutable extraction history honestly. The first crawler policy must therefore require rights compatible with indefinite PaperPilot custody, or reject the acquisition.

## Verification

Focused tests cover URL preflight, both closed command parsers, strict stored/read snapshot decoding, golden v1/v2 digest compatibility, Unicode code-point property ordering, pure source projection, tenant/role/project boundaries, replay and changed-intent conflicts, optimistic versions, source and canonical deduplication, bounded fixed-origin provider verification, provider/proposal mismatch, unverified-identifier exclusion, human identifier-free approval, absence of byte custody, provenance/audit identity, generic-filing rejection, cross-tenant private-metadata non-disclosure, and the retained PostgreSQL approval graph.

```powershell
npx tsx --conditions=react-server --test src/server/integrations/web-source/url-policy.test.ts src/server/integrations/webmcp/approval-contract.test.ts src/server/integrations/webmcp/intake-contract.test.ts src/server/integrations/webmcp/intake-service.test.ts src/server/integrations/webmcp/openalex-verifier.test.ts src/server/workspaces/import-dto.test.ts
npx tsx --env-file=.env --conditions=react-server --test --test-concurrency=1 src/server/audit/retained-principal.integration.test.ts src/server/integrations/webmcp/approval-service.integration.test.ts src/server/integrations/webmcp/intake-service.integration.test.ts src/server/workspaces/import-service.integration.test.ts
```
