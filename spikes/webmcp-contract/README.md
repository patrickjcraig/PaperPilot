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
| `paper-analysis.mjs` | Browser-independent whole-paper indexing and explicitly unreviewed critical-idea candidates. |
| `presentation-layout.mjs` | Presentation-only graph positions and annotation-card order; never semantic state. |
| `browser-snapshot.mjs` | Version-3 patch-history recovery, fully validated version-2 migration, strict replay-receipt checks, and preserved version-1 saves. PDF bytes are excluded. |
| `mentor-review.mjs` | Typed seven-section mentor view model and human-only Save/Discard decisions. |
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
but are not retained as history. These are implementation notes, not a claim that
the item or a deployed release has completed verification.

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
