# PaperPilot Build Checklist

Status: Approved redesign baseline, 2026-08-30

Target: a public, hackathon-ready PaperPilot vertical slice that makes a scientific PDF the primary reading surface, generates an honest whole-paper knowledge map, and lets a WebMCP-capable agent read, navigate, explain, annotate, and reversibly edit source-grounded graph structure with a visible evidence trail.

Approved wow moment: a reader opens an arbitrary born-digital paper, sees its structure become a navigable map, highlights a difficult passage or figure region directly on the centered PDF, and watches the browser agent explain it, add a grounded graph node, jump back to the exact evidence, and then undo the change.

## Build Preferences

- **Build mode:** Autonomous speed-run with focused verification after every item.
- **Participant cadence:** Report completed outcomes, red gates, scope threats, and the next active item; pause only at the three named inspection gates.
- **Git:** Create a checkpoint commit only after a checklist item is green and the repository root is confirmed.
- **Public-first delivery:** Rebuild the anonymous `/webmcp/` experience before porting the same contracts into the authenticated Supabase/Vercel service.
- **Database policy:** No local database writes. Browser-local state may be used only for the anonymous prototype's bounded recovery snapshot; Supabase project `avmcmmayvnjxrhrmgsdx` is the only future durable database authority.
- **Production policy:** The later authenticated service remains serverless. This checklist does not require networking, crawler, Zotero, collaboration, OCR, or cross-paper UI before the public graph-and-annotation proof is green.
- **Authority policy:** Automatic parsing may assert document structure, not paper meaning. Semantic nodes require paper anchors, a reader action, or a clearly labeled mentor-background authority.
- **Mutation policy:** Agent graph and annotation commands apply immediately through a trusted reducer and remain human-reversible with Undo/Redo. Explanations remain staged proposals with separate Save/Discard review.
- **PDF policy:** Keep the experience inside PaperPilot. PDF export is excluded. `highkite/pdfAnnotate`/`annotpdf` is not a runtime dependency for this release; its future byte-writing role is isolated behind PaperPilot's PDF-space geometry contract.

Sizing note: each numbered item is an independently verifiable work package. During execution, split it into 15–30-minute green/red cycles in the build journal without creating extra approval pauses.

## Execution Rules

- Work in dependency order. A red acceptance criterion blocks downstream claims.
- Do not preserve the old transcript layout in the new Reader. Selectable text exists as a PDF-aligned text layer, not as a separate source transcript window.
- Keep six user-facing WebMCP capabilities unless a named-client truth spike proves the client cannot reliably support six registrations. Consolidation may reduce tool count, but may not remove read, navigation, explanation, graph mutation, or annotation mutation capability.
- Register tools only while one PaperPilot document context is active; validate every result at the trusted reducer boundary; never expose Save, Discard, Verify, or hard-delete authority to the agent.
- Treat the existing deployed two-tool demo and its release proof as historical baseline evidence. Do not relabel it as proof of the graph, annotation, Undo/Redo, or redesigned Reader.
- Treat Graphology as the in-memory graph model and Sigma as a visual renderer. The accessible DOM outline is an equal first-class graph interface.
- Reject cross-paper anchors and mutations in this release even though IDs and records are future-ready for multi-paper graphs.
- Every release claim must be supported by the new public build, a dated client tuple, and reproducible evidence.

## Checklist

