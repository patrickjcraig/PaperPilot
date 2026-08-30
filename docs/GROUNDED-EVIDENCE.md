# Grounded evidence custody

PaperPilot treats an evidence excerpt as a durable research record, not as a
browser quotation. A grounded note is admitted only when PostgreSQL can
reconstruct the exact selected bytes from one immutable, already-admitted text
manifest and prove that every identity and locator agrees.

## Authority chain

```text
accepted PDF validation
  -> authoritative extraction generation
    -> immutable manifest admission
      -> contiguous ordered text chunks
        -> immutable evidence text anchor
          -> structured evidence note revision
```

The browser may identify a selection, but it is never authoritative for the
quote, page range, paragraph IDs, or source state. It submits only:

- the linked document, extraction, and manifest digest;
- start and end chunk IDs, sequence numbers, and content hashes;
- a zero-based UTF-8 start byte offset and end-exclusive UTF-8 end byte offset;
- a digest of the quote the researcher saw; and
- the researcher-authored claim, interpretation, optional question,
  confidence, tags, and explicit destination project/collections.

The service reloads the exact admitted generation, reads the complete
contiguous chunk range, slices UTF-8 bytes, joins chunk excerpts with the
canonical `\n\n` separator, and derives the quote and locators. A digest or
identity mismatch is a source-selection conflict; the service creates nothing.

## Database invariants

`EvidenceTextAnchor` is the compact version-one anchor format. One row binds a
contiguous selection to its exact manifest, endpoint chunks, byte offsets,
source hashes, reconstructed quote digest/text, and page/paragraph endpoints.
Composite tenant-aware foreign keys prevent a note, paper, document, manifest,
or chunk from being substituted across workspaces.

The database enforces all of the following at commit:

1. `groundingVersion` is absent for legacy/manual notes and equals `1` only
   when exactly one version-one anchor exists.
2. A grounded note names an explicit project that already contains the paper.
   Anchor insertion and later `ProjectPaper` mutation are both guarded, so a
   direct database write cannot forge or remove that canonical custody edge.
3. The source is one admitted `EXTRACTED` manifest and one contiguous range of
   at most the configured chunk bound.
4. UTF-8 offsets land on valid code-point boundaries and reconstruct a
   non-empty quote.
5. Endpoint IDs, sequence numbers, hashes, page/paragraph locators, note
   columns, quote text, and SHA-256 digest agree exactly.
6. Anchors and grounded note revisions are immutable. Corrections and
   re-anchoring create one non-branching successor revision for the same paper,
   project, and grounding format.
7. Source foreign keys use deferred `NO ACTION` semantics so source records
   cannot disappear underneath evidence. The anchor triggers allow a root
   tenant cascade to remove this custody subgraph; the broader tenant-erasure
   runbook still has to order audit/provenance retention records explicitly.

Application validation remains important for useful error messages and bounded
work, but the database is the final authority. Production must use a runtime
database role that cannot disable or replace these integrity triggers.

## Two independent states

Research review and source custody answer different questions and must never be
collapsed into one badge.

Research review status:

- `captured` — recorded but not yet reviewed;
- `needs-verification` — a manual assertion or note requiring researcher
  checking;
- `verified` — reviewed by a researcher.

Grounding source state:

- `current` — the anchor matches the document's current authoritative
  extraction;
- `superseded` — the historical anchor remains valid, but a newer
  authoritative extraction is current;
- `unresolvable` — PaperPilot cannot currently resolve the source through the
  live authority chain; and
- no grounding object — a manual or legacy note with no Reader anchor.

A source update does not reject a claim and does not mutate historical
evidence. The UI preserves the old revision, labels it as source-updated, and
offers an explicit re-anchor flow that creates a successor.

## Immutable review and re-anchor revisions

The live service exposes one authenticated successor command at
`POST /api/workspaces/{workspaceId}/evidence-notes/{noteId}/revisions`. Its
request is an exact, closed union:

