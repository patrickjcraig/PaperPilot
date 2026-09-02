# Canonical workspace reducer — acceptance record

Date: 2026-09-01 (America/New_York). Guided build item 7.

## Scope and outcome

Graph edits, annotation edits, reader-created sources and reader removals share one serialized transaction and trusted revision finalizer. Live history is a canonical forward/inverse patch log, not whole-workspace snapshots. Undo and Redo append human compensating revisions while reproducing exact semantic workspace, graph and annotation digests.

Patches have closed explicit-null before/after records. They preserve stable identity, source binding, grounding, authority and lifecycle fields while excluding renderer coordinates and presentation. The trusted `put_anchor` extension makes a reader-created anchor, annotation, node and edge one reversible unit. It is never accepted from WebMCP input.

Node tombstones include their currently active incident edges. Explicit `restore_node` restores the node only; Human Undo restores exactly the records changed by that deletion, never unrelated previously tombstoned edges. Generated document structure and issued anchor geometry are protected.

The 200-entry ledger never silently discards reversible records. New edits and Redo reserve capacity for Undo. Explanations remain separate staged proposals with human Save/Discard.

## Recovery contract

- New storage key: `paperpilot:webmcp:v3:<documentSha256>`.
- Current state, Undo stack, Redo stack and append-only ledger are validated by replay on independent clones before hydration.
- Original applied retry receipts use the closed mutation schema and must match their retained revision. Different content under one key conflicts.
- Valid v2 snapshots migrate in memory only after the full structural/spatial/digest/chain validation. Their original storage bytes remain untouched; explicit Save creates v3. The migration does not invent lost historical ledger entries.
- V1 copies remain preserved without hydration. A corrupt v3 record never silently falls back to older state.
- Byte-identical renamed PDFs use the current trusted display title. Retry receipts whose historical digest basis can no longer be proved become `{commandDigest, result: null}` reserved-key tombstones. Same-key requests cannot duplicate work; a new intent requires a fresh read/new key. Existing events remain historical evidence.
- PDF bytes are not stored or rewritten. Browser recovery is not account synchronization or Supabase persistence.

## Automated verification

| Gate | Result |
| --- | --- |
| WebMCP/modules/PDF/reducer/recovery/UI | 399 / 399 |
| Root application tests | 701 / 701 |
| Reproducible/safe Pages packaging | 4 / 4 |
| Strict WebMCP checkJs and repository TypeScript | Pass |
| ESLint | Pass, no warnings |
| Optimized Next.js build | Pass |
| Local-database-write freeze | `local_database_write_frozen` |
| Whitespace check | Pass |

The focused suites include 21 patch tests, 20 reducer integration tests, 95 recovery tests and 4 production-handler UI tests. Coverage includes mixed apply/invert/reapply sequences, failed-batch no-ops, deep rollback isolation, malformed/tampered patches, lifecycle preconditions, incident edges, IDs retained only in migrated Redo, invalid sources/authority, replay conflicts, stale branches, current-head bounds, recovered receipt forgery and preservation of frozen source records.

## Native browser proof

Client: Codex desktop In-app Browser, Windows; existing browser runtime, native page-defined WebMCP capability. Local packaged origin: `http://localhost:4175/webmcp/`. No standalone browser driver, injected tool shim or private app-state mutation was used. This record does not assert an unobserved browser/model version.

PDF: Attention Is All You Need, official arXiv v7, 15 pages, SHA-256 `bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697`. Loaded through the explicit demo button; no paper-specific reducer behavior.

1. Native graph search returned the existing scaling candidate and its exact page-4 anchor. `focus_source` callback `callback:35e984b8-e252-4e9b-b1b5-3c7507665daa` navigated there; `read_focus` returned the exact scaling sentence and page geometry.
2. `apply_graph` callback `callback:4cade282-c395-42a7-8ddd-8c25d338d34d` created **Why attention scores are scaled** plus a grounded relation, revision 1→2. Before workspace digest: `58fd5a4fba5b8d3d7e3c97b38dfe0fe521decafa98834c4dc98051f3b06f174e`; after: `f48d8532399b5ea9b0422e6e032f51ee30bf811159c661c297ab41c3ff937eca`.
3. Identical retry callback `callback:5c52be0d-aa46-4c79-862c-9d1ccbee5cac` replayed the original operation without a new edit. Human Undo revision 3 matched the before digest; Redo revision 4 matched the after digest.
4. The PDF's **Use whole page** control and annotation form created **Reader question: scaling on page 4**: four patch records, revision 5. Native graph search returned the issued reader node and anchor.
5. `apply_annotation` callback `callback:c9471991-1bda-4d98-8c26-3e055c64b318` added **Mentor follow-up: why divide by sqrt(d_k)?** over that trusted anchor, revision 6. Ctrl+Z reversed it; human Redo produced revision 8.
6. Explicit **Save in this browser**, reload and byte-identical demo reopen restored revision 8 and exact workspace digest `0fe39311f3e9d43bbb1dbff70e6ad4ded0b3965c46bf75335bbdabe3cf5ab1fd`. Retry callback `callback:11d3e9a4-b2c4-4f2d-8fad-63be42c975d1` returned the original annotation operation without duplication.
7. Review changes displayed all seven original/compensating revisions with readable edits and retained inverse counts. At a 320 CSS-pixel viewport the document measured 305px usable/305px scroll width, with no application overflow. The viewport override was reset. Browser warning/error logs were empty.