- [x] **1. Prove the named-client tool and dependency contract**
  Spec ref: `spec.md > Stack > Public vertical slice`; `spec.md > WebMCP Tool Contracts`; `spec.md > Verification Plan > Manual supported-client tests`
  What to build: Create the smallest removable spike that registers `paperpilot.read_focus`, `paperpilot.read_graph`, `paperpilot.stage_explain`, `paperpilot.apply_graph`, `paperpilot.apply_annotation`, and `paperpilot.focus_source` against one active document. Freeze complete closed input/result/error schemas, numeric count/byte limits, idempotency, AbortSignal disposal, unregister behavior, mutation return visibility, and the actual figure/region evidence mode in the exact target client. Hydrate a deterministic, explicitly labeled demo fixture on every fresh load while keeping real agent mutations, replay keys, callback receipts, and history session-only. Add a callback-driven provenance pointer that maps observed structured callbacks to page-owned source, graph, or annotation targets without claiming hidden reasoning or an agent-controlled cursor. Pin and smoke-test `pdfjs-dist`, `graphology`, and core `sigma`; reserve React bindings for the authenticated port unless the spike proves a concrete public-slice need.
  Acceptance: A dated named-client recording shows real focus read, graph read, navigation, explanation, graph-mutation, and annotation-mutation callbacks—including a controlled visual-region evidence test; all six schemas register and dispose cleanly, or an evidence-backed consolidated schema preserves every capability. A hard reload reconstructs the same labeled demo annotation but truthfully clears separately labeled live mutations. Each observed callback leaves a legible pointer with tool, status, receipt, and exact target; only explicit validated navigation may move keyboard focus, and no UI copy claims eye tracking, hidden chain of thought, or scientific verification. The dependency set builds without importing `annotpdf`, and no callback can address a foreign document, raw geometry, PDF export, irreversible delete, or human-decision/Undo/Redo action.
  Verify: Run focused schema/adapter/limit tests, a production build, and fresh-client registration/invocation/disposal trials; record the client/version/OS/URL/commit, tool list, callback IDs, serialized-result ceiling, visual evidence mode, failures, and final frozen schemas. In the owner-review sequence, inspect the deterministic fixture, apply one live graph and annotation mutation, inspect the callback pointer and focus behavior, hard reload, and verify fixture rehydration plus live-session reset. **Verification pause 1:** show the owner the fresh visible activity and provenance trail and freeze the tool surface before broad UI work.
  Gate status: **Owner-approved after the exact-paper correction on 2026-08-30.** The approved slice renders the exact 15-page arXiv v7 PDF, resolves the source through real PDF.js text geometry, keeps its three-line highlight aligned through zoom, navigates to the actual Figure 1 on page 3, registers 6/6 tools only after integrity/geometry verification, and leaves a live reversible WebMCP annotation plus provenance pointer visible. Focused contract/PDF-viewer tests pass 22/22 and browser diagnostics are clean. The owner advanced the loop with: “Now that we have the first iteration done, I want you to work on the annotation to graph functionality.”

- [ ] **2. Make the public `/webmcp/` bundle modular and reproducible**
  Spec ref: `spec.md > File Structure`; `spec.md > Deployment Strategy > Public vertical slice`
  What to build: Move authored code out of the monolithic generated `public/webmcp/paperpilot.js` path into typed modules for document state, anchors, graph state, commands, WebMCP registration, provenance, accessibility, and UI. Add one deterministic build entry that emits the GitHub Pages artifact while preserving the historical release proof separately.
  Acceptance: A clean checkout produces the same public bundle, source maps do not expose secrets or private PDFs, and the new modules can be tested without a browser-global fixture. The old two-tool proof remains labeled as a prior release rather than silently overwritten evidence.
  Verify: Delete only generated build output through the project build command, rebuild from source, run module tests and `git diff --check`, then load `/webmcp/` through the same local static-server path used in CI.

- [ ] **3. Rebuild the Reader around a centered, multi-page PDF**
  Spec ref: `prd.md > Epic 2: Keep the PDF in the middle`; `spec.md > Logical Architecture > Visual and logical layout`; `spec.md > PDF Reader And Annotation Implementation`
  What to build: Put the rendered PDF in the dominant center column, a compact research-mentor surface on the left, and a responsive Graph/Evidence rail on the right. Implement PDF.js as one continuous vertical document with virtualization or bounded page mounting, zoom, rotation-safe geometry, active-page tracking, a direct page locator that scrolls rather than replaces the document, loading/error states, and a positioned selectable text layer per mounted page. Remove the persistent source transcript, page-at-a-time carousel behavior, and any transcript-first affordance.
  Acceptance: An arbitrary admitted born-digital PDF renders as a continuous multi-page paper in the center; ordinary scrolling moves naturally across page boundaries; the page locator and graph/source navigation scroll to the correct mounted page/region; selection remains aligned at supported zooms; the paper stays the dominant surface at desktop and reflow widths; and no persistent transcript window appears in the DOM or visual layout.
  Verify: Run PDF rendering, active-page, locator, and layout tests across at least two unrelated PDFs, zoom levels, rotation metadata, 200% browser zoom, and 320 CSS pixels. Inspect the accessibility tree, page-boundary scroll behavior, and screenshots. Fail the item if the primary reading experience depends on an extracted transcript panel or replacing the visible page for ordinary navigation.

