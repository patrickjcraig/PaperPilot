# PaperPilot public WebMCP source

This directory is the authored source of the public `/webmcp/` vertical slice.
The repository-local `.paperpilot-pages/` directory is generated output and is
never hand-edited. `npm run webmcp:pages:build` deletes only that generated
directory and reconstructs it from this source plus lockfile-pinned vendor
assets.

## Module boundaries

| Module | Authority |
| --- | --- |
| `contracts.mjs` | Canonical document, anchor, graph, annotation, command, revision, digest, Undo/Redo, and six-tool registration contracts. |
| `workspace-patch.mjs` | Pure, closed canonical record patches, exact inverse/conflict checks, immutable source/structure guards, and independent Graphology/Map replay. Never a model-input format. |
| `pdf-viewer.mjs` | PDF.js lifecycle, continuous pages, text indexes, viewport/PDF transforms, page-owned selection geometry, and overlay targets. |
| `pdf-intake.mjs` | Bounded streamed PDF intake, cancellation, and sanitized download failures; no agent/network authority of its own. |
| `paper-analysis.mjs` | Browser-independent whole-paper indexing and explicitly unreviewed critical-idea candidates. |
| `presentation-layout.mjs` | Presentation-only graph positions and annotation-card order; never semantic state. |
| `browser-snapshot.mjs` | Version-3 patch-history recovery, fully validated version-2 migration, strict replay-receipt checks, and preserved version-1 saves. PDF bytes are excluded. |
| `mentor-contract.mjs` | Closed, bounded claim-level schema, source/graph coverage, citation safety, authority validation, and lossless legacy projection. |
| `mentor-review.mjs` | Typed seven-section claim/evidence view model, incomplete-reference notices, and human-only Save/Discard decisions. |
| `webmcp-observer.mjs` | Typed callback instrumentation and page-issued provenance targeting; no model-reasoning claim. |
| `activity-ledger.mjs` | Typed evidence-event creation, restore merge, bounds, and reader-facing formatting. |
| `accessibility-projection.mjs` | Typed Graphology/annotation facts shared by the accessible DOM outline and cards, with layout and geometry excluded. |
| `app.mjs` | Browser composition root: DOM wiring, PDF/graph renderer orchestration, and adapters between the pure modules. |

The strict JSDoc-typed seam modules are checked by `npm run typecheck:webmcp`.
All domain modules run in Node tests without a browser-global fixture. Browser
effects remain in the composition root and receive page-owned canonical facts;
untrusted WebMCP input never supplies paper identity or raw geometry.

## Reversible workspace history

Item 7's source implementation uses one transaction boundary for agent graph
edits, agent annotations, reader selection creation/removal, and human Undo/Redo.
`state.revisions` is an append-only ledger of deeply frozen canonical patches;
the Undo and Redo stacks retain original revision records, not full before/after
workspace snapshots. Temporary clones isolate a transaction and allow rollback,
but are not retained as history. Item 7's verified release is recorded in
`docs/release/WORKSPACE-REDUCER-ACCEPTANCE-2026-09-01.md`.

- A patch operation is exactly `{ op, key, before, after }`, with explicit `null`
  for an absent endpoint. `put_node`, `put_edge`, and `put_annotation` retain exact
  canonical records, including lifecycle metadata, while excluding layout fields.
- Trusted `put_anchor` supports Undo of a new reader selection: the anchor,
  annotation, node, and provenance edge disappear together, and Redo reinstalls
  the original immutable evidence. It cannot rewrite an existing anchor or remove
  protected structural anchors. WebMCP receives no raw patch/geometry authority.
- Tombstoning a node includes its active incident edges. Explicit `restore_node`
  restores only the node; human Undo restores exactly the records changed by the
  original patch, leaving independently tombstoned edges untouched.
- Undo and Redo append human compensating revisions with `relatedRevisionId` and
  reproduce the expected semantic digests. A divergent edit clears only the Redo
  stack. Current digest, exact record, topology, and structural conflicts fail as
  atomic no-ops.
- The ledger has a 200-entry ceiling, including compensating revisions. New edits
  and Redo reserve capacity to Undo every remaining applied revision; reaching
  capacity rejects further work without silently compacting history.
- Required projection or pre-commit failures restore semantic state, both stacks,
  revisions, replay receipts, and events together. Success activity is published
  only after required projection succeeds. Optional observer/storage failure does
  not misreport an actually committed edit as rejected.

## Document-scoped WebMCP lifecycle

The six closed input/result schemas in `contracts.mjs` are the executable wire
contract. Registration and execution have separate AbortSignal lifetimes. A
suite becomes callable only after all six registrations succeed; disposing it
closes retained callbacks immediately and aborts native registrations. A settled
registration failure permits an explicit retry; manual Dispose asks for reload.
Cancellation while a native registration is
still pending locks further registration until a page reload, including after
switching PDFs, so old and new same-name registrations cannot overlap.

Input is synchronously captured as bounded, detached plain JSON before observer
hooks or queue waits. Accessors, executable objects, cyclic/sparse structures,
foreign paper identities, unsafe fields and over-budget data are rejected. The
document queue checks cancellation on entry and before commit. Failed required
projections roll back; cancellation or optional observer failure after a real
commit cannot relabel the edit as rejected. Read results must validate before
success receipts are published. Recent activity retains at most 500 events,
independently of the complete bounded revision ledger.

