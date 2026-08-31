# PaperPilot six-capability WebMCP contract spike

Status: owner Verification Pause 1 was rejected on 2026-08-30. The candidate contract and correction remain provisional, checklist item 1 remains unchecked, and fresh owner approval is required. This is a removable localhost spike, not the released `/webmcp/` Reader and not a production-proof substitute.

## Exact-paper correction after owner rejection

The owner then rejected the center document itself: it was a hand-authored HTML facsimile rather than the publication. That defect is now corrected in the candidate spike, but the pause remains unapproved until the owner inspects it.

- The center surface fetches the local-only, version-pinned `Attention Is All You Need` arXiv v7 PDF and fails closed if it is absent or changed. The verified response is 2,215,244 bytes, 15 pages, and SHA-256 `bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697`.
- The browser renders real PDF pixels and a selectable PDF.js text layer. There is no detached transcript and no fabricated fallback paper.
- The seeded evidence is one contiguous sentence from page 1. PaperPilot resolves it across PDF.js spans with a DOM `Range`, merges it into three live line rectangles, converts those rectangles to PDF-space quads, and paints the provenance highlight from that page-owned geometry.
- Page and zoom controls operate across all 15 pages. A live browser check navigated to page 3 and found the real `Figure 1: The Transformer - model architecture.` text. The page-1 highlight is explicitly hidden on other pages and reappears only when page 1 is rendered.
- A zoom check from 136% to 151% kept the first highlight rectangle aligned within sub-pixel rounding: normalized `x` moved from `0.324132` to `0.323871`, and normalized width from `0.443383` to `0.443707`.
- WebMCP registration now waits until PDF signature, byte length, byte digest, page count, text match, and browser geometry all verify. The corrected page registered all six tools with no browser warnings or errors.
- The named browser client returned real paper identity and exact source data through `paperpilot.read_focus`, then applied a reversible annotation at revision 1→2 with callback `callback:b6533ce1-5d1c-42bc-b73a-c18b36c4efdb`. Human Undo restored the fixture-only state at revision 3. A fresh reversible annotation was then applied at revision 3→4 with callback `callback:8f6aeaec-f829-4832-98ea-02970ea79588` and remains visible for owner inspection in the current page session.
- The paper bytes are intentionally excluded from Git because the arXiv non-exclusive distribution license is not PaperPilot's MIT license. The tracked source manifest records the official URL, authors, DOI, observed transport ETag, and independently computed body digest separately. `npm run spike:webmcp:paper:fetch` reproduces the local fixture and `npm run spike:webmcp:paper:verify` verifies it without a network request when present.

## Provisional decision

- Keep all six separately registered tools. The named client registered and invoked every capability; there is no evidence-backed reason to consolidate them.
- Retain a candidate structured-input ceiling of 32 KiB canonical UTF-8 JSON and a candidate structured-result ceiling of 48 KiB UTF-8 `JSON.stringify` output. The named client delivered and parsed a 57,407-byte graph result, leaving 8,255 bytes of transport headroom below the release ceiling; the ceiling is not finally frozen until the repeated owner pause passes.
- Retain `locator_only` with `pixelUseVerified: false` as the honest candidate visual-evidence mode. The client navigated to and read the page-minted visual locator, but the controlled pixel A/B answer could not be independently captured and committed before reveal.
- Keep `pdfjs-dist@6.3.289`, `graphology@0.26.0`, and core `sigma@3.0.3` exactly pinned. `annotpdf` and React Sigma bindings are absent.
- Keep Save, Discard, Verify, Undo, Redo, PDF export, PDF-byte mutation, hard deletion, raw input geometry, trusted paper identity, and cross-paper authority outside the WebMCP surface.

## Owner-feedback correction contract — live evidence recorded; owner approval pending

The first owner review did not pass. The annotation created during the earlier live agent session was gone when the owner inspected the page, and the page had no spatial callback marker showing where an observed agent callback applied. Prior receipts prove that callbacks ran in their original page session; they do not prove that the resulting review state remained legible for a later owner.