- [ ] **4. Establish spatial anchors and an accessible annotation overlay**
  Spec ref: `prd.md > Epic 3: Mark the exact source`; `spec.md > Canonical Public Data Contracts > Spatial source anchor`; `spec.md > PDF Reader And Annotation Implementation`
  What to build: Define stable PDF-space point, rectangle, and quadrilateral anchors bound to document digest, page, rotation, renderer recipe, and optional exact text. Add PaperPilot-owned DOM/SVG layers for text highlights, arbitrary rectangles, whole figures, figure regions, focus rings, annotation labels, and nonvisual region descriptions. Normalize viewport/PDF coordinate transforms and reject stale or foreign anchors.
  Acceptance: Pointer, keyboard, and screen-reader paths can create, inspect, focus, and remove an exact-text or page-region annotation; overlays remain registered during zoom and resize; source links reopen the same region; and saved geometry can later translate to a PDF byte writer without coupling this release to one.
  Verify: Run geometry round-trip, zoom/rotation, digest-binding, stale-anchor, and keyboard tests on two PDFs. Compare overlay screenshots at multiple scales and audit semantic labels. **Verification pause 2:** the owner inspects centered reading, region selection, and exact source return before graph work proceeds.

- [ ] **5. Generate an honest whole-paper structural map**
  Spec ref: `prd.md > Epic 4: See an automatic whole-paper map`; `spec.md > Automatic Whole-Paper Structural Map`
  What to build: Derive a paper root, outline/heading nodes when available, and deterministic page or page-range fallback nodes for the entire document. Bind every node to page anchors, record extraction confidence and authority, and expose coverage status. Add agent- and reader-authored semantic enrichment separately; never infer main ideas solely from heading detection and call them semantic truth.
  Acceptance: Every admitted PDF receives a complete navigable structural map even when outline metadata or heading extraction is weak. Every node explains whether it came from document structure, paper-grounded semantic evidence, mentor background, or the reader. No page is silently outside map coverage.
  Verify: Run outline-rich, outline-free, multi-column, figure-rich, and weak-text fixtures; assert total page coverage, stable IDs, deterministic fallback grouping, valid anchors, and honest authority labels.

- [ ] **6. Deliver Graphology/Sigma navigation with an accessible outline**
  Spec ref: `prd.md > Epic 5: Understand and navigate the graph`; `spec.md > Graphology And Sigma Integration`
  What to build: Store the active map in `MultiDirectedGraph({ allowSelfLoops: false })` with explicit stable keys, typed nodes/edges, and validated attributes. Render it with Sigma using restrained layouts and selection states while mirroring the same model in a keyboard-operable DOM tree/list. Add graph-to-PDF and PDF-to-graph focus synchronization without relying on graph insertion order.
  Acceptance: Selecting any graph or outline node focuses its exact PDF source; focusing a mapped annotation selects the corresponding node; graph and accessible outline expose identical node/edge facts; and dense/unsupported visuals degrade to the outline rather than blocking reading.
  Verify: Run graph schema, serialization, focus synchronization, keyboard, screen-reader-name, reduced-motion, and large-graph smoke tests. Compare node/edge counts and selected IDs across Sigma, DOM outline, and serialized WebMCP reads.

- [ ] **7. Apply graph and annotation commands through a reversible workspace reducer**
  Spec ref: `prd.md > Epic 7: Let the agent evolve the map safely`; `prd.md > Epic 8: Use Undo and Redo as the soft check`; `spec.md > Canonical Public Data Contracts > Graph revision and command history`; `spec.md > Core Data Flows > Undo and Redo`
  What to build: Define separate closed untrusted command DTOs and trusted canonical records, then route graph and annotation commands through one reducer that clones workspace state, validates authority/anchors/idempotency, computes trusted graph-and-annotation inverse patches, applies atomically, advances workspace/sub-digests, and emits a visible change notice. Implement human-only Undo/Redo stacks and reversible tombstones; compact nothing irreversibly.
  Acceptance: Direct reducer commands add, edit, connect, annotate, tombstone, and restore atomically and can be undone/redone without semantic digest drift. A failed batch changes nothing; duplicate same-key/same-command requests replay; same-key/different-command requests conflict; new edits after Undo clear Redo. Explanations remain staged proposals with separate Save/Discard.
  Verify: Run property-style apply/invert/reapply, semantic workspace-digest, atomicity, tombstone, incident-edge, redo-branch, stale revision, idempotent replay, ID collision, invalid anchor, authority, grounding, persistence, and rollback tests.