`stage_explain` requires fresh successful focus and graph reads at the current
workspace revision, then rechecks focus before committing its unsaved proposal.
Prefer `explanationVersion: 2`: all seven sections contain claim arrays with
explicit authority and per-claim `anchorIds`, `graphEntityKeys`, and `citationIds`.
Every declared source has one `sourceCoverage` entry (used or insufficient), and
every graph reference has one explained/related/questioned `graphCoverage` entry.
Only graph items returned in the latest bounded read can be cited. Each claim is
at most 800 Unicode scalar values; limits are five claims per section, 28 total,
12 sources, 20 graph items, eight external citations, and 32 KiB per input.
External citations are public HTTPS links explicitly declared by the agent and
not verified by PaperPilot; no citation fetch occurs. Legacy seven-string inputs
remain accepted and saved notes retain exact prose, visibly **Legacy · unclassified**.
Missing or removed saved references remain visible and non-navigable, not silently
dropped or replaced. See the executable schemas in `mentor-contract.mjs` and
the full versioned contract in `docs/hackathon-build/spec.md`.

Visual regions remain `locator_only` with
`pixelUseVerified: false`: a human diagnostic trial cannot establish that the
agent consumed arbitrary PDF pixels.

Regression coverage includes `webmcp-boundary.test.mjs`,
`webmcp-lifecycle.test.mjs`, `webmcp-app-lifecycle.test.mjs` and
`webmcp-observer.test.mjs`. The app tests execute extracted production handlers,
including late registration, disposal during mount, paper replacement, queued
cancellation, stale callbacks and truthful post-commit activity.

## Browser-local recovery

New saves use `paperpilot:webmcp:v3:<documentSha256>` with a closed, checksummed
4 MiB envelope. It stores the current workspace once, canonical patch history,
the revision ledger, replay receipts, bounded recent events, human-saved
explanations, and presentation preferences. Source anchors and revision records
stay deeply immutable after restoration. PDF bytes and unsaved explanation/read
receipts are not restored; the reader must reupload the byte-identical PDF.

The loader tries version 3 first. Only an absent version-3 key permits reading
version 2; invalid version 3 never silently falls back. Before migrating version
2, it validates its checksum, every retained workspace state, structural/source
invariants, Undo/Redo chain, and replay receipts. It derives patches for retained
steps but does not invent a complete historical ledger or original command
reasons. The original version-2 bytes remain untouched; a later save writes a
separate version-3 copy. Candidate-only version-1 saves remain preserved without
hydration or overwrite.

Save and restore are bound to the active document/session and canonical transaction
queue. Late work cannot save or hydrate another paper, and an older completion
cannot mark newer edits saved. Quota/validation failures preserve live work and
the previous valid stored copy while visibly reporting that current work is unsaved.

Explicit, twice-confirmed **Clear saved copy** removes only the current PDF's
known v1/v2/v3 keys, with legacy keys removed before v3. Pending autosaves are
cancelled, other papers and unknown future keys are untouched, and partial
storage failure is reported. The active paper remains open and can be saved again.
Load/migration/Save alone never delete the older versions.

Reuploading identical bytes under a new filename refreshes the trusted paper-root
display title after validation and recomputes affected digest endpoints. Old-basis
success receipts become `{ commandDigest, result: null }` tombstones. The old
idempotency key stays reserved: repeating the same command reports
`idempotency_replay_unavailable`, while different content still conflicts. The
recovery notice asks for a fresh read and a new key for a new intent. Version-2
receipts whose original revisions cannot be recovered get the same protection;
forged or inconsistent receipts reject restore.

The reducer and recovery behavior are covered by `workspace-patch.test.mjs`,
`workspace-reducer.test.mjs`, `contracts.test.mjs`, and
`browser-snapshot.test.mjs`. Release proof and checklist verification remain
separate gates.

## Release hardening boundaries

The published intake limit is **25 MiB and 200 pages**. Canvas backing stores are
bounded without moving text or source geometry; page and whole-document text
indexes have separate resource ceilings and honest visual-only fallback. The
explicit Attention demo downloads a pinned v7 URL and checks its recorded size
and SHA-256 before opening. The public package never includes a paper PDF.

Keyboard region creation, exact-opener Cancel/Escape, direct region skip links,
associated error messages, reversible edits, and save/clear failures have focused
production-handler tests. These tests do not substitute for a human NVDA and
literal browser-chrome 200% zoom walkthrough at guided Verification Pause 3.

## Reproduce the Pages artifact

```powershell
npm ci --ignore-scripts
npm run typecheck:webmcp
npm run test:webmcp:contracts
npm run test:webmcp:pages
npm run webmcp:pages:build
$env:PAPERPILOT_WEBMCP_SPIKE_PORT = "4182"
npm run webmcp:pages:serve
```

Open `http://127.0.0.1:4182/webmcp/`. Add `?fixture` only when intentionally
running the ignored, exact-byte local paper fixture; the packaged public path
always starts at browser-local paper intake.

The Pages test packages twice and compares path, byte length, and SHA-256 for
every output file. It also rejects PDFs, source maps, environment files,
private-key containers, and common credential shapes. The original two-tool
release is preserved separately as **prior release evidence** in
`docs/release/WEBMCP-LIVE-PROOF.md`.