The correction must preserve two deliberately different state classes:

- **Deterministic demo fixture hydration:** every fresh demo load may seed the same clearly labeled paper, graph addition, and source-linked sample annotation so the owner and judges can inspect a stable review target. Hydrated records must identify themselves as demo-fixture data. They must not be represented as restored agent work, durable user data, or evidence that a prior browser session persisted.
- **Session-only live mutations:** graph and annotation commands issued by the real WebMCP client remain memory-only in this disposable spike. They may update the hydrated fixture for the current document lifetime, but reload creates a new fixture and clears live history, replay keys, callback receipts, and live mutations. The page must state this boundary plainly.

Every observed callback also needs a page-owned provenance pointer. The pointer is driven by the structured callback result and a page-minted anchor or affected entity; it must identify the observed tool, status, callback receipt, and exact source/graph/annotation target. It may move a visible marker or focus ring to that target, but it must not imply eye tracking, an agent-controlled mouse cursor, access to hidden chain of thought, or scientific verification.

Focus truth remains narrower than reasoning truth. `focus_source` may scroll and move DOM/keyboard focus to a validated page-owned target after its callback. Read, explanation, mutation, and replay callbacks may update visible provenance markers without stealing keyboard focus. The UI may describe only the callback and target PaperPilot observed; it must never claim to expose why the model internally chose an action or any hidden reasoning.

The correction has now been exercised in a fresh named client as recorded below. That run supports fixture hydration, one live mutation, visible provenance-pointer placement, visual pointer replay without a workspace mutation, fresh-tab reset, and a manual non-stealing keyboard-focus trial. It does not constitute owner approval.

### Fresh correction-specific client evidence

On 2026-08-30 America/New_York, the Codex In-app Browser loaded `http://127.0.0.1:4175/` and reported `Registered 6 / 6`. The fresh page showed workspace revision 1, exactly one annotation labeled as demo-fixture data, its visible on-paper annotation chip, and the provenance cursor in its ready state. Browser diagnostics contained no warning or error entries.

The client then returned these actual structured callbacks:

| Capability | Status | Callback receipt | Visible or structured effect |
| --- | --- | --- | --- |
| Read focus | `ready` | `callback:7678529f-0350-4537-986e-0128e3e75a4f` | Read the active page-owned exact-text source |
| Read graph | `ready` | `callback:ab390580-0c89-4fa7-b49b-2e08a1053c6d` | Read the current fixture graph and workspace digests |
| Apply annotation | `applied_reversible` | `callback:940593c7-8fdf-4c6e-8ad8-3126011064a9` | Advanced revision 1→2 and added `Agent edit — direct attention replaces recurrence` |

After the annotation callback, the paper showed two source chips—the labeled fixture annotation and the live-session agent edit—plus a parked provenance pointer and a human visual-replay control. Activating visual replay re-presented the last observed callback target while workspace revision remained 2; it did not reapply the annotation or create another semantic revision.

A separate fresh tab loaded revision 1 with exactly the single labeled fixture annotation. The live-session annotation was absent. This is direct client evidence that demo-fixture hydration is deterministic while live mutation state remains session-only; it is not a claim of durable user persistence.

The source implements a non-stealing policy for non-navigation callback markers and reserves scroll/keyboard-focus movement for explicit human navigation. A fresh manual trial first used the human **Focus region A** control, which placed keyboard focus on `visual-region-a`. The named client then called `paperpilot.focus_source` for `anchor:text:attention`; PaperPilot returned `callback:924c234e-1295-465b-8bcd-c0bd900df6e2` with `status: focused`, moved the visible provenance pointer to the exact-text source, and left keyboard focus on `visual-region-a`. Browser warning/error diagnostics remained empty. The pointer continues to mean only “PaperPilot observed this structured callback and mapped it to this page-owned target”; it does not expose hidden reasoning, eye tracking, or an agent-controlled mouse.