## Publication

Source checkpoint: `1119eceeb2d4bf2ccee9316929d4087c636e3bce`, published through successful [GitHub Pages run 33586931856](https://github.com/patrickjcraig/PaperPilot/actions/runs/33586931856). The workflow repeated strict WebMCP typechecking, all 399 module/contract tests, all 4 packaging tests and artifact construction before deployment.

Fresh public URL: [PaperPilot WebMCP demo](https://patrickjcraig.github.io/PaperPilot/webmcp/). The browser-observed entrypoint and vendor script fingerprint matched the final local package: `c0930e815c2f2ec81bcc2c592106a8a24992eac447a5dcd13d9c9c1478eb65f6`.

The same Codex desktop native browser capability invoked all six tool types against the deployed app, after loading Attention through its explicit demo button:

1. `read_focus` callback `callback:d879a16a-4684-45f5-a240-0d4a15af5745` returned the exact PDF digest and revision-1 baseline. `read_graph` callback `callback:d6e4e93a-e40f-4a9b-9783-0c5a8ee3d5b5` found the scaling candidate. `focus_source` callback `callback:3c284a6c-d100-46c8-bd7b-1689ef80fa11` navigated to its page-4 sentence; the subsequent native read returned anchor digest `558a968665a5c7788bde515cf7d2b97896bbd6a8872e689c1755e4b8ab8d80cd`.
2. `apply_graph` callback `callback:ae976036-0934-4bb6-9eb4-0a24bb4c1ad4` created **Why attention scores are scaled** and one grounded relation at revision 2. Operation: `operation:b18aeec9-df58-4919-9ebf-f804b6a8cc94`; revision: `revision:b689de01-ec78-453f-a192-520341b977fc`. Identical retry callback `callback:cb16da97-b379-4a77-be47-f983a1761046` returned that original operation without another edit.
3. Human Undo revision 3 restored workspace digest `58fd5a4fba5b8d3d7e3c97b38dfe0fe521decafa98834c4dc98051f3b06f174e`; Redo revision 4 restored `56311f479e5a8c7295654f3e700456fd1b80537f890aca0aa13055db89a01a3f`. Native reads also confirmed the graph and annotation digests separately and the unchanged source-anchor digest.
4. `apply_annotation` callback `callback:a3f86696-9b5d-41cc-9ba1-42172fc31712` created **Why scale the attention dot products?**, linked to that exact sentence and the issued graph node/relation, at revision 5. Operation: `operation:dc8c1365-dc11-4b66-b482-a0bf9ccbdbbf`; revision: `revision:19204c38-9f2d-43ac-871c-361734799ed0`. Human Undo revision 6 and Redo revision 7 reproduced all three semantic digests; final workspace digest was `c7d4b5d02d133b49f7771dc3798e83681e7256f240ef53bfd6d87fd67b837df7`. The exact anchor digest remained unchanged.
5. `stage_explain` callback `callback:6e56b8af-8950-4358-a1c2-6d37d44dc2f6` staged a seven-section undergraduate mentor note, separating the selected paper sentence from background arithmetic and explicitly limiting its claims. It was neither saved nor verified.
6. The visible Review changes panel contained six attributed original/compensating revisions. Expanding revision 7 showed the created annotation, one retained inverse record, one source anchor and the matching before/after workspace fingerprints. Visual inspection confirmed the centered exact PDF, visible question markup, staged mentor note and readable revision trail. Browser warning/error logs were empty.

The public older-copy notice preserved the pre-existing legacy save; the tested workspace ended **Not saved · active tab only**, with no Save/Clear action. The public tab remains open on page 4 with its staged note and Review changes expanded. A final local reopen using this same release fingerprint recovered revision 8 and its previously recorded exact digest.

CI emitted a non-blocking action-runtime deprecation warning for existing GitHub Actions versions. Updating those workflow actions remains a separate maintenance task; deployment itself completed successfully. Unrelated working-tree edits were excluded from the source checkpoint.

## Remaining boundaries

Item 8 remains open. This checkpoint does not establish visual pixel consumption (`locator_only` remains), per-claim mentor provenance completion, literal browser-chrome 200% zoom or a human NVDA walkthrough, complete hackathon submission, cross-paper mapping, PDF export, or durable authenticated service readiness.
