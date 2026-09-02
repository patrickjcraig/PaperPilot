# PaperPilot public release proof — 2026-09-02

Status: technical release proof complete; human accessibility/access review and submission handoff remain open. This record replaces the historical two-tool proof as the current release index, without rewriting earlier evidence.

## Exact release and client

- Public URL: https://patrickjcraig.github.io/PaperPilot/webmcp/
- [Release-qualified entry](https://patrickjcraig.github.io/PaperPilot/webmcp/?release=673726c). The query refreshes entry HTML; it does not pin GitHub Pages to an immutable revision.
- Source commit: `673726c0f00756bdbfa57a4c1c72ab3d61062d4a`.
- Runtime source/lock fingerprint: `d66782d3e9a1d6c723f93374b3d622268801a489337245218f17cace2c1b7ace`.
- [Successful Pages run 33640830540](https://github.com/patrickjcraig/PaperPilot/actions/runs/33640830540) performed a clean checkout, `npm ci --ignore-scripts`, strict WebMCP typecheck, 652 module/real-PDF tests, four packaging tests and publication of `.paperpilot-pages`.
- Client: OpenAI Codex In-app Browser WebMCP on Windows, observed 2026-09-02. Exact browser/agent build strings were unavailable; no historical version string is reused as current evidence.
- [Machine-readable evidence](public-release-proof.json) binds this source, fingerprint, URL, client and per-paper callback runs. It is recorded evidence, not cryptographic proof of scientific truth or an automatic remote re-test.

The live entry and both vendor script URLs carried the recorded fingerprint. Repository metadata reported public visibility, and GitHub detected the root MIT license. No authenticated app, local database or remote PDF storage was used. The earlier public Attention tab and its saved copy were preserved; new QA tabs remained unsaved.

## What changed during release verification

Public testing found a real mismatch after reader annotation Undo/Redo: `focus_source` returned page 3 while the PDF ended on page 1. The renderer had used the old semantic focus for its final scroll, while the trusted tool correctly waited for navigation before committing the new focus. The fix scrolls the explicit requested anchor and preserves that commit order, cancellation, stale-request handling and non-stealing keyboard behavior.

Both exact-text and visual-region actual-handler/core regressions failed before the fix and passed afterward. A separate boundary test exposed empty optional prefix/suffix context in otherwise valid first/last-word source reads. The serializer now omits only empty optional context; exact text, source authority, canonical anchor geometry and digests are unchanged. Four genuinely minted/admitted boundary cases are covered.

These changes are part of the exact deployed commit above. The earlier `274c739` walkthrough was not silently relabeled as final-build proof.

## Fresh public matrix

All rows below ran at the public HTTPS origin on the final fingerprint. These are independent PDF byte identities through the shared pipeline, not newly discovered papers or paper-specific application branches. Attention is deliberately rehearsed; GW150914 had been used in earlier QA.

| Input | Coverage and interaction | Result |
| --- | --- | --- |
| Attention Is All You Need, official arXiv v7 | 15/15 indexed, navigable structural pages; exact page-4 scaling source; six native tools; new graph idea/relation and question annotation; graph plus annotation Undo/Redo; seven claim-classified mentor sections | Passed, staged and unsaved |
| GW150914, unrelated two-column physics paper | 16/16 indexed, navigable structural pages; exact abstract detection claim; same six-tool graph/annotation/mentor flow and exact Undo/Redo digests | Passed, staged and unsaved |
| Original four-page weak-text test document | Four navigable pages, three explicitly limited; page 3 image-only region created by the reader, linked to a reader node, found/navigated through WebMCP, reversed/restored with exact digests | Passed with honest limited-text/locator-only authority |
| Non-PDF input (`package.json`) | Signature rejection, no tool registration or substituted paper, followed by successful valid-PDF retry | Rejected as required |

PDF identities:

- Attention: `bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697`.
- GW150914: `e5e864c23d015b69be17e5b5d51b5b462d2829353a867513414b6728f54589c4`.
- Weak-text fixture: `de4acf347cdc1b772536dcc620d4dd95cc88a57d5007e3719b5b4208d5fc8df5`.

The weak-text graph read separately reported one structural-text page and three limited pages. That is not four pages of semantic understanding. No OCR, inferred transcription or verified pixel observation was claimed.

## Six observed native capabilities

Each entry is a real page callback, not merely registration or an in-page mock. Full `callback:` prefixes are retained in the JSON record.

| Tool | Attention receipt | GW150914 receipt |
| --- | --- | --- |
| `paperpilot.read_focus` | `d0429727-87b1-4d91-b760-9817a3273a70` | `99a0bb94-c758-4ec1-b2cc-1b74d46d815c` |
| `paperpilot.read_graph` | `fbe0e285-c3f7-47a4-a223-a08761a46f5c` | `95043f9c-debf-4a09-a012-a7cfc6f8a809` |
| `paperpilot.focus_source` | `0e2173ef-dffc-43e6-8dd5-65a386a51eab` | `13ff6d15-734d-4caa-be56-1d5e4f212bb1` |
| `paperpilot.apply_graph` | `cbe627c8-466e-46ed-b6b7-910323c83899` | `ee6098b2-1e5d-4b8d-8a90-0f55bca94eb5` |
| `paperpilot.apply_annotation` | `b19d5a96-797d-4118-9699-8d7e5543377c` | `9aae3c44-cc32-4b7d-a43f-52fc1bc100ed` |
| `paperpilot.stage_explain` | `4f45b0d5-e972-4334-9940-9460bc648e63` | `c15f21a4-95ad-4f3b-a129-a3f708411a69` |

Attention's new node was `node:agent:f40f7360-0cfb-4448-93cc-8a887854e11d`; its annotation was `annotation:agent:c66f1abe-317e-4760-b7eb-e90e8db94a5b`. Both reference `anchor:auto:idea:p4:1ozmjs2`, digest `558a968665a5c7788bde515cf7d2b97896bbd6a8872e689c1755e4b8ab8d80cd`.

GW150914's node was `node:agent:eca93031-aab0-4845-83e4-865500541a66`; its annotation was `annotation:agent:a2df0a27-6c47-46a4-a79f-9b051e48b22d`. Both reference `anchor:auto:idea:p1:1uf0p6e`, digest `88a088af36b4ecdbf07f49a3b6ebed3757f08755c79ba87e920cdb0faa36c2b4`.

Both flows applied graph revision 2 and annotation revision 3, reversed/restored the annotation at revisions 4/5, then reversed/restored both edits through revision 9. Workspace, graph and annotation digests reproduced both the original baseline and the final edited state. Revisions advanced; history was not erased.

- Attention full reversal/restoration reads: `callback:4e2529e6-4182-4ea6-aaa8-f24cbd49ba11`, `callback:4f4ad11c-31f8-4960-987b-8284fa34ea62`. Final workspace digest: `cda62f09b93b61926cca53a043dd448111c4e2bf70c989b263edafccebfa08a0`.
- GW full reversal/restoration reads: `callback:36879e45-e376-4944-9adf-64c56deaf9be`, `callback:065e4465-ef0e-498d-be42-c842c7a78649`. Final workspace digest: `247c82dcd33a88dd7a3c2760618947b999ea529b3993b1eb491c464d9d14023b`.
- Fresh bounded graph context preceded staging: Attention `callback:e10785ad-16ed-4528-9258-b2b803993c0f`; GW `callback:89364474-dadd-45ac-8f78-5469a9778434`.
- Staged response digests: Attention `c1aa1475e09abcd6bfa57b79fd54fe9991590c6be6325b352d704d3dfa4eec3c`; GW `0c8698c835609c0b9d8b0a29b1fd72f40dc7ca0d1a7fa5b4fe85d5dc909a81d3`.
- Final guide-to-source navigation: Attention page 4 `callback:7bb76e19-e5c2-41e2-af81-73abdefa41fd`; GW page 1 `callback:703c729e-49f2-4708-8d46-aa8054eb42ad`.

The Attention arithmetic example is explicitly mentor background, not a paper experiment. GW's reported detection is attributed to the authors, not independently verified. Both seven-section notes remain drafts; no agent Save/Discard/Verify/Undo/Redo tool exists.

## Weak-text recovery and negative evidence

The reader used **Use whole page** on page 3, supplied a nonvisual description and created a figure node. Native search returned that reader-authored node. Human Undo/Redo restored all three semantic digests. Then `focus_source` returned page 3 and the visible viewer independently showed **continuous page 3 of 4**, with its explicit no-usable-embedded-text notice. This is the final-build replay of the bug, not a receipt-only assertion.

- Reader anchor: `anchor:reader:87f3d201-780d-479c-ac1c-c88dabe67998`, digest `1351761e7c5c7e251a074ae85cd800201c52827b13c768063e250e37906c5aae`.
- Search: `callback:186a5632-36c1-4c1f-acb4-6cac7f1fd150`.
- Undo/Redo reads: `callback:d1495525-b462-4b8f-b494-4a424984bb27`, `callback:0558b24e-4e13-4c20-b700-2235d9bb1e47`.
- Post-history navigation: `callback:caab0a34-b580-483d-8f0a-2ccbc1bcedc9`; fresh source read: `callback:6f7560f7-12a1-4104-b3b1-60a586906825`.
- The returned mode remained `locator_only` with `pixelUseVerified: false`.

A real GW-issued anchor/digest submitted to the weak-text paper's annotation tool returned `not_found_in_active_paper`. No foreign source was admitted. The rejected response did not expose a receipt ID, so none is invented in the JSON record. Browser warning/error diagnostics were empty on all three fresh final-build tabs.

## Screenshots and earlier evidence

These screenshots were captured from the final deployed fingerprint, after its callback runs:

- [Attention: exact scaling source, annotation, graph and mentor](evidence/public-attention-2026-09-02.png).
- [GW150914: independent paper and source-linked learning guide](evidence/public-gw150914-2026-09-02.png).
- [Weak-text page 3 after history restoration and native navigation](evidence/public-weak-text-2026-09-02.png).

Earlier focused records remain separately dated and artifact-scoped: [Reader](READER-ACCEPTANCE-2026-08-31.md), [spatial anchors](SPATIAL-ANCHOR-ACCEPTANCE-2026-08-31.md), [structural coverage](STRUCTURAL-MAP-ACCEPTANCE-2026-09-01.md), [graph interaction](GRAPH-INTERACTION-ACCEPTANCE-2026-09-01.md), [canonical history](WORKSPACE-REDUCER-ACCEPTANCE-2026-09-01.md), [WebMCP lifecycle](WEBMCP-INTEGRATION-ACCEPTANCE-2026-09-02.md), [mentor provenance](MENTOR-PROVENANCE-ACCEPTANCE-2026-09-02.md), and [recovery/accessibility hardening](RECOVERY-ACCESSIBILITY-HARDENING-2026-09-02.md). They cover additional local save/restore/clear, rotation, figure, reflow and failure matrices; they are not falsely presented as new public runs.

## Automated gates and readiness semantics

Final local verification passed: 701 root tests, 652 WebMCP/module/real-PDF tests, four safe/reproducible Pages tests and 14 new readiness tests — **1,371 tests**. Repository typecheck, strict WebMCP checkJs, lint, optimized Next build, Pages build, whitespace check and no-local-database freeze passed. The Next build still reports zero authored PDF Workflows; that future service is not this static release. The existing non-blocking GitHub Action runtime warning is separate maintenance.

Reproduce the dedicated release checks with:

```text
node --test scripts/devpost-release-evidence.test.mjs
npm run webmcp:pages:build
npm run devpost:check -- --phase technical
npm run devpost:check
```

The technical checker validates closed evidence, safe URL shapes, current source paths, exact Git-bound source/lock fingerprint, generated authored modules, the six-tool authority surface, and the public cross-PDF matrix. It rejects historical paths, malformed clients, bogus/mismatched commits, missing proof and duplicate/missing callback records. It does not perform live browser calls or establish truth from a checkbox. Static source checks supplement the native evidence above; vendor integrity relies on clean pinned installation and packaging verification.

Technical mode passes **63/63 controls** and visibly reports the other groups as pending. Default full mode returns a failing exit code at **64/73**, retaining four human-review and five submission controls. It remains red until genuine human and submission checks pass. No human flag was inferred from the owner's “NEXT.”

## Remaining human work — Verification Pause 3

- Actual keyboard/screen-reader walkthrough, including the complete graph outline, source navigation, described regions, changes, errors and recovery. Automated accessible names and control tests are not screen-reader acceptance.
- Literal 200% browser zoom; forced-colors/high-contrast and reduced-motion inspection. Earlier 320/640-CSS-pixel reflow evidence is not substituted for these human checks.
- Open the public app from another machine. A fresh public tab on this machine is not that check.
- Record/caption/review the planned 2:30 narrated demo, publish its video URL, finish the human Devpost handoff and confirm submission/freeze explicitly.

Checklist items 10 and 11 remain unchecked for these human acceptance dependencies. Technical release preparation is complete; this is not accessibility certification, overall submission readiness, or a completed authenticated service.
