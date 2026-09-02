# PaperPilot judge guide

PaperPilot is an accessibility-first scientific reading workspace. The redesigned WebMCP Challenge experience keeps the actual multi-page PDF in the middle, removes the detached transcript, generates an honest whole-paper structural map, and lets a browser research mentor read, navigate, explain, annotate, and reversibly evolve source-grounded knowledge. Paper-supported claims carry page references, graph/annotation edits and human reversals retain receipts, and mentor background or external material remains separately labeled rather than being attributed to the paper.

The canonical product contract is the guided [Scope](hackathon-build/scope.md), [PRD](hackathon-build/prd.md), and [technical Spec](hackathon-build/spec.md).

## Current status: submitted six-tool public release, scoped human-QA deferral

**[PaperPilot is submitted on Devpost](https://devpost.com/software/paperpilot-kjglan)** for The WebMCP Challenge. The official Devpost MCP recorded submission `1153491` at `2026-09-02T13:52:21.663-04:00`, and a separate live `get_project` readback confirmed it; see the [dated submission record](release/DEVPOST-SUBMISSION-2026-09-02.md). This verifies the submission, not completion of the deferred human accessibility/access checks.

The [public reader](https://patrickjcraig.github.io/PaperPilot/webmcp/?release=9dd6bd5) hosts the centered continuous PDF, spatial annotations, whole-paper structural map, six-tool WebMCP suite, reversible graph/annotation edits and human Undo/Redo. The annotation toolbar is directly above the PDF. The reproduced source checkpoint is `9dd6bd561b3fc628907e797442a252b5a8012379`, with runtime fingerprint `a0d5f6636b0eace96e04011526450f0942a6a797ee5d8fafda9faf2bbf8b7167`, deployed by [Pages run 33647998514](https://github.com/patrickjcraig/PaperPilot/actions/runs/33647998514). Its current proof combines the same-release Attention recording with fresh public GW150914, weak-text and unsupported-input checks. The query refreshes cached entry HTML; the observed fingerprint and deployment record bind the evidence, not the query alone.

The [current release proof index](release/PUBLIC-RELEASE-REFRESH-2026-09-02.md) distinguishes public, local and automated results. Its 36 successful receipts include all six native tool types on both Attention and GW150914, exact-source graph/annotation changes, source reopening and exact three-digest recovery through UI-only Undo/Redo. Reader-side controls in these runs were operated by an agent tester, not a human accessibility reviewer. These are repeat tests of previously used specimens, not new unseen-paper claims. The [historical `673726c` proof](release/PUBLIC-RELEASE-PROOF-2026-09-02.md), [hardening record at `274c739`](release/RECOVERY-ACCESSIBILITY-HARDENING-2026-09-02.md) and [two-tool August 30 record](release/WEBMCP-LIVE-PROOF.md) retain their original source identities and counts. Primary keyboard/screen-reader flow, graph accessibility and literal 200% browser zoom remain unverified despite the completed hackathon submission; forced-colors/reduced-motion human inspection is also not claimed. Second-machine access is separately owner-verified for this entry as recorded below.

The [narrated demo is available on YouTube](https://youtu.be/EDpbN35rDfQ), with [separate captions](demo/PaperPilot-WebMCP-demo.srt) and [recording evidence](release/DEMO-RECORDING-2026-09-02.md). Owner Studio showed Public visibility and the uploaded filename `PaperPilot-WebMCP-demo.mp4`. The Chrome player showed 2:30 and Studio 2:31, both below three minutes; an anonymous in-app-browser page rendered the video's opening screen. The participant confirmed clear narration on the upload; see the [video verification](release/YOUTUBE-VERIFICATION-2026-09-02.md). The video discloses edited capture timing and synthetic narration; these video checks do not certify application accessibility. Actual Devpost submission is verified separately by the official record above, not inferred from video publication.

## Judge flow and verification scope

The owner has verified second-machine access for this hackathon entry. The [current human-review record](release/HUMAN-RELEASE-REVIEW-2026-09-02.md) distinguishes that attestation from the earlier Microsoft Edge test without a screen reader; second-device browser/OS, anonymous-session details and native WebMCP execution are not inferred. The approved hackathon-only deferral now covers three remaining controls: primary keyboard/screen-reader flow, graph accessibility and literal 200% browser zoom. Those three remain unverified, not passed, and their manifest flags remain false. These limitations remain public, and broader production acceptance still requires those checks. The [exact release-freeze procedure](release/HACKATHON-FREEZE-PLAN-2026-09-02.md) is prepared; the verified submission does not establish future enforcement of that procedure.

Use this flow for live inspection. These steps include variations beyond the recorded demo; the [recording proof](release/DEMO-RECORDING-2026-09-02.md) identifies the actual captured sequence. An inspection instruction is not itself evidence that its action was recorded:

1. Open the anonymous public HTTPS release in a recorded supported WebMCP client.
2. Choose **Open the live demo** for the recorded Attention v7 specimen, or upload your own admitted PDF. Show multiple actual pages in the dominant middle surface, mentor left, Graph/Evidence right, and no persistent source transcript. A rehearsed demo paper is not presented as previously unseen.
3. Show the automatic whole-paper structural map. Distinguish outline/heading/page-range structure from later semantic ideas; every navigable page has honest coverage.
4. Highlight a difficult sentence directly on the PDF. Show the PDF-space anchor, annotation, and related graph focus.
5. Ask the browser mentor to use PaperPilot. Show observed `paperpilot.read_focus`, `paperpilot.read_graph`, `paperpilot.stage_explain`, and `paperpilot.apply_graph` callbacks—not merely tool registration.
6. Read the graph-aware undergraduate explanation and inspect its paper anchors, mentor-background labels, limitations, and new grounded concept/main-idea node.
7. Select that graph node and show `paperpilot.focus_source` return to the exact PDF annotation.
8. Ask the agent to update or remove the node. Show the applied revision/tombstone, then use human-only **Undo** and **Redo**.
9. Select a figure or region and provide a reader description. Show `paperpilot.apply_annotation`, graph linkage and source return, with `locator_only` and `pixelUseVerified: false`; do not present the mentor's interpretation as verified pixel observation.
10. Open the Evidence tab. Close on source anchors, observed callbacks, workspace revisions, trusted inverse, Undo/Redo, immutable original PDF, no PDF export, public repository, and MIT license.

## Released WebMCP capabilities

The released suite has six frozen registrations. Each appeared in the public native-client walkthrough; registration and callback execution are recorded separately:

| Tool | Bounded capability |
| --- | --- |
| `paperpilot.read_focus` | Read only the active page-minted spatial source plus a bounded related graph slice. |
| `paperpilot.read_graph` | Read a bounded current-paper overview, focus/issued-node neighborhood, or literal label/summary search with typed filters. |
| `paperpilot.focus_source` | Navigate an issued anchor/node/edge/structural section to its current-paper PDF evidence. |
| `paperpilot.stage_explain` | Stage one schema-valid, source-and-graph-bound research-mentor explanation. |
| `paperpilot.apply_graph` | Request one revision/digest-checked, atomic, source-grounded graph command batch. |
| `paperpilot.apply_annotation` | Request one revision/digest-checked annotation batch against trusted issued anchors. |

Explanation Save/Discard remains human-only. Valid graph and annotation changes may apply immediately after the trusted reducer validates them and retains their inverse, but the agent cannot call Undo, Redo, Verify, Save, Discard, hard purge, raw-coordinate mutation, cross-paper linking, PDF replacement, or annotated-PDF export.

The current recorded client is **Codex desktop In-app Browser on Windows, tested 2026-09-02**. Browser/model build strings were not available in that run and are not invented. Exact Codex/Chromium versions in the historical August 30 record apply only to that older test. This page does not provide its own model service: invoke the six tools through a compatible browser agent. Without WebMCP, the local PDF, graph and annotation controls remain usable, but no native mentor execution is claimed.

## Supported PDF and recovery contract

The common pipeline admits PDFs up to **25 MiB and 200 pages**. The optional Attention download is explicitly requested and fingerprint-checked; local uploads receive their own byte identity without title/author-specific parsing. Unsupported, corrupt, encrypted or oversized PDFs fail honestly with no substituted content. Pages with weak embedded text keep a page/region route where rendering succeeds; OCR and universal PDF support are not claimed.

A previously unseen admitted PDF must use this same pipeline; rehearsed QA inputs are not described as unseen.

The public reader needs no account, Supabase connection or local database. Human Save controls opt into a **4 MiB**, exact-PDF-SHA-qualified browser snapshot containing graph/annotation records, bounded reversible history and saved mentor notes. PDF bytes and unsaved mentor drafts are not persisted. Reupload byte-identical PDF data to restore; a same-name file with different bytes cannot restore it. The browser's saved state is not synchronized across devices.

Older saved versions are preserved during ordinary loading, migration and Save. **Clear saved copies** requires a persistent **Confirm clear** or **Cancel clear** choice and removes only the known saved versions for this paper. It leaves the open paper, annotations and graph intact. Failed/quota-limited saving reports **Not saved in this browser** and keeps valid live state.

## What the automatic map means

“Whole-paper map” means every navigable admitted page receives honest structural coverage through the PDF outline, conservative heading detection, or a deterministic page/page-range fallback. It does not mean the agent has semantically understood every page. Semantic nodes are separately labeled as paper-grounded, mentor background, or reader-authored; paper-grounded nodes and edges require compatible page anchors.

Graphology is the canonical in-memory topology and Sigma is the supplemental visual renderer. An equivalent keyboard/screen-reader DOM outline exposes the same semantic nodes, relations, authorities, and source actions. Sigma layout/camera state never enters evidence or semantic digests.

## What the evidence trail proves

The trail can show:

- immutable PDF identity and the exact text, page, figure, or region anchor;
- page/rotation/PDF-space geometry, bounded context, available caption, and content digests;
- automatic structural authority versus paper-grounded, mentor-background, or reader-authored semantic authority;
- the observed WebMCP registration and callback receipt—without hidden model reasoning;
- workspace base revision/digest, graph and annotation sub-digests, forward change, trusted inverse, and affected records;
- source navigation between a graph item and the exact annotation;
- the human Undo or Redo revision without erasing the agent's original mutation;
- the unchanged staged mentor proposal, separately labeled external citations, and optional reader takeaway; and
- the reader's explanation Save/Discard decision.

The trail does not prove scientific truth, citation authority, model identity, hidden reasoning, semantic completeness, or that a digest establishes authorship. Figure/region evidence in this release is **`locator_only` with `pixelUseVerified: false`**. Reader descriptions and mentor interpretations remain labeled as such; the current product does not promote a diagnostic answer or human click into verified pixel authority. New mentor notes distinguish per-claim authority and exact references; historical string notes remain **Legacy · unclassified**, and unavailable saved sources remain **Source incomplete** rather than linking to substitutes.

## Accessibility implementation and pending human proof

The participant reports manual application testing in **Microsoft Edge**, explicitly without a screen reader. That earlier report alone did not establish native WebMCP execution in Edge, keyboard-only acceptance, literal 200% zoom or another-machine access; specific outcomes and client versions were not supplied. The owner subsequently verified second-machine access for this entry. The [dated owner-report record](release/HUMAN-RELEASE-REVIEW-2026-09-02.md) keeps the two reports distinct without inventing second-device details or native WebMCP proof. Screen-reader acceptance remains unverified.

The implementation targets these primary-flow requirements; the paragraph below distinguishes recorded technical checks from outstanding human acceptance:

- semantic reading order is Paper → Mentor → Knowledge graph → Evidence even when CSS places the mentor visually left;
- upload, page navigation, zoom, source creation, graph outline, explanation, graph/annotation revision, Undo/Redo, source return, evidence, Save, and Discard are keyboard operable;
- every visual annotation has a nonvisual list entry with source kind, page, description/quote, authority, origin, state, and graph links;
- the DOM graph outline remains fully usable when Sigma is unavailable or motion is reduced;
- map readiness, mutation, rollback, Undo, Redo, source focus, explanation readiness, errors, and decisions are announced without unexpected focus movement;
- exact document text, rendered-view observations, structural inference, paper grounding, mentor background, agent mutation, and human reversal never depend on color alone; and
- the complete journey is designed for 200% browser zoom, 320 CSS-pixel reflow, visible focus and reduced motion; only the recorded reflow/focus checks have passed so far.

Production-handler tests and native keyboard/reflow checks are recorded; 320/640 CSS-pixel checks are not literal browser-chrome 200% zoom. **Owner Verification Pause 3 remains open** for actual screen-reader use, the literal 200% pass, forced-colors/reduced-motion inspection and complete end-to-end acceptance. Only assistive technologies and paths actually tested against the released candidate may be claimed. No accessibility certification is asserted.

## Failure and fallback behavior

The judge flow distinguishes WebMCP unavailable, partial/failed registration, no active focus, read without explanation, invalid explanation, stale revision/digest, foreign graph/source key, grounding failure, invalid atomic patch, reducer rollback, snapshot quota failure, unavailable page, Sigma failure, invalidated Undo, and Redo invalidated by a divergent edit. Every state stops at the last event PaperPilot actually observed and preserves recoverable work.

If a local review path is offered, its exact persistent label is **Local review—WebMCP was not invoked**. It appears in status, response, evidence, and any saved note. It may demonstrate local UI but never counts as WebMCP proof or receives native-success styling.

## Immutable PDF and same-paper boundary

The original PDF bytes remain read-only. Annotations are PaperPilot DOM/SVG overlays bound to PDF-space coordinates. There is no PDF writer, modified-PDF download, or annotated-PDF export in this release. IDs are future-ready for multi-paper work, but current read, navigation, graph, and annotation commands reject foreign paper references before disclosure or mutation.

## Judge access and local verification

The public slice opens anonymously and requires no owner session or judge credentials. A fresh public native-client run is recorded. The owner has separately verified second-machine access for this hackathon entry; this does not establish an independent judge's review, the second device's browser/OS, its session state or native WebMCP support. See the [human-review record](release/HUMAN-RELEASE-REVIEW-2026-09-02.md). Any later authenticated judge credentials belong only in Devpost's private testing-instructions field—never this repository.

To build and serve the actual Pages artifact from a clean checkout with a supported Node.js release:

```bash
npm ci --ignore-scripts
npm run typecheck:webmcp
npm run test:webmcp:contracts
npm run test:webmcp:pages
npm run webmcp:pages:build
npm run webmcp:pages:serve
```

Open `http://127.0.0.1:4175/webmcp/`. Authored files are [`index.html`](../spikes/webmcp-contract/index.html), [`app.mjs`](../spikes/webmcp-contract/app.mjs), the six-tool [`contracts.mjs`](../spikes/webmcp-contract/contracts.mjs) and their shared modules. The packager emits `.paperpilot-pages/`; the old `public/webmcp/paperpilot.js` adapter is not this deployment's runtime.

Run `npm run devpost:check -- --phase technical` for artifact/technical-proof readiness and `npm run devpost:check` for the full submission gate. The three deferred human accessibility flags remain false, so the strict full gate is not made green by the completed video, verified Devpost submission or owner-verified second-machine access. Repository `npm test`, `npm run typecheck`, `npm run lint` and `npm run build` remain additional regression gates; the Next.js build is not a substitute for packaging `/webmcp/`.

The browser-local demo at `/` and authenticated `/app` service are supporting context, not substitutes for the released `/webmcp/` native-client proof.

## Release evidence and remaining checks

The current public matrix combines the same-release Attention recording with fresh September 2, 2026 GW150914, weak-text and unsupported-input checks, without paper-specific code/config changes:

| Public input | Observed result |
| --- | --- |
| [Attention, 15/15 pages](release/DEMO-RECORDING-2026-09-02.md) | Thirteen successful callbacks cover all six tools. A reader-created exact source supports a new agent node, edge and question; two Undo/Redo actions restore all three baseline/final digests. The unsaved version-2 seven-section explanation discloses the captured fragment's incomplete word boundary. |
| [GW150914, 16/16 pages](release/PUBLIC-RELEASE-REFRESH-2026-09-02.md) | Fifteen successful callbacks cover the same six-tool, exact-source edit, digest round-trip and unsaved seven-claim flow. Final native navigation and visible PDF state both return to page 1. |
| [Weak-text fixture, 4/4 pages](release/PUBLIC-RELEASE-REFRESH-2026-09-02.md) | Eight successful callbacks. Three pages stay explicitly limited. A reader whole-page-3 annotation links to a node found and focused through native tools; one Undo/Redo pair restores all three digests, and the post-history native jump visibly returns to page 3. The source remains `locator_only`, without invented extracted text or pixel verification. |
| Foreign source and non-PDF input | A foreign-paper `focus_source` request in the GW run is rejected with `not_found_in_active_paper`, with unchanged source and semantic digests. Invalid signature is rejected before registration, native discovery finds no tools, and the subsequent weak-text retry succeeds. |

Browser warnings/errors were empty in all three PDF runs. The [machine-readable receipts](release/public-release-proof.json) and current release narrative carry the callback and artifact identities. The toolbar release recorded **655 WebMCP tests plus four packaging tests**, typecheck and focused lint; the evidence refresh separately passed **14/14 readiness-validator tests** and **63/63 technical controls**. The root service's full suite and Next build were not rerun for that update. The historical `673726c` proof retains its **1,371-test** total and its original screenshots; neither those counts nor those images are relabeled as current-release verification. A repeated known fixture exercises the shared arbitrary-PDF implementation but is not a newly unseen-paper evaluation.

| Evidence | Recorded scope |
| --- | --- |
| [Current release proof index](release/PUBLIC-RELEASE-REFRESH-2026-09-02.md) | Source `9dd6bd5`, runtime `a0d5f663…`, Pages run `33647998514`, 36 successful receipts, explicit negative checks, exact history/source recovery and remaining gates. |
| [Verified Devpost submission](release/DEVPOST-SUBMISSION-2026-09-02.md) | Official MCP submission `1153491` for The WebMCP Challenge, recorded at `2026-09-02T13:52:21.663-04:00` and confirmed by separate live `get_project` readback; human-QA deferral remains explicitly separate. |
| [Historical source-return/context proof](release/PUBLIC-RELEASE-PROOF-2026-09-02.md) | Source `673726c`, runtime `d66782d3…`, Pages run `33640830540`; the dated matrix, screenshots and 1,371-test result remain evidence for that release. |
| [Recovery/accessibility hardening](release/RECOVERY-ACCESSIBILITY-HARDENING-2026-09-02.md) | Source `274c739`, public Attention all-six callbacks, source-linked graph/annotation edits, seven-claim note, exact Undo/Redo digests, keyboard/reflow checks; local recovery, weak-text and retry/isolation evidence. |
| [Claim-level mentor proof](release/MENTOR-PROVENANCE-ACCEPTANCE-2026-09-02.md) | Version-2 claim/source/graph coverage, unrelated-paper region interpretation, missing-source recovery and safe citation rejection at its recorded release/origin. |
| [Six-tool integration proof](release/WEBMCP-INTEGRATION-ACCEPTANCE-2026-09-02.md) | Native reads/navigation/stage/mutations, disposal and safe failures at its recorded release/origin. |
| [Graph interaction proof](release/GRAPH-INTERACTION-ACCEPTANCE-2026-09-01.md) | Graph/outline/source equivalence, pointer and keyboard arrangement without semantic changes. |
| [Historical two-tool proof](release/WEBMCP-LIVE-PROOF.md) | August 30 source `c99a42…`; earlier read/stage evidence only, not current capabilities. |

Current public matrix evidence is recorded separately from earlier/local runs. The [YouTube demo](https://youtu.be/EDpbN35rDfQ) has verified Public visibility, displayed duration below three minutes and participant-confirmed clear narration. The [Devpost entry](https://devpost.com/software/paperpilot-kjglan) is submitted with its own official verification record. Second-machine access is owner-verified for this entry; the three remaining human controls are deferred as disclosed above, not passed. The freeze plan is prepared; future freeze enforcement remains separate from submission confirmation. The [public repository](https://github.com/patrickjcraig/PaperPilot) carries the root [MIT license](../LICENSE).