- [ ] **8. Replace the old adapter with the richer WebMCP suite**
  Spec ref: `prd.md > Epic 6: Give the browser mentor useful WebMCP tools`; `spec.md > WebMCP Tool Contracts`; `spec.md > Security And Provenance`
  What to build: Implement the frozen schemas from item 1 with strict feature detection, active-document closure, bounded reads, source navigation, structured explanation staging, reducer-backed graph/annotation commands, cancellation, lifecycle cleanup, idempotency, revision/digest checks, and truthful visible activity. Treat all PDF/graph content as untrusted data and prevent external fetches or cross-document disclosure.
  Acceptance: A named browser agent can read current focus and graph, navigate to evidence, stage an explanation, and apply one reversible graph and one reversible annotation revision through the trusted reducer. PaperPilot records only observed callbacks, rejects stale/foreign/invalid payloads with structured errors, and exposes no Save, Discard, Verify, Undo, Redo, export, hard-delete, raw-coordinate, or cross-paper tool.
  Verify: Run contract, lifecycle, abort, prompt-injection, bounds, stale-revision, cross-paper, replay, partial-registration, WebMCP-unavailable, and invalid-payload tests. Then record fresh public-client runs for every capability and correlate client-visible calls with PaperPilot callback receipts and workspace revisions.

- [ ] **9. Make the mentor graph-aware and provenance-first**
  Spec ref: `prd.md > Epic 9: Learn from a graph-aware research mentor`; `prd.md > Epic 10: Follow the evidence and revision trail`; `spec.md > Explanation And Evidence UI`; `spec.md > Canonical Public Data Contracts > Provenance event`
  What to build: Stage a calm research-mentor explanation that uses the focused source plus bounded neighboring graph context, explains jargon and mathematics at undergraduate level, distinguishes paper-grounded claims from mentor background, and generates screen-reader descriptions for selected figures or regions. Present an inspectable evidence trail linking source anchors, graph nodes/edges, observed callbacks, proposed explanation, applied reversible commands, and human decisions without restoring a transcript window.
  Acceptance: Every paper-grounded explanation statement can return to at least one exact source anchor; graph context is labeled and bounded; unsupported claims are surfaced as limits; figure descriptions distinguish observation from interpretation; and the UI never implies access to hidden agent reasoning or scientific verification.
  Verify: Run explanation-schema, anchor-coverage, authority-label, math, visual-description, injection, citation, and missing-source tests; complete exact-text and figure-region walkthroughs on unrelated papers and inspect source reopening from every evidence item.

- [ ] **10. Add recovery, accessibility, and adversarial release hardening**
  Spec ref: `prd.md > Epic 11: Restore safely and prepare for later cross-paper work`; `prd.md > Epic 12: Make the complete journey accessible`; `spec.md > Canonical Public Data Contracts > Browser snapshot`; `spec.md > Accessibility Contract`; `spec.md > Security And Provenance`; `spec.md > Error Strategy`
  What to build: Persist a bounded browser-local snapshot for the anonymous slice, including document fingerprint, map, annotations, revision, and undo/redo history, with explicit reset and version migration. Finish keyboard navigation, screen-reader regions, high-contrast/non-color states, reduced motion, focus restoration, and responsive reflow. Enforce no-export UI, foreign-paper rejection, resource ceilings, sanitized errors, and cleanup of document-scoped registrations and object URLs.
  Acceptance: Reuploading the byte-identical PDF restores its compatible paper state without server or local-database writes; same-name/different-byte, corrupted, or mismatched snapshots fail safely; optional snapshot quota failure leaves valid live state explicitly unsaved; the complete flow works keyboard-only and through the documented screen-reader path; no PDF-export action or byte writer ships; and adversarial PDF text cannot trigger a fetch, unauthorized tool, cross-paper mutation, or disclosure.
  Verify: Run snapshot migration/corruption, registration cleanup, memory, bounds, cross-paper, no-export, injection, keyboard, screen-reader, 200% zoom, 320px reflow, contrast, and reduced-motion checks. **Verification pause 3:** the owner reviews the public end-to-end flow, Undo/Redo, accessibility path, and failure behavior.

