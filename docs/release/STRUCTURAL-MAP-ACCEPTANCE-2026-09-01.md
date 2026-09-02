# Whole-paper map and WebMCP reliability checkpoint

Date: 2026-09-01, America/New_York. Browser callbacks continued into 2026-09-02 UTC.

Status: local checklist-item-5 acceptance passed. Publication and fresh public checks are recorded below after deployment. This is an incremental release, not a declaration that checklist items 6–12 are complete.

## Scope and boundaries

The public reader now generates a protected paper/section map before an agent prompt. PDF outline destinations are preferred; conservative heading candidates are second choice; deterministic groups of at most ten pages provide remaining coverage. Every navigable page belongs to exactly one leaf range. Failed pages remain explicit rather than being counted as mapped.

Generated structure is document navigation, not a claim that the app has understood the paper. Automatically ranked semantic candidates remain separately labeled unreviewed. Reader/agent ideas can be edited reversibly and linked to source anchors; agents cannot rewrite generated coverage or supply PDF coordinates.

The accompanying reliability work addresses defects reproduced during the WebMCP audit: atomic rollback, passive callbacks moving the page indicator, focus lost during graph redraw, collapsed mentor disclosures, filename-dependent recovery, and optional text-layer failure disabling otherwise visible PDFs.

## Verification environment

- Repository: `patrickjcraig/PaperPilot`, public, MIT license verified through GitHub.
- Local URL: `http://127.0.0.1:4175/webmcp/`, serving only the generated `.paperpilot-pages` artifact.
- Client: Codex desktop in-app browser on Windows, with real page-defined WebMCP calls through the bundled browser capability. Browser plugin package: `26.831.20005`. A separate browser-engine version was not reported and is not inferred here.
- Dependencies: the repository-pinned PDF.js, Graphology and Sigma versions; no new runtime dependency.
- Storage: explicit browser-local recovery in the local test tab only. No local or remote database write, PDF rewrite/export, or external paper upload.

## PDF matrix

| Input | Observed result |
| --- | --- |
| Exact Attention Is All You Need arXiv v7 PDF | 15/15 navigable pages, 10 structural ranges; outline-derived ranges distinguished from the page-1 fallback. Ten separate unreviewed idea candidates across six semantic pages. |
| Unrelated two-column GW150914 PDF | 16/16 navigable pages. Conservative inferred headings; author lists, addresses, equation fragments, and acknowledgments prose excluded from structural headings. No Attention reader node or saved workspace crosses into this paper. |
| Original synthetic nested-outline PDF | Real PDF.js named/explicit destination parsing, hierarchy and stable IDs, CropBox and 90/180/270-degree anchor validation. |
| Original 23-page outline-free PDF | Exact non-overlapping fallback ranges of 10, 10, and 3 pages. |
| Original multicolumn/figure fixture | Numbered and all-caps headings retained without treating vector figures as embedded text. |
| Original four-page limited-text fixture | One readable page plus blank, image-only, and vector-only pages. All four remain navigable; three are explicitly limited. Image-only page 3 renders with no invented text and a page-local accessible limitation note. |
| Controlled indexing failure after real PDF parsing | Explicit failed-page ledger, no false ready state and no structural node claiming the failed page. This failure is injected test evidence, not a claim that every malformed PDF is supported. |

Attention SHA-256: `bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697`.

Limited-text fixture SHA-256: `de4acf347cdc1b772536dcc620d4dd95cc88a57d5007e3719b5b4208d5fc8df5`.

Generate the original test PDFs with `node scripts/generate-webmcp-structural-fixtures.mjs`. They are written under ignored `tmp/pdfs/structural-fixtures`; no research PDF or generated fixture bytes enter the Pages artifact.

## Browser interaction evidence