- `verify` reviews the current `captured` head. It creates a new `verified`
  successor, preserves the quote, anchor, source generation, semantic fields,
  canonical paper/project custody, and source-retrieval metadata, and records
  review time in `reviewedAt` plus the append-only audit event. It does not
  pretend that review fetched or re-extracted the source.
- `reanchor` accepts a fresh current-Reader selection for a current `captured`
  or `verified` head. The server resolves that selection through the same
  admitted-manifest and byte-reconstruction path as first capture. It creates
  a new `captured` successor with fresh source custody while preserving the
  researcher-authored claim, interpretation, question, confidence, and tags.
  Because the source changed, review must be explicit again.

Neither action updates or deletes the predecessor or its anchor. A predecessor
may have only one successor. The service assigns a successor time strictly
after its predecessor even if the predecessor is future-dated; lineage edges,
not wall-clock sorting alone, remain the canonical order.

Every visible note carries a compact revision projection:

```text
rootId -> previousId? -> current id -> nextId?
revision number + isLatest
```

Workspace and project `notes` contain the visible audit history. Project and
collection note indexes and counts contain only current heads, so historical
records cannot reappear as actionable evidence. The Notes screen defaults to
heads and exposes a separate revision ledger. Its review folio repeats the
exact quote, claim, and interpretation before confirmation; source-updated
evidence requires re-anchoring from a new Reader selection rather than an
implicit source substitution.

Lineage is projected only from records the caller may see. If a shared
successor follows a predecessor that exists solely in another user's private
project, the visible chain is safely re-rooted and the hidden record ID is not
returned. Secondary private project or collection filings are not mutated by
an actor who cannot see them.

## Capture, revision, retry, and conflict behavior

Capture is an authenticated, optimistic, idempotent workspace command. The
client generates one `clientOperationId` for one researcher intent and reuses
it across uncertain network retries. Reusing the ID with different content is
an idempotency conflict. If the workspace revision changes, the UI refreshes
the aggregate version while preserving the draft and operation identity. If
the Reader generation changes, the UI preserves researcher fields but requires
a new source selection; it never silently re-anchors.

Review and re-anchor use the same durable operation-identity and optimistic
workspace-version rules. Receipts store stable identities rather than frozen
DTOs. Replays are re-authorized and rehydrated from one consistent database
snapshot, including current visible project/collection memberships and current
source state. Replaying an earlier A → B operation after B → C therefore
returns B as historical with `nextId: C`; it cannot roll the browser back or
create two apparent heads. A changed payload under the same operation ID is an
idempotency conflict, and a second successor attempt from a non-head is a
revision conflict.

Authorization precedes quota charging. The command verifies membership and
mutation role, resolves the canonical workspace ID, requires a visible project
containing the paper, and admits only visible collections belonging to that
project. Private project or collection IDs must not leak through evidence DTOs.

## Reader interaction

The live Reader exposes source identity on each authoritative chunk but keeps
ordinary text selection and copy behavior intact. A selected passage opens an
evidence docket connected to the source by the cobalt custody bracket. The
docket shows the server-untrusted preview, explicit project and optional
collection destinations, researcher fields, and save/conflict state.

Wide screens use a third rail, medium screens a side sheet, and narrow screens
a modal/full-height sheet. Keyboard users can capture a whole paragraph,
dismiss back to the originating passage, and receive selection/save changes
through a polite live region. Saving uses the server-returned quote and
locators, not the preview. Review and capture dialogs trap focus, preserve the
originating control for focus return, and cannot be dismissed after an
immutable write starts.

## Deliberate limits

Version one anchors one contiguous text selection. It does not claim OCR,
figure geometry, discontiguous quotations, semantic sentence identity, or an
unchanged external publication. Those require new explicitly versioned anchor
formats. Legacy/manual notes are never backfilled with invented custody.

PostgreSQL rejects backdated successors but permits equal direct-write
timestamps; the service is the stricter writer and always advances by at least
one millisecond. A hidden secondary private filing intentionally remains on the
predecessor until an authorized actor changes it, so “latest” is visibility and
filing-context aware at that boundary. These limits do not weaken the canonical
one-successor lineage or expose hidden IDs.
