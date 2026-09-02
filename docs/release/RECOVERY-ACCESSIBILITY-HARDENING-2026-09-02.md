# Recovery, accessibility and adversarial hardening

Date: 2026-09-02 (America/New_York). Guided build item 10.

Status: implementation and automated verification completed; final public proof and **owner Verification Pause 3** are recorded separately below. Automated accessibility checks are not a substitute for a human assistive-technology walkthrough.

## Release boundary

The public slice remains a browser-local, centered continuous PDF reader with Graphology/Sigma, an equal accessible outline, six document-scoped WebMCP tools, in-app annotations and reversible graph edits. No transcript pane, PDF byte writer/export, local database, remote model backend, authenticated service, crawler or Zotero work was added.

### Bounded PDF intake and rendering

| Boundary | Enforced release ceiling |
| --- | --- |
| Input bytes / document pages | 25 MiB / 200 pages |
| Exact selection | 1,200 Unicode scalars and 8 KiB |
| Canvas backing store | 8 million pixels; 8,192 pixels per dimension |
| PDF page dimensions at unit scale | 14,400 points per dimension |
| Decoded text per page | 20,000 items / 200,000 characters |
| Decoded text per document | 250,000 items / 2,000,000 characters |
| Concurrent page-proxy loading | Four |
| Render neighborhood | At most two pages on either side |

Caller options cannot raise these ceilings. Canvas limits preserve CSS/source geometry. Text over budget remains visually readable where rendering succeeds and is explicitly marked limited; clipped text is not promoted into exact evidence. Failed/cancelled initialization releases its owned listeners, DOM, text/canvas buffers, proxies and worker resources without erasing a newer reader.

The explicit demo button requests only the recorded official Attention v7 URL, without credentials or redirects. The response is streamed with declared and actual byte limits, MIME checks and cancellation; its length and SHA-256 must match the committed fixture identity before opening. A 45-second download/hash deadline produces a safe retry message. A newer local-file choice supersedes an older demo success or failure. Parser/network details are not echoed into UI or activity. PDF.js evaluation, XFA and worker fetch are disabled; no embedded action or attachment execution path is exposed.

These are application-level resource limits, **not an operating-system memory/CPU sandbox**. PDF.js may transiently allocate decoded objects before returned-text budgets can be checked. OCR, encrypted-document unlocking and a claim of support for every possible PDF remain outside this release.

### Recovery and human authority

Save and restore bind the exact paper identity, active session and edit generation. Save joins the canonical mutation queue, so it cannot persist a partially applied revision that later rolls back. Old asynchronous results cannot relabel a newer workspace as saved. A failed/quota-limited save leaves the current state explicitly unsaved and preserves the prior valid copy.

Loading another paper resets note/order/opt-in/status state. Mentor Save/Discard additionally binds the clicked draft to the ready paper session and page lifetime. Tests reproduce a queued old-paper decision during slow replacement **before the new state is installed** and prove that it cannot refill the reset notes list. Decisions already committed before cancellation retain their truthful outcome.

Ordinary loading and version-2 migration preserve legacy bytes and do not silently enable persistence. Unsupported version-1 copies remain visible and unhydrated. Explicit **Clear saved copies** is the only path that removes the known v1/v2/v3 copies for the current fingerprint; it does not enumerate storage, guess future schemas, touch another paper or erase the live workspace/PDF. It reads all targets before any removal, removes legacy versions before the current v3 copy, and reports partial failure honestly.

Clear requires a persistent, session-bound **Confirm clear** or **Cancel clear** choice. Its separately announced warning survives background save-status updates; there is no timed confirmation window. Pending controls retain focus with guarded `aria-disabled`/`aria-busy` states. Cancel returns to Clear; successful Clear returns to Save only when the initiating control still owns focus. Page-level event wiring is idempotent, so repeated initialization cannot turn one click into both confirmation steps.

### Keyboard and evidence presentation

Escape/Cancel returns to the exact region trigger, including **Use whole page**. Draft selection and annotation submission are session-bound; stale callbacks cannot revive an old draft. Empty region descriptions receive a focused, field-associated alert. A successfully committed annotation remains successful if its optional preview fails, and the consumed draft cannot create a duplicate. Paper, mentor, graph and evidence shortcuts focus their correct headings and open the requested rail tab. Non-color status text and forced-colors styling preserve selection, disabled and removed-item distinctions.

## Automated verification

| Gate | Result before final publication |
| --- | --- |
| WebMCP/PDF/recovery/actual production-handler tests | 649 / 649 |
| Root application tests | 701 / 701 |
| Safe and byte-reproducible Pages packaging | 4 / 4 |
| Repository TypeScript and strict WebMCP checkJs | Pass |
| ESLint | Pass, no warnings |
| Optimized Next.js production build | Pass |
| No-local-database guard | `local_database_write_frozen` |
| Whitespace check | Pass |

Total: **1,354 passing tests**. The focused suites include bounded streaming/intake, whole-document text/canvas budgets, cancellation/cleanup, real PDF.js fixtures, stale save/load/clear interleavings, immutable source/patch validation, corrupt/foreign snapshot rejection, quota and partial-clear failures, keyboard focus, mentor session decisions, no-export and untrusted-input boundaries. Fault injection and timing races were exercised in automated tests; they are not presented as failures induced in the public browser.

## Native local-browser proof

Client: Codex desktop In-app Browser on Windows using actual page-defined WebMCP callbacks, visible controls and DOM-backed checks. No hidden-state/storage edits, API shim or standalone browser driver. Test origin: `http://127.0.0.1:4178/webmcp/`. Browser/model build strings were not supplied and are not invented.