1. Real `read_graph` returned current structure, explicit authority, range anchors and separate semantic coverage. Local receipt: `callback:718e70ef-e98b-4089-9248-8810274e64fb`.
2. `focus_source` on the issued page-4 section scrolled the continuous reader to page 4. Local receipt: `callback:2b2bd05b-6b30-4778-84e6-f1c63f65367a`.
3. The human page locator then moved to page 1. A passive `read_focus` still read the selected page-4 source but left the visible page at 1 and keyboard focus on the page input. Read callbacks do not navigate implicitly.
4. Focusing “Arrange this node” and invoking `read_graph` retained the exact focused graph control and page position. A real semantic update retained that focus too: `callback:5035cf45-b610-4a26-a781-d33223185ac3`.
5. Tombstoning the focused idea moved focus to the next surviving row rather than the document body. Human Undo restored it, Redo tombstoned it, and a second Undo restored it again. Removal receipt: `callback:32ca2c3d-63df-4ab9-ac56-fb29fdbe9bf2`.
6. The agent staged a seven-section mentor draft against the exact current source. Opening “How it works,” then editing the graph, preserved that open disclosure and its keyboard focus. Staging receipt: `callback:f7973eb3-b455-4096-903a-e7c46c73a763`.
7. The main PDF annotation form created a described reader-owned page-4 annotation and node. WebMCP literal search found the issued reader node: `node:reader:d828fb42-8cbb-4929-bfda-9a96049eee0f`, receipt `callback:28325b82-c2dd-4848-be18-87b4f5daa80f`.
8. Annotation reorder and keyboard graph nudge changed presentation only. The following `read_graph` preserved workspace revision, workspace digest and annotation digest.
9. Explicit Save and the human mentor-note Save were exercised. Reloading byte-identical Attention under a different filename restored revision 8, the reader annotation, saved mentor note, Undo/Redo state, and exact page-4 source. The page was physically at 4; keyboard focus was not taken from the intake flow. No browser warnings/errors were reported in these checks.

Screenshots were visually inspected during the run. This checkpoint does not claim a new demo recording, literal browser-chrome 200% zoom, or a completed human screen-reader certification.

## Adversarial and failure evidence

- Agent mutations and human annotation/Undo/Redo writers build on an isolated draft. Graph, anchors, annotations, digests, revision, history/redo, replay receipts and events commit together only after validation and mandatory projection succeed.
- Injected metadata, history, replay, event and synchronous/asynchronous projection failures leave the previous workspace intact. A genuine retry can succeed; only the successful command is replayable. Reads wait behind pending writers.
- A rolled-back command returns `workspace_rolled_back`, shows an error outcome, keeps no successful revision receipt, and does not flash a completed annotation. Optional activity observers cannot turn an applied command into a false rejection.
- Recovery verifies current and every history/redo structural node, edge, source override and canonical primary anchor against the freshly minted baseline. Fully rehashed wrong-page, CropBox/rotation and source-kind replacements are rejected without touching live state or saved bytes.
- Stored paper-root display labels cannot override the freshly loaded title. Renamed-file recovery normalizes only that display field, retaining the structural and document-identity checks.
- Canvas rendering is mandatory; selectable text is optional. Extraction/text-layer failures leave successful canvas pages visible with honest limitation notes. Required exact-source, true canvas/document failures and cancellation/stale-render rules remain fail-closed.

## Automated gates

| Command | Result |
| --- | --- |
| `npm test` | 701 passed, 0 failed |
| `npm run test:webmcp:contracts` | 255 passed, 0 failed, including six actual-PDF integration tests |
| `npm run test:webmcp:pages` | 4 passed, 0 failed |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm run typecheck:webmcp` | Passed |
| `npm run build` | Optimized Next.js build passed |
| `git diff --check` | Passed; Git reported only line-ending conversion notices |

The Pages builder captures authored source and lockfile identity and applies one content fingerprint to entry assets, authored module imports, and direct vendor/worker assets. Two clean generated builds are byte-identical. Artifact checks reject PDF bytes, source maps, credential files and credential-shaped content. Pages CI now runs strict WebMCP checks, module/PDF tests and packaging tests before upload/deployment.

## Compatibility and remaining work

- Compatible map snapshots use `paperpilot:webmcp:v2:<digest>`. Older candidate-only v1 copies are preserved, not silently imported or erased. The app explains that saving the new map creates a separate compatible copy. Automatic v1 migration is not complete.
- Checklist item 5 is green. Item 6 remains the next full gate: graph density/layout, pointer drag/drop, large-map behavior, outline equivalence and the complete accessibility matrix. The focused keyboard fixes here do not certify all of item 6.
- Item 7 still needs the target canonical forward/inverse-patch format; the guarded reducer currently retains compatible before/after snapshot history.
- Full-paper text search, per-claim explanation provenance, stronger figure evidence, mentor handoff, admission-limit reconciliation, final public cross-PDF/accessibility/video proof, and Devpost handoff remain open. Literal graph search is not full-paper retrieval, and `locator_only` is not visual understanding.
- Zotero, crawling, authenticated serverless storage and cross-paper graphs remain later work. This release makes no new networking/backend claim.

## Publication record

Pending the checkpoint commit, successful Pages workflow and fresh public smoke test. Until those are recorded, the local receipts above are not public-deployment proof.