## Candidate artifacts

- `spikes/webmcp-contract/contracts.mjs` — six closed input schemas, six closed local result/error schemas, runtime result validation, limits, in-memory active-paper state, graph/annotation reducer spike, idempotency, and registration lifecycle.
- `spikes/webmcp-contract/contracts.test.mjs` — focused dependency, schema, limits, same-paper, atomicity, replay, Undo, and lifecycle tests.
- `spikes/webmcp-contract/pdf-viewer.mjs` and `pdf-viewer.test.mjs` — fail-closed exact-PDF integrity checks, current-page PDF.js canvas/TextLayer rendering, navigation/zoom lifecycle, exact-text range mapping, PDF quads, and focused geometry tests.
- `spikes/webmcp-contract/assets/papers/attention-is-all-you-need-1706.03762v7.source.json` — tracked source, licensing-boundary, transport-observation, and independent byte-integrity manifest. The PDF bytes beside it remain ignored.
- `spikes/webmcp-contract/index.html`, `app.mjs`, and `spike.css` — isolated visible diagnostic with the real paper centered, on-paper provenance geometry and cursor, Graphology, Sigma, accessible outline, activity receipts, human-only Undo/disposal, and a separately labeled sealed visual-region trial.
- `scripts/fetch-webmcp-paper-fixture.mjs` — explicit HTTPS arXiv fetch and fail-closed local byte verification helper.
- `scripts/serve-webmcp-contract-spike.mjs` — localhost-only server that exposes the spike plus traversal-safe, same-origin Graphology, Sigma, and PDF.js module/worker/font/CMap/WASM routes and nothing else in the repository.

The running spike writes no local database, Supabase data, browser storage, or PDF bytes. It reads the explicit ignored PDF fixture from the spike directory. Only the separately invoked fixture-fetch helper accesses arXiv over the network.

## Named-client tuple

| Field | Observed value |
| --- | --- |
| Date | 2026-08-30 America/New_York; page events recorded from 2026-08-31T00:23:54Z |
| Client | Codex In-app Browser (`iab`), production build flavor |
| Exact Codex/browser build | Not exposed by the client API; no version is inferred |
| Browser family | Chromium-family in-app client; exact Chromium version not exposed |
| Model | Exact model identifier not exposed by the WebMCP/browser client; no hidden-reasoning claim is made |
| OS | Microsoft Windows NT 10.0.26200.0, `en-US`, Eastern Time |
| URL | `http://127.0.0.1:4175/` |
| Base Git commit | `57632275a09f6fd5543e1326dcfe9f7539f1bf6d`; candidate changes remained uncommitted pending owner approval |
| Runtime | Node.js 24.11.1, npm 11.12.1 |

## Candidate registration surface

The client reported `Registered 6 / 6` and exposed exactly these names after a fresh load and again after a hard reload:

1. `paperpilot.read_focus`
2. `paperpilot.read_graph`
3. `paperpilot.stage_explain`
4. `paperpilot.apply_graph`
5. `paperpilot.apply_annotation`
6. `paperpilot.focus_source`

The current WebMCP imperative draft registers only `inputSchema`. PaperPilot keeps result/error schemas locally and validates every result before returning it; it does not send a speculative `outputSchema` field to the client.

### Schema manifest

