# Rich WebMCP integration — acceptance record

Date: 2026-09-02 (America/New_York). Guided build item 8.

## Scope

The six frozen capabilities now share a document-bound, cancellation-aware execution boundary: `read_focus`, `read_graph`, `focus_source`, `stage_explain`, `apply_graph`, and `apply_annotation`. No human Save/Discard/Verify/Undo/Redo, raw geometry, export, external fetch or cross-paper tool was added. The PDF remains centered and continuous; the graph uses the same reversible reducer.

Registration abort and invocation abort are distinct lifetimes. All six registrations must finish before retained callbacks become usable. Disposal aborts the owned native signal and closes callbacks immediately. Settled registration failures can be retried; unresolved native registration cancellation requires reload, including across a paper switch. Manual Dispose requires reload without automatically discarding unsaved work. This follows the signal-based [current WebMCP draft](https://webmachinelearning.github.io/webmcp/) rather than assuming a name-based unregister API.

Inputs are detached and frozen synchronously before observer hooks or queue waits. The shared boundary rejects executable/accessor/prototype/cyclic/sparse data and applies cumulative 32 KiB UTF-8 input and 48 KiB result ceilings. Graph byte limits retain whole records with explicit truncation guidance. Active-document identity and cancellation are rechecked after waits and before commit; required projection failure rolls back. Optional post-commit observation failure cannot turn a real edit into a reported rejection.

Reads publish success only after result validation. Staging requires current successful focus and graph reads, rechecks focus after asynchronous hashing, and commits only an unsaved proposal. The wire format is still seven plain-text sections with proposal-level references. Per-claim citations/authority blocks remain item 9 work. Recent activity is capped at 500 events without compacting the canonical revision ledger.

## Automated verification

| Gate | Result |
| --- | --- |
| WebMCP/module/PDF/recovery/UI tests | 461 / 461 |
| Root application tests | 701 / 701 |
| Reproducible/safe Pages packaging | 4 / 4 |
| Repository TypeScript and WebMCP checkJs | Pass |
| ESLint | Pass |
| Optimized Next.js production build | Pass |
| Local-database-write freeze | `local_database_write_frozen` |
| Whitespace check | Pass |

Total: **1,166 passing tests**. New dedicated suites include 27 registration-lifecycle cases, 18 boundary cases and 12 tests executing the app's actual production handlers. Extended observer/navigation tests cover synchronous capture before callbacks, late registration completion, input mutation during waits, queued/in-flight cancellation, stalled request indicators, partial failure, unavailable WebMCP, paper replacement, stale callbacks, safe literal injection-shaped content, source freshness, rollback and truthful post-commit activity. Pathological registration/cancellation failures are automated adversarial tests, not claims that those failures were induced in the public browser.

## Local native-client proof

Client: Codex desktop In-app Browser on Windows, native page-defined WebMCP capability. No injected API shim, hidden application-state mutation or standalone browser driver. The available client did not expose a verifiable model/browser build string, so none is invented.

Packaged origin: `http://127.0.0.1:4176/webmcp/`. Runtime fingerprint: `29207afc29cf618bcce6770eb400c2ced9b095838c8a842d3527322b6819c61b`.

Unrelated paper: GW150914, 16 pages, SHA-256 `e5e864c23d015b69be17e5b5d51b5b462d2829353a867513414b6728f54589c4`, loaded through the file chooser. The map exposed 16/16 navigable pages and explicitly partial semantic coverage.

1. `read_focus` callback `callback:9787c261-271c-434b-90e1-ab433483df29` returned the page-1 detection claim with exact source digest `a9abf76f0a08745e529ed1ceb5f045d48e56074ceb6527d755eb76d9aeefabcd`. `read_graph` callback `callback:12a694aa-529d-4374-af50-b568a035ce8d` found literal detection matches; `focus_source` callback `callback:d85fc007-528c-43f3-b967-d74dcf1092b3` navigated to its issued source.
2. `apply_graph` callback `callback:19cc0b2b-1196-4f65-9965-ddebe8f0b787` created **What was directly detected?** plus a source-linked relation at revision 2. Identical retry `callback:786b4a16-29df-482b-aa51-5e806d7b1a39` returned the same operation/revision with no duplicate.
3. Staging against revision 2 while the last reads belonged to revision 1 returned `rejected/read_required`. After refresh, `apply_annotation` callback `callback:b29d0499-5e97-4621-a7ed-62692470c2f8` created **What does direct detection mean here?** at the exact sentence. Human Undo and Redo reproduced the expected before/after workspace digests; revision 5 ended at `8306dc6594d4e7d8b67abc00c21e6b5e63c9b488a49e62f10fc7dd417c6b0f23`.
4. Fresh focus/graph reads enabled `stage_explain` callback `callback:71e67d6b-ca90-4084-94e5-4a457517ca67`. The mentor note distinguished the paper's reported detection from teaching background and limited itself to the selected sentence. Nothing was saved or verified.
5. An unissued/foreign source returned `not_found_in_active_paper`; an old-basis graph command returned `stale_workspace`. A subsequent native read retained revision 5 and its exact digest.
6. The reader's **Use whole page** form created a described page-1 region and graph node. `read_focus` callback `callback:0f749469-17a5-468b-b712-cd250ace8c47` returned `visual_region`, `mode: locator_only`, `pixelUseVerified: false`. A request claiming `client_visible_region` was rejected with `visual_evidence_mode_mismatch`. The UI's human diagnostic assessment cannot promote pixel authority; that handler is separately regression-tested.
7. **Dispose tools** removed all six native tools. Fresh discovery returned “No WebMCP tools are available in this document.” An old handle was rejected as stale. The local PDF, graph and revision-6 workspace remained visible and readable; no automatic reload or save occurred. A deliberate reload exposed no tools before intake, then reuploading the same PDF registered all six afresh and returned the original unsaved revision-1 digest (`callback:6ef489a3-4058-4f88-a184-126e322da5ed`). Browser warning/error logs were empty.

## Publication

Source checkpoint: `3cf69723b3ea27941076dc1d6772ffe2c15c6d8b`, published through successful [GitHub Pages run 33631230666](https://github.com/patrickjcraig/PaperPilot/actions/runs/33631230666). CI repeated strict WebMCP typechecking, all 461 module tests, all 4 packaging tests and artifact construction before deployment.

Public URL: [PaperPilot WebMCP demo](https://patrickjcraig.github.io/PaperPilot/webmcp/). A normal load initially retained the older cached entrypoint. The fresh [release-qualified load](https://patrickjcraig.github.io/PaperPilot/webmcp/?release=3cf6972) matched fingerprint `29207afc29cf618bcce6770eb400c2ced9b095838c8a842d3527322b6819c61b` for the app and vendor scripts. The release parameter only bypasses the stale entry HTML; this is the same published artifact.

The exact official Attention v7 PDF was opened through the public demo button: 15 pages, SHA-256 `bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697`. The same native client observed 6/6 tools and 15/15 navigable pages, with partial semantic coverage explicitly distinguished from document structure.

1. `read_focus` callback `callback:90ff9628-5a99-41a2-b8fa-28b9b62afd69` returned the exact document identity and revision 1. `read_graph` callback `callback:69ee9731-db11-42ea-8804-bec2654859e9` found the scaling candidate. `focus_source` callback `callback:d980cbfa-5a0b-4f2f-a9bf-147988ec5e9f` returned its page-4 source; a fresh focus read returned anchor digest `558a968665a5c7788bde515cf7d2b97896bbd6a8872e689c1755e4b8ab8d80cd`.
2. `apply_graph` callback `callback:e19af4f3-9f7a-43c6-a526-a368db1d2630` created **Why scale the attention scores?** plus a grounded relation, revision 1→2. Operation: `operation:e54c43c3-17a2-4817-a66a-d0fa3e0fa343`; revision: `revision:3ff92f9a-c9fc-433f-8199-2aaf8d5b5951`. Retry `callback:92fce02d-ad72-4c7e-a0ea-47963515313b` replayed that original operation without a new revision.
3. Human Undo/Redo reproduced the before/after workspace and graph digests while leaving annotation state unchanged. Before workspace: `58fd5a4fba5b8d3d7e3c97b38dfe0fe521decafa98834c4dc98051f3b06f174e`; after: `d6c1e7e2705a6e600c89e9931f44edb693fad3c08b497a24f887a24fbd825af8`.
4. `apply_annotation` callback `callback:18772eff-6da1-4081-839e-d7d6e82be0fb` created **Why divide attention scores by the square root of d_k?** on the exact sentence, revision 4→5. Human Undo/Redo reproduced workspace and annotation digests while leaving graph and source-anchor digests unchanged. Final semantic workspace digest: `38e5893d5e1ca6928d0b12d473420c95c6a57652123f68403a9897f6ecb331b7`.
5. Native public requests returned `read_required` for stale explanation reads, `not_found_in_active_paper` for the reader-region anchor actually issued by the unrelated GW150914 session, and `idempotency_conflict` for different content under the same graph key. The next graph read retained revision 7 and its exact digest. Visible activity labeled these callbacks rejected, not successful navigation/staging or edits.
6. Fresh graph context enabled `stage_explain` callback `callback:2705d88a-521f-4621-9461-306b7bb5e540`. The note separated the selected scaling statement from mentor arithmetic/variance background and explicitly flagged PDF text extraction's flattened fraction. A final source return `callback:b4c17794-044f-4080-9477-89605d21e631` and passive read confirmed page 4 and its visible exact overlay. A second human Undo/Redo retained that visible page and reproduced the same digests at revision 9. Fresh reads enabled final staged callback `callback:40d2b823-5652-492b-9a74-badaf2de549d` against revision 9.
7. The public Evidence tab showed observed request/return pairs for all six capabilities, rejected attempts, the original reversible edits and human compensating actions. Visual inspection confirmed the centered exact paper, graph guide, source-bound question and unreviewed mentor note. Browser warning/error logs were empty. The page remained **Not saved · active tab only**; no Save/Clear or PDF write occurred.

The public demo is left open with the live reading-guide example. The workflow's existing action-runtime deprecation warning is non-blocking and remains a separate maintenance task. Unrelated working-tree changes were excluded from this checkpoint.

## Remaining boundaries

- Figure regions are source locators, not verified pixel-consumption evidence. No hidden reasoning or scientific verification is claimed.
- Item 9 still needs per-claim source/authority structure and stronger graph-aware mentor presentation.
- Final human screen-reader/browser-chrome zoom walkthrough, release video, submission handoff and authenticated service port remain separate gates.
- No local/remote database, PDF bytes or existing saved owner workspace were written. Local testing used an isolated unsaved origin; unrelated repository edits remain excluded from this release.