Attention v7: 15 pages, SHA-256 `bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697`.

1. Keyboard **Use whole page**, Enter, the page locator and description form created **How does multi-head attention combine information?** on page 4. Escape returned to `select-whole-page`. A whitespace-only description focused `reader-region-description`, set `aria-invalid`, and announced the missing description. A valid submission created one reader-authored node and described region, retaining submit focus.
2. `read_focus` callback `callback:637bf7b0-061a-4193-b9a2-d963dfdb79f5` returned the issued reader anchor with digest `a9a61aaa26f4da7fedbf272e3e5dc4dd78cf0053900937d4f95d7984f1ef3458`, page 4, `locator_only` and `pixelUseVerified: false`. Native search `callback:53a52b41-618b-4525-b696-6d16af9caeaa` found the reader node at revision 2.
3. Native graph mutation created **Reading path: queries, keys, values, then attention heads** and a relation to that reader node at revision 3. It is explicitly mentor-background guidance, not a claim of pixel inspection. An identical retry returned `replayed`, original revision 2→3 and callback `callback:bdb129bd-85eb-47ed-84a7-65b2c245894a`, without duplication.
4. `apply_annotation` callback `callback:9b2641ee-36ac-41d9-bdca-713b1274a064` attached a question to the issued region and both graph nodes at revision 4. Human Undo and Redo returned revisions 5 and 6. Reads `callback:9779c290-62ac-4e62-b7da-3e539606218a` and `callback:2c68360f-677c-4bc7-88ca-1c371c4e1974` matched all three expected semantic digests and the unchanged source digest.
5. Explicit Save retained focus on `save-workspace`. Cancel clear returned focus to `clear-saved-workspace`. Another confirmation survived a native graph read. Confirmed Clear disabled persistence, returned focus to Save and preserved the open paper, graph, annotations and their digests.
6. Saving an undone state and reopening byte-identical PDF data under another filename restored revision 7, its reader source and usable Redo. The visible notice correctly explained that applying the trusted new display title changes graph/workspace digests and invalidates historical retry results; source/annotation identity remained unchanged. After saving that current title, reopening restored revision 8 and **all three digests exactly**, confirmed on the combined artifact by `callback:17523218-43c0-4e83-b7c9-20361cd94f64`.
7. Clearing this disposable copy, reloading and reopening the same PDF returned **Not saved · active tab only**, revision 1 and zero results for the prior teaching node (`callback:62e44ff6-540c-4cfa-8ee4-8bbbccc1bea0`). No legacy copy resurrected the cleared test workspace. Only test-origin copies created during this walkthrough were removed; existing public saved workspaces were not touched.
8. At a 320-pixel viewport, usable document/scroll widths were both 305 pixels with zero clipped controls. At 640 pixels, both were 625 pixels. Keyboard shortcuts focused `paper-heading`, `activity-heading`, `graph-heading` and `evidence-heading`; the evidence shortcut selected its tab. The viewport override was reset. These are CSS reflow checks, not a claim of literal browser-chrome 200% zoom or a passed screen-reader audit.
9. A non-PDF input produced the fixed alert **The selected file does not begin with a PDF signature. Choose another PDF.** Tools stayed unregistered and intake remained usable. Retrying with GW150914 succeeded with 16/16 navigable pages and six tools. Its SHA-256 was `e5e864c23d015b69be17e5b5d51b5b462d2829353a867513414b6728f54589c4`, confirmed by `callback:79d7bc94-dc39-44bd-9ccb-51df5db31e8a`. Search returned no Attention reader node, and an annotation using the actual Attention anchor was rejected with `not_found_in_active_paper`. Browser warnings/errors were empty in that retry flow.
10. The original weak-text fixture retained 4/4 navigable pages and explicitly reported three limited pages (`callback:11704223-c64e-4958-abe7-7f544e65cc8a`). Page 3 rendered with **Page 3 has no usable embedded text. Use a page or figure region.** There were no browser warnings/errors.
11. The final artifact's demo button downloaded the official 15-page PDF and admitted the exact recorded SHA-256 (`callback:def217fb-664e-425d-9599-9d10c3fd1b30`). A narrow-width panel-switch/resize sequence had exposed Sigma's own scheduled frame running after its panel became hidden. The pinned library's supported `allowInvalidContainer` setting now handles that transient state; a separate visible-container check still exposes a truthful outline fallback. A regression executes the actual installed Sigma resize implementation. Repeating 320→Evidence→640→reset→Map on the final artifact retained the graph and active outline with no new errors; the prior tab's diagnostics retained only the two pre-fix entries, identifiable by their older fingerprint/timestamp.

## Final publication and remaining verification

Final locally verified runtime fingerprint: `a07d8f0298ea88939a3c30bca5c6593ce329ea3e395017f61e48135f8626fe90`. The exact source checkpoint, Pages run and fresh public callbacks will be recorded after publication.

**Verification Pause 3 remains required.** The owner should inspect the deployed end-to-end flow with keyboard and their actual screen reader, including a literal 200% browser-zoom pass, source/graph navigation, region descriptions and error announcements, human Undo/Redo, Save/reopen, and cancellable Clear. Windows high-contrast/forced-colors and reduced-motion behavior still need human visual/assistive inspection. Do not describe the app as accessibility-certified or item 10 as fully owner-accepted before that review.

After that inspection, item 11 consolidates the final public release matrix and judge-facing documentation; item 12 prepares the narrated demo and submission handoff. The current changes do not claim a finished Devpost submission or authenticated service.