| Tool | Input schema SHA-256 | Result/error schema SHA-256 |
| --- | --- | --- |
| `paperpilot.read_focus` | `99334726611ccf58a148b0814696bfa6fe08c1b2d027e946beccf5a74331c9aa` | `b37fc66a735a9eea9207a673749b8520b3fe2c748a5c98e3290fb9e02b601a87` |
| `paperpilot.read_graph` | `da48bee48c019aadd7c4180f05ec6dab4eaacbe8f1aa0c7f298c5f18f7650e39` | `e184293509bd59f4d6a3f05e4100f6ad1555a036a662a851ab8612a38b545bc6` |
| `paperpilot.stage_explain` | `7f73ef0cd3ce024c5e469d347189f55f44fd51f2dccb7ebf7ce2e8bbd4f3f524` | `8e713dcb6facde6d0f2cf5717877a3303594c013804d443fcbc4ae589180723e` |
| `paperpilot.apply_graph` | `f0be90bcebdc416ac69f759f120f322ea8267dfdd23fa786103be76f2882e39d` | `e816f8d4d82ee26522da1d9c37ac56195e1b0df7f4712616f8f91f9fba944f39` |
| `paperpilot.apply_annotation` | `86725fa1f394bd9335fb7fcdc41b38fb16a1196b6ef718f84ff6e1655e1df7e7` | `b3e52085cfc7cb2d0394443442b696d0a77ecc735ff4f0488b00644a9f6d2f24` |
| `paperpilot.focus_source` | `610accf3cf9f93f66ff4f3c3641a1b0b2a272d2b476c4bc38675d1c43ae26773` | `dc3cb3287eb2ebe8ed5b5b60f615e597c03a81727685cdbbad3da88e964cd9e0` |

Combined canonical schema-set SHA-256: `ce3a814adb9893f466e79f6e69f537f4d11a481167a314d9f592c605dc312574`.

## Real callback trail

The second fresh-client run exercised the complete six-capability sequence. These are page-minted callback receipts returned through the client, not registration events or copied chat text.

| Capability | Status | Callback receipt | Visible or structured effect |
| --- | --- | --- | --- |
| Read focus | `ready` | `callback:dc8d7c77-5c61-49ad-be3a-6e9ace0a1812` | Returned the active exact-text anchor and current graph/annotation digests |
| Read graph | `ready` | `callback:e6c71aed-4a3b-47d1-9edd-4497cc3c43c8` | Returned the initial 3-node/2-edge current-paper graph |
| Focus source | `focused` | `callback:55992dc2-6c12-4a21-ad03-e89372af897d` | Navigated the issued concept node to `anchor:text:attention` |
| Stage explanation | `staged` | `callback:486eff78-0c05-4414-b37f-5f1e40f6e5cb` | Staged a seven-part undergraduate mentor explanation; nothing saved or verified |
| Apply graph | `applied_reversible` | `callback:d58db2ba-8048-4e51-93ba-50b55a70d9bc` | Advanced revision 1→2; added `Weighted context` and one grounded `enables` edge |
| Read graph after mutation | `ready` | `callback:0fef2d1a-095d-4cb8-aa3e-a60c66292ba8` | Returned the visible 4-node/3-edge graph and current annotation digest |
| Apply annotation | `applied_reversible` | `callback:b85ff2d5-4176-4d0d-872e-8540d8447671` | Advanced revision 2→3; added an exact-anchor annotation linked to the new node and edge |
| Replay identical graph command | `replayed` | `callback:86df6396-c61d-47a4-83a6-31677bdae906` | Returned a fresh callback receipt and the original operation/revision without another semantic change |

The page visibly reported workspace revision 3, Sigma active, four graph nodes, three edges, and annotation `Evidence for weighted context · anchor:text:attention`. Registration events and callback events remained distinct in the activity list.

A final live session repeated all six capabilities and produced receipts `callback:8e9e2b16-def8-4d60-afec-e6c7370f48b8` (focus), `callback:df1cbc47-464a-4069-9ba1-d431b46e3a0a` (graph), `callback:f41b38b6-b2e6-41ad-83ed-5747b2091cc4` (navigation), `callback:66f37049-3fee-4262-a128-4dcdc3ddf95f` (explanation), `callback:8e9aec9c-8f5f-4213-a3a9-c4a69895b1f0` (graph mutation), and `callback:ce2b1668-40db-4413-8bb6-7053c860a943` (annotation mutation). In that original session the page reported revision 3, `Sigma active + outline`, `Weighted context`, and its evidence annotation. The later owner review did not retain that annotation and showed no spatial callback marker, so this receipt set remains prior session evidence only and does not satisfy Verification Pause 1.

