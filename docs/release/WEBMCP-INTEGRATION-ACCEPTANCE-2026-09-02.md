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
7. **Dispose tools** removed all six native tools. Fresh discovery returned “No WebMCP tools are available in this document.” An old handle was rejected as stale. The local PDF, graph and revision-6 workspace remained visible and readable; no automatic reload or save occurred. Browser warning/error logs were empty.

## Publication

Pending the source checkpoint and fresh public-client verification. Local tests do not by themselves establish that the public deployment contains this runtime.

## Remaining boundaries

- Figure regions are source locators, not verified pixel-consumption evidence. No hidden reasoning or scientific verification is claimed.
- Item 9 still needs per-claim source/authority structure and stronger graph-aware mentor presentation.
- Final human screen-reader/browser-chrome zoom walkthrough, release video, submission handoff and authenticated service port remain separate gates.
- No local/remote database, PDF bytes or existing saved owner workspace were written. Local testing used an isolated unsaved origin; unrelated repository edits remain excluded from this release.