- [ ] **11. Produce and deploy the redesigned public release proof**
  Spec ref: `prd.md > Release Acceptance Matrix`; `spec.md > Verification Plan`; `spec.md > Deployment Strategy > Public vertical slice`
  What to build: Deploy the exact redesigned bundle to public HTTPS, bind it to a release commit, and create a sanitized proof record covering tool registrations, real callbacks, structural coverage, spatial anchors, graph navigation, reversible edits, Undo/Redo, explanations, evidence, accessibility, no-export, and cross-paper rejection. Update README, judge guide, compliance gates, demo plan, and machine-readable requirements with only reproduced claims.
  Acceptance: The new URL works anonymously on another machine; two unrelated born-digital PDFs complete the primary flow without paper-specific code; a weak/unsupported PDF fails honestly; all required native activity is visible; and the public repository builds from a clean checkout. Every technical readiness control is green; only final video, handoff, and human submission-confirmation controls may remain red until item 12.
  Verify: Run `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, the technical portion of `npm run devpost:check`, clean-browser cross-PDF and accessibility matrices, and the named-client callback protocol against the deployed release. Record the URL, immutable commit, client tuple, dates, screenshots, and sanitized receipts.

- [ ] **12. Prepare the Devpost handoff**
  Spec ref: `prd.md > Submission Proof Points`; `spec.md > Demo And Submission Flow`; `spec.md > Build Handoff`
  What to build: Gather the final problem/impact story, WebMCP architecture and AI disclosure, public URL, repository and MIT license, exact setup/judge instructions, under-three-minute narrated demo, screenshots, release-gate matrix, new-work disclosure, and evidence index. Lead with the map-to-source-to-agent-to-Undo moment and explain why the PDF remains central.
  Acceptance: Every submission statement is traceable to passing release evidence; the materials distinguish automatic structure from semantic interpretation, observed callbacks from hidden reasoning, paper evidence from mentor background, agent mutation from human Undo/Redo authority, and the public slice from later authenticated/networking work.
  Verify: Run the final all-green `npm run devpost:check`; review the handoff against `docs/DEVPOST-COMPLIANCE.md`, `docs/DEVPOST-JUDGE-GUIDE.md`, the release proof, and the canonical PRD acceptance matrix; confirm live URL, repository, license, video, and final submission fields are accessible before running `$prepare-submission`.

## Dependency And Pause Map

1. Item 1 retires named-client and schema risk before the interface is built. **Pause 1 follows item 1.**
2. Items 2–4 establish a reproducible spatial Reader. **Pause 2 follows item 4.**
3. Items 5–9 build the map, agent capabilities, reversibility, and evidence loop on those anchors.
4. Item 10 hardens recovery and accessibility. **Pause 3 follows item 10.**
5. Item 11 creates the only release proof that may replace the historical two-tool baseline.
6. Item 12 packages verified facts for Devpost.

## Explicit Later Port

After the public release is green, port the same document, anchor, graph, command, and provenance contracts into the authenticated Vercel/Supabase service. Zotero, crawler acquisition, durable multi-user workspaces, semantic enrichment workers, vector retrieval, collaboration, cross-paper graph UI, OCR, and PDF export remain later work and cannot delay the judged graph-and-annotation slice.

## Coverage Audit

- All twelve redesigned PRD epics map to at least one build item and verification path.
- Centered PDF, no transcript, spatial annotations, whole-paper structural coverage, Graphology/Sigma, six WebMCP capabilities, graph-aware explanation, reversible graph/annotation mutation, Undo/Redo, evidence, accessibility, no export, and cross-paper rejection are explicit release gates.
- Structural coverage and semantic understanding remain separate claims.
- The existing two-tool deployment is retained as historical proof and never used to satisfy the redesigned gates.