The first live pass exposed and then retired one contract bug: `apply_annotation` required an annotation digest that no read tool returned. Both read results now expose the current annotation digest; the focused tests and full live sequence were rerun after that correction.

## Serialized-result evidence and candidate limits

The real client successfully returned and parsed a `paperpilot.read_graph` result containing 54 nodes and 3 edges:

- Serialized UTF-8 size: **57,407 bytes**.
- Status: `ready`; `truncated: false`.
- Callback receipt: `callback:80c3f32f-c897-4765-9192-e874a4537424`.
- A subsequent `focus_source` call using the final returned node record succeeded with receipt `callback:3f5455a4-3e30-45b3-ae70-a9e99ff18622`.

The browser connection became unavailable before a larger follow-up probe could run; the cause is not attributed to result size. The candidate contract therefore does not claim the transport boundary. It currently uses a conservative **48 KiB (49,152-byte)** result ceiling, 8,255 bytes below the largest completed delivery. The 32 KiB input and 48 KiB result byte guards reject before returning partial content; they never silently slice a quote or structured result.

Other candidate ceilings are 50 mutation operations, 600 graph nodes, 1,200 graph edges, 800 annotations, 100/200 graph-read nodes/edges, 40 anchor summaries, 4 MiB recovery snapshot, and 4,096 Unicode scalar values for any otherwise-unbounded free-text field.

## Controlled visual-region result

The live client called `focus_source` for `anchor:visual:a` and then `read_focus`:

- Navigation receipt: `callback:116d2ff6-e90f-45d4-8c4e-d82840665208`.
- Visual read receipt: `callback:7a6e04b6-60b8-4576-8168-6b12330742cd`.
- Tool result: `mode: "locator_only"`, `pixelUseVerified: false`, opaque `visibleRegionId: "visual-region-a"`.
- The answer-bearing randomized pattern descriptors were absent from visible DOM text and tool JSON before reveal; the page exposed only a SHA-256 commitment and generic A/B labels.
- Browser screenshot capture timed out, so no visual answer was committed and the human reveal/proof controls were not used.
- PaperPilot staged an explicit inconclusive visual explanation with receipt `callback:32b39fc9-5301-4422-9b53-ae61528f42a7`.

Prior-run bounded claim: the agent located, navigated to, and preserved provenance for a visible region in this client session. This run does **not** prove that WebMCP returned pixels, that the agent inspected the canvas, or that it can scientifically interpret arbitrary figures. The claim remains provisional until the repeated owner pause.

## Lifecycle and dependency evidence

- One shared registration `AbortSignal` covered all six definitions; focused tests verify complete disposal and abort-on-partial-registration failure.
- A hard reload created a fresh six-tool session. Calling the pre-reload handle afterward failed with `WebMCP tool registration is stale. Call fetchTools() again.` This is real-client evidence that an old page handle cannot invoke the replacement document.
- The human **Dispose tools** control is present and agent-inaccessible. Browser automation could not activate that visible control during this run because the client-side click command timed out; owner verification of that button remains part of Pause 1.
- Graphology ran as a directed multigraph with `allowSelfLoops: false`, parallel evidence edges supported, and explicit keys.
- Sigma 3.0.3 mounted in the actual browser and the page reported `Sigma active + outline`; the accessible outline remained a separate equal interface.
- PDF.js 6.3.289 imported under the dependency smoke and exposed the exact runtime version. The isolated spike uses same-origin pinned Graphology/Sigma bundles and no CDN.
- `annotpdf`, `AnnotationFactory`, PDF writing, annotated-PDF download, React Sigma, database access, and remote fetch code are absent from the spike.

