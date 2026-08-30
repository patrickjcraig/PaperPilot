# Governed crawler custody deletion

PaperPilot retains a governed-crawler PDF under
`INDEFINITE_UNTIL_USER_DELETION`. This command retires one crawler request's
private PDF custody without reopening or rewriting its ingestion evidence.

## HTTP contract

`POST /api/workspaces/:workspaceId/integrations/crawler/requests/:crawlerImportId/custody`

The request must be same-origin, authenticated, and include
`Idempotency-Key` equal to `clientOperationId`. The JSON body is closed and
limited to 4 KiB:

```json
{
  "schemaVersion": 1,
  "clientOperationId": "opaque-operation-id",
  "expectedVersion": 12,
  "crawlerImportId": "exact-path-resource-id",
  "confirmDeletion": true
}
```

An applied request returns HTTP 202; an exact durable replay returns HTTP 200:

```json
{
  "outcome": "applied",
  "aggregateVersion": 13,
  "request": {
    "id": "crawler-import-id",
    "clientOperationId": "original-import-operation-id",
    "displayFileName": "paper.pdf",
    "status": "DELETING",
    "policyVersion": "deployed-policy-version",
    "maxBytes": 10485760,
    "receivedBytes": 12345,
    "createdAt": "2026-08-29T12:00:00.000Z",
    "updatedAt": "2026-08-29T12:05:00.000Z",
    "retryAt": "2026-08-29T12:06:00.000Z",
    "completedAt": null,
    "failureCode": null,
    "canDeleteCustody": false
  }
}
```

`CrawlerRequestSummary` never projects tenant IDs, requester identity, a raw
URL or URL digest, storage keys/paths, worker identity, scanner details, or the
deletion proof digest.

Before transport, the browser freezes the exact URL-free JSON bytes and stores
one workspace-scoped recovery envelope in `sessionStorage`. An ambiguous
timeout, navigation, or reload therefore replays the same operation ID and body
instead of manufacturing a second destructive command. A definitive closed
PaperPilot response or a ledger row already in `DELETING`/`DELETED` clears that
envelope.

## Authorization and capability

The server independently authorizes every command. An owner or admin may
delete any retained crawler request in the workspace. A mutation-capable
member may delete only a request whose live `requestedById` is that member.
Read-only roles and member-to-member deletion are denied.

Every list, queue, and deletion response includes the server-derived,
identity-free `canDeleteCustody` boolean. It is true only for an authorized
caller while custody is `RETAINED`; it is false for `DELETING` and `DELETED`.
Clients must use this capability instead of inferring requester ownership.

## Lifecycle and proof

Accepting the command atomically:

1. locks the target's jobs before its crawler authority row;
2. cancels and fences queued/running work and active attempts;
3. redacts the raw URL from crawler, Document, Inbox, and crawl provenance;
4. archives the Document, rejects the Asset and Inbox projection, and closes
   Reader immediately;
5. records immutable deletion authority and schedules reconciliation; and
6. increments the workspace revision exactly once.

The governed crawler worker invokes
`reconcileCrawlerCustodyDeletion` before ordinary cleanup or new claims. It
waits for every old job/ingress lease, resolves the immutable storage-authority
generation recorded at ingress, acquires the storage-side deletion fence, and
idempotently removes and rescans final and partial objects for receiving,
written, abandoned, failed, and adopted attempts. A late writer cannot finalize
after the deletion tombstone exists. A busy writer, unavailable/wrong storage
generation, or removal failure leaves custody `DELETE_PENDING`, retains quota,
and schedules a bounded retry.

Each local quarantine root has an atomically installed authority marker whose
generation is derived from a random seed plus the canonical directory identity.
The first crawler claim freezes that generation on the crawler command, every
ingress attempt and its receipt. A worker mounted to a different root neither
claims the bound job nor treats `ENOENT` there as cleanup proof. Historical
rows without a generation remain deliberately unprovable; the migration stops
if an already-deleted root-unbound proof requires operator reconciliation.

The storage fence is a permanent, asset-specific tombstone in the stable
organization `assets` parent followed by an atomic same-parent rename of the
entire live asset directory into a deletion-owned namespace. A final link that
wins before the rename is captured and deleted; a link that loses the rename
cannot resolve its old partial/final paths. On Windows, an open handle that
prevents rename or unlink makes the reconciler retry. The deleter removes every
recognized final and partial object, removes detached namespaces, re-reads the
tombstone and root authority, then performs a second namespace scan before it
returns proof. The tombstone remains after proof and rejects delayed writers.

Only after writer exclusion and exact authoritative namespace-absence proof
does reconciliation mark the Asset `DELETED`, clear its physical
locator/hash/size, mark every ingress attempt's cleanup proof, release intake
quota, and project the crawler request as `DELETED`. The retained ledger
contains only a storage-generation-bound, domain-separated proof digest,
bounded counts/dispositions, timestamps, safe reason codes, and pseudonymous
audit authority. Deferred reciprocal database guards prevent later child-table
writes from reviving Reader, work, locators, ingress cleanup, or extracted text
behind that terminal state.

The local proof establishes removal of PaperPilot's authoritative final and
partial object names from the bound storage generation. It does not claim
secure media erasure or deletion from open file descriptors, hardlinks outside
the managed namespace, filesystem/storage snapshots, backups, or provider
retention. Those require an explicit deployment retention and restore policy.

## Derived text and retained evidence

The original private PDF bytes are always removed before quota release.
Machine-derived full-text generations and legacy chunks are also purged when
no user-authored evidence depends on them.

An immutable extraction generation is retained when either an
`EvidenceTextAnchor` references its manifest/chunks or an
`EvidenceNote.documentChunkId` references one of its chunks. The complete
generation remains because its manifest and chunk hashes are one integrity
unit. One grounded excerpt can therefore retain the paper's complete extracted
text generation, including chunks unrelated to that excerpt. Reader stays
closed after deletion, but that generation, the user's quote/note, and its
grounding proof may remain. The no-raw-locator crawler ledger records `NONE`,
`PURGED`, or `RETAINED_FOR_USER_EVIDENCE` plus purged and retained chunk counts.

## Safe public failures

Command problems use stable codes including
`invalid_crawler_deletion_command`, `idempotency_mismatch`,
`idempotency_conflict`, `version_conflict`,
`crawler_custody_delete_forbidden`, `crawler_custody_deletion_pending`, and
`crawler_custody_already_deleted`. A reconciliation retry is projected only as
`crawler_custody_deletion_retrying`; raw filesystem/database errors are never
returned.

Implementation entrypoints:

- route: `src/app/api/workspaces/[workspaceId]/integrations/crawler/requests/[crawlerImportId]/custody/route.ts`
- command parser: `src/server/integrations/web-source/crawler-deletion-command.ts`
- command/reconciler: `src/server/integrations/web-source/crawler-custody-deletion.ts`
- derived-text policy: `src/server/integrations/web-source/crawler-derived-text-policy.ts`
- local storage authority/fence: `src/server/uploads/storage.ts`
- worker: `src/workers/governed-crawler-worker.ts`
