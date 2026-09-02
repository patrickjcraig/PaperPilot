# Graph interaction acceptance — 2026-09-01

## Scope and status

This record covers guided checklist item 6: Graphology/Sigma navigation, the complete accessible graph outline, and presentation-only annotation/node arrangement. It does not claim completion of the remaining reducer migration, mentor provenance, recovery/accessibility release matrix, video, or submission tasks.

Local interaction, automated verification, and the fresh public native-WebMCP smoke test passed. This is an item-6 checkpoint, not the final all-epic release.

## Tested environment

- Windows; Codex in-app Browser, using the page's native WebMCP capability. The precise browser build number was not surfaced in this run.
- Packaged Pages artifact served at `http://localhost:4175/webmcp/`. This separate origin avoided writing into the owner's explicitly saved `127.0.0.1` workspace.
- Desktop checks at 1440 × 960 and 1440 × 1200 CSS pixels; narrow reflow at 320 CSS pixels.
- Attention Is All You Need, arXiv v7, 15 pages; exact SHA-256 `bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697`.
- A second unrelated GW150914 PDF and generated weak/large-map fixtures are separate QA inputs, not packaged demo assets.
- No database, original PDF, or public browser-storage writes. The local test workspace stayed explicitly unsaved. Existing owner tabs and saved work were not cleared.

## Delivered interface

The centered continuous paper remains the primary reading surface. The right rail now has keyboard-operated **Map**, **Annotations**, and **Evidence** tabs. Its initial key-idea drawing is bounded to 15 nodes; expanded drawing is capped at 60 nodes/120 edges. Visible/total counts make that limit explicit. The complete outline retains all node and directed-edge facts, including tombstoned audit records.

Selecting a node or relationship exposes its complete label, summary/claim, authority, origin, state, all source choices, and incoming/outgoing directed relationships. Compact canvas labels do not replace canonical labels. Node color continues to identify origin while a ring identifies selection. Search uses the same literal label/summary and kind/authority rules as WebMCP.

Both pointer and keyboard arrangement operate on presentation state only. Card dragging uses a primary-pointer path with a movement threshold and fresh release-time hit-testing; native HTML5 dragging remains a guarded fallback. Moving a card does not expand details or move target rows mid-gesture. A drop revalidates the annotation identity, revision, anchor, and links before acting. Cancellation, lost capture, Escape, blur, stale links, and secondary pointers do not create a change.

## Observed browser checks

| Check | Observed result |
| --- | --- |
| Complete graph parity | Attention's 21 active node IDs and 20 edge IDs matched the complete outline and native `read_graph`; the initial visual projection truthfully showed 15/21 nodes. |
| Pointer card reorder | Moved automatic candidate 2 before candidate 1 through its grip; the visible ordered card IDs and move announcement changed. |
| Pointer card → map | Dropped candidate 2 on the map; its display position became `(1.11, 0.35)` and the UI explicitly reported that the PDF mark did not move. |
| Direct Sigma drag | Moved that node to `(1.47, -0.26)` without a trailing source-navigation click. |
| Keyboard arrangement | Four-direction nudge controls changed view coordinates; Move later reordered the card and retained keyboard focus on the same issued card/control. |
| Evidence invariance | Before/after arrangement, the workspace revision, workspace/graph/annotation digests, complete source object, anchor digest, page and normalized rectangles matched exactly. |
| Native navigation | `focus_source` selected the exact requested node/edge, including the page-4 scaling edge, rather than a different node sharing its anchor. |
| Reader-origin flow | The PDF form created `Why scale the dot product?` from a described page-4 region. Native graph search returned its issued reader-authored node and source. |
| Agent edit after arrangement | A real `apply_graph` changed the unreviewed scaling label at revision 2 → 3 while the separate reader node retained its position, expanded relationship disclosure, and focused relationship control. |
| Annotation and history | A real `apply_annotation` at revision 3 → 4 bound a new agent note to the reader-issued region. Human Undo and Redo restored the exact before/after semantic digests and retained the node position. |
| Focus after removal | Tombstoning an editable candidate while its nudge button had keyboard focus moved focus to the graph heading; Human Undo restored the candidate. |
| Multiple sources | A new agent node exposed both the exact scaling sentence and the reader's full-page region. Each source button returned to its own issued anchor without changing the selected node. |
| Tab behavior | Arrow keys and Home/End maintained one selected/tabbable tab and the matching visible panel. Returning from Evidence restored the graph without a zero-size renderer error. |
| Responsive containment | The 320-CSS-pixel layout had zero document horizontal overflow; the paper remained first in reflow order. |
| Unrelated paper | GW150914 exposed 17 nodes/16 edges with 16/16 page coverage; the complete outline matched those counts, and native navigation selected its exact issued source node. |

Final unrelated-paper receipts: graph read `callback:4beb30fe-f2cb-44e4-830a-12446291ec78` and source focus `callback:9a243679-e816-4a9d-8904-ed00dceecd63`. Final browser warning/error logs were empty. The packaged source content fingerprint was `35f2fe9ee857a4e1399683b43beae3a0486799d193a8f94d0cb1f08b9b0eaf4e`.

The pointer-placement receipt `callback:97a6968b-9bf1-4e25-be0f-675f9b50a90b` confirmed unchanged canonical state. Direct-node drag was followed by `callback:8d9f8baf-ebf6-4e49-964d-39092d4bbe0d`, which returned the unchanged source anchor.

Earlier native mutation receipts from the same scoped local test cycle:

- Graph update: `callback:7461b8e9-28e7-4128-987e-bbfea63f1f9c`.
- Agent annotation: `callback:20e0e49f-dd2d-41b9-92ef-8aca11258aec`.
- Read after Human Undo: `callback:bab907f2-0330-416c-9f54-6976891771a2`.
- Read after Human Redo: `callback:29fdc19a-a213-47a2-9968-cc0a4b40b99b`.
- Tombstone/focus fallback: `callback:df757111-e540-4f15-a317-20628ebdfa0f`.
- Multi-source node creation: `callback:76e1aac3-ca22-4537-8304-b95c2be3bf34`.
- Exact-source and region-source returns: `callback:19fd5549-d47f-491f-959c-f8881276f2eb` and `callback:98fc411a-6e50-4bdb-aa52-2fa7faa31a6a`.

Receipts prove observed callbacks and their effects, not private reasoning or scientific correctness. The described region used `locator_only` visual evidence, not verified pixel interpretation.

## Automated verification

- Root application suite: **701/701 passed**.
- WebMCP, graph, presentation, navigation, accessibility and PDF suites: **322/322 passed**.
- Reproducible/safe Pages package: **4/4 passed**.
- Total: **1,027 passing tests**.
- Repository lint, repository TypeScript, strict WebMCP checkJs, and optimized Next.js production build passed.

New tests execute actual app callbacks via bounded AST/VM fixtures as well as pure graph projections. They cover 600 nodes/1,200 edges, permuted insertion order, full parallel-edge identities, surviving positions across graph replacement/Undo/Redo, immutable source bytes/digests/events, all disclosure ancestors, disabled arrangement focus, missing/throwing Sigma, origin-preserving selection, reduced-motion animation settings, reverse-completion navigation, and cancellation without false success receipts.

Review also corrected the previously hardcoded `focus_source.alternativeCount`: it now counts distinct compatible current-paper source choices while preserving the primary choice and schema. Node, edge, structural-range, duplicate, foreign/missing-source and direct-anchor cases are tested.

## Explicit remaining boundaries

- Dense and unavailable-renderer cases are automated component/projection tests; they are not a claim of a recorded 600-node browser session.
- Screen-reader names, focus behavior, keyboard controls and reduced-motion settings were checked. A human assistive-technology walkthrough and literal browser-chrome 200% zoom remain part of the final accessibility gate.
- Automatically suggested or agent-refined ideas remain unreviewed. Structural coverage is not semantic understanding or scientific verification.
- This anonymous browser-local release has no built-in background model service, database writes, networking integrations, cross-paper edits, OCR, or PDF export.

## Public publication

Published source commit: [`ef26b2a6a7d6c9b4e36135fdb2d11b226747ec8f`](https://github.com/patrickjcraig/PaperPilot/commit/ef26b2a6a7d6c9b4e36135fdb2d11b226747ec8f).

Successful clean-checkout deployment: [Pages run 33585235818](https://github.com/patrickjcraig/PaperPilot/actions/runs/33585235818). The job passed WebMCP typechecking, the complete contract/PDF suite and safe/reproducible packaging before publishing. GitHub emitted a non-blocking action-runtime deprecation notice; the deployment itself succeeded.

Public URL: [PaperPilot](https://patrickjcraig.github.io/PaperPilot/webmcp/). The loaded HTML referenced the new app, Graphology and Sigma assets with content fingerprint `35f2fe9ee857a4e1399683b43beae3a0486799d193a8f94d0cb1f08b9b0eaf4e`, matching the tested local package. The normal **Open the live demo** button fetched and indexed Attention v7 successfully; no local file chooser was needed for this public run.

All six capabilities were registered and actually invoked in this fresh public tab:

| Capability/check | Public receipt and outcome |
| --- | --- |
| `read_graph` | `callback:80a956c6-57da-4b44-9f43-e2e384ce2510`; all 15 pages structurally navigable, 21 baseline nodes/20 edges. |
| `focus_source` | `callback:77de9d7c-a6cf-4375-80ec-168d7dadd428`; exact requested scaling edge selected and its page-4 sentence focused. |
| `read_focus` | `callback:52e918f9-dfe9-4bb7-b61c-4aaa9076f0d0`; returned that exact source and its normalized rectangle/anchor digest. |
| `apply_graph` | `callback:a72e0e8c-2ded-48c5-8ce4-af177b7887aa`; revision 1 → 2 created an unreviewed two-source reading-guide node and a grounded relationship. |
| Multiple-source focus | `callback:b83ff487-cdbd-4dd5-a2a7-27ac48ab8339`; returned `alternativeCount: 1`, selected the exact new node, and exposed both source buttons. |
| `apply_annotation` | `callback:9ae51d14-01de-4a26-a67a-f1dad096e1cb`; revision 2 → 3 created a question annotation bound to the issued scaling sentence and linked node/edge IDs. |
| Human Undo/Redo | Native reads `callback:699577a9-d747-46d5-9794-9ea15916f024` and `callback:bd2aaab7-30d2-4549-854b-b70705693dfb` reproduced the annotation's exact before/after workspace digests. |
| `stage_explain` | `callback:efb732d2-7ffb-4a3c-9a3e-6842b0540de6`; staged all seven mentor sections, explicitly distinguishing paper evidence, teaching background, unreviewed graph interpretation and limitations. Nothing was saved or verified. |

The public nudge step retained the prior semantic digest and exact source object. Final state showed the 22-node/21-edge graph, its new reading guide, the exact PDF question mark and the staged mentor note. Warning/error logs were empty, storage remained **Not saved · active tab only**, and the test viewport override was reset. The public repository was independently confirmed public with an MIT license. No submission, legal acknowledgement, new database deployment, or user-data deletion occurred.