## Verification commands

The exact-paper correction passed:

```text
npm run spike:webmcp:paper:verify             # exact 2,215,244 bytes and bdfaa68d… digest
npm run test:webmcp:contracts                 # 22/22 contract + PDF-viewer tests
node --check spikes/webmcp-contract/app.mjs
node --check spikes/webmcp-contract/pdf-viewer.mjs
node --check scripts/serve-webmcp-contract-spike.mjs
git diff --check
```

Live server checks returned `application/pdf` with the exact byte length, 200 for the pinned PDF.js module, worker, viewer CSS, standard font, CMap, and WASM assets, and 404 for an encoded repository traversal attempt. Browser checks covered all six registrations, exact source return, page 3 navigation, zoom reprojection, page isolation, reversible annotation, Human Undo, and a final visible agent annotation. Browser warning/error diagnostics were empty.

The pre-feedback candidate passed:

```text
npm run test:webmcp:contracts   # 14/14
npm run lint                    # zero errors and zero warnings
npm run build                   # production Next.js build passed
node --check spikes/webmcp-contract/contracts.mjs
node --check spikes/webmcp-contract/app.mjs
node --check scripts/serve-webmcp-contract-spike.mjs
git diff --check
```

The localhost server smoke returned 200 for the spike and exact vendor bundles, rejected plain and encoded traversal attempts, and supplied no-store/CSP/nosniff/no-referrer headers.

The owner-feedback correction now has fresh-client evidence for fixture hydration, live annotation mutation, callback-pointer placement, visual replay without semantic mutation, clean browser diagnostics, fresh-tab reset, and non-stealing agent-originated navigation. The repeated owner inspection and explicit owner approval remain pending.

The correction-specific verification passed:

```text
npm run test:webmcp:contracts   # 16/16
node --check spikes/webmcp-contract/contracts.mjs
node --check spikes/webmcp-contract/app.mjs
node --check spikes/webmcp-contract/contracts.test.mjs
node --check scripts/serve-webmcp-contract-spike.mjs
npm run lint                    # zero errors and zero warnings
npm run typecheck               # passed
npm run build                   # production Next.js build passed
npm test                        # 701/701
git diff --check                # passed
```

The running isolated server returned 200 for the root with CSP and no-store headers, served both exact vendor bundles, returned 404 for traversal attempts, and returned 405 for POST. `npm run devpost:check` remains intentionally red at **42/66**, with **24** open controls. These engineering results do not approve Verification Pause 1 or close checklist item 1.

## Verification Pause 1 — rejected; repeat pending

The owner rejected the first pause because the expected annotation disappeared before inspection and no spatial callback marker contextualized where the observed WebMCP action applied. Checklist item 1 therefore remains unchecked, no checkpoint commit is authorized by this gate, and the earlier activity receipts cannot substitute for a fresh visible review.

Before the repeated pause can pass, a fresh named-client run must show and record:

1. a clearly labeled deterministic demo fixture after initial load and hard reload, including a visible source-linked sample annotation;
2. a separately labeled live WebMCP mutation in the current session, followed by truthful reset behavior on reload rather than a persistence claim;
3. a callback-driven provenance pointer for each exercised capability, with receipt, status, and exact page-owned source or affected graph/annotation target;
4. keyboard focus moving only for explicit validated navigation, while non-navigation callbacks update their marker without stealing focus;
5. UI language that reports observed callbacks and provenance without claiming eye tracking, an agent-controlled mouse, hidden reasoning, or scientific verification;
6. six clean registrations, visible invocation/disposal activity, the human-only **Dispose tools** result, and the honest `locator_only` visual contract; and
7. owner acceptance of the six names and candidate 48 KiB result ceiling.

Correction-specific live evidence is recorded above, including the manual focus-event trial. The repeated pause still requires owner inspection and explicit approval. Until those occur, checklist item 1 stays unchecked and the candidate surface is not finally frozen.
