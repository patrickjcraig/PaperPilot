# Product Requirements Document

**Status:** Approved redesign PRD for The WebMCP Challenge, 2026-08-30

**Product contract:** [`scope.md`](./scope.md)
**Primary release path:** anonymous public `/webmcp/` vertical slice first; authenticated service port second

This PRD defines what PaperPilot must do and how the redesigned experience must feel. It supersedes the earlier transcript-led Reader and two-tool-only WebMCP requirements wherever they conflict. It intentionally separates user-visible behavior from technical architecture.

## Product Summary

PaperPilot is an accessibility-first scientific reading workspace for people encountering a difficult paper without expert fluency in its field. The real PDF stays in the middle of the experience. A reader highlights text where it appears on the page or marks a figure, equation, or region; a WebMCP browser agent explains the material as a supportive research mentor and helps build a knowledge graph of the paper.

Every uploaded paper receives an immediate whole-paper structural map. The map begins with honest document structure and becomes more semantic as the agent and reader add main ideas, concepts, prerequisites, methods, findings, and relationships. Every claim presented as paper-grounded must return to a spatial source anchor. Mentor background remains visibly separate.

The browser agent may make real graph and annotation changes through WebMCP. Those edits apply immediately to keep the interaction fluid, but every change is visible, attributed, revisioned, and reversible with human-only Undo and Redo controls. The original PDF is never rewritten, and annotated-PDF export is not part of this release.

### Product promise

> Understand the hard part in place. See how it connects. Follow every idea back to the paper. Undo anything the agent gets wrong.

### Product principles

1. **The paper is home.** The PDF—not a transcript or generic chat—is the primary reading surface.
2. **Spatial context is evidence.** Text, equations, figures, and regions remain tied to their page geometry.
3. **Map the whole paper honestly.** Every page receives structural coverage; semantic completeness is never implied before it is earned.
4. **Teach, do not merely summarize.** The mentor explains jargon, prerequisites, mathematics, mechanisms, and connections at an undergraduate level.
5. **Let the agent act.** WebMCP can navigate, explain, annotate, and evolve the map rather than only returning one payload.
6. **Make action reversible.** Agent graph changes apply without a blocking Save modal, but a reader can Undo or Redo them and inspect the full revision.
7. **Ground claims, not just answers.** Paper-grounded nodes, edges, and explanation blocks require source anchors.
8. **Label background knowledge.** Useful mentor prerequisites are welcome but cannot masquerade as statements made by the paper.
9. **Trace without overclaiming.** Callbacks and digests prove observed operations and identity, not scientific truth or hidden model reasoning.
10. **Accessibility is a primary route.** The PDF, annotations, graph, revisions, and mentor interaction all have keyboard and screen-reader paths.
11. **Prototype truth matters.** Browser-local state in the public slice is labeled browser-local; durable service behavior is claimed only after the Supabase-backed port exists.

## Target User

### Primary persona: the first hard-paper reader

The primary user is a general reader at roughly undergraduate level reading an early difficult scientific paper. They have basic prior knowledge and genuine interest, but the authors assume vocabulary, mathematics, methods, or visual conventions they have not yet acquired.

They may be:

- an undergraduate reading a paper for a course or first research project;
- a technically capable person crossing into an unfamiliar field;
- a member of the public trying to understand scientific evidence;
- a researcher entering an adjacent discipline; or
- a reader who benefits from screen-reader access, keyboard operation, or reduced cognitive clutter.

### Primary jobs to be done

- “Explain this exact thing without making me leave the page.”
- “Define the jargon and prerequisites the authors assume I know.”
- “Walk me through this equation without erasing the real detail.”
- “Describe this figure and explain why it matters.”
- “Show me where this idea fits into the rest of the paper.”
- “Build me a map I can use to navigate the paper.”
- “Let the agent organize the map, but let me undo a bad change.”
- “Show me which ideas come from the paper and which come from background knowledge.”

### What PaperPilot must not assume

- The user knows how to write a model-quality prompt.
- The user knows what WebMCP, provenance, a graph revision, a digest, or OCR means.
- The PDF has a clean text layer, useful outline, simple reading order, or accessible figures.
- A detected heading is a scientifically meaningful main idea.
- The user can use a mouse, see a crop, distinguish colors, or use the Sigma canvas.
- A browser agent is always available or calls every registered tool correctly.
- A paper-grounded-looking graph edge is scientifically correct merely because an agent created it.
- Browser-local prototype data is synchronized across browsers or devices.

## Canonical User Journey

### First use

1. The user opens a calm landing state with one dominant **Upload a paper** action and the promise: “Read the paper. Ask your mentor. Map the ideas. Follow the evidence.”
2. The user chooses a PDF through a file picker or drag-and-drop. Supported limits and browser-local custody are stated before selection.
3. PaperPilot validates the file enough for the public slice to load it, computes its digest, and opens the actual PDF in the middle of the workspace.
4. The continuous paper scroll, direct page locator, and zoom become usable as soon as the first page renders. Indexing continues without blocking reading.
5. PaperPilot automatically creates a structural whole-paper map: paper root, outline/section nodes when reliable, and page-range or visual-only fallback nodes for all remaining pages. A visible coverage indicator distinguishes structural coverage from semantic enrichment.
6. The user highlights a difficult phrase directly on the PDF text layer. The highlight becomes a spatial annotation with a concise accessible label.
7. The user asks the browser mentor: “Explain this at an undergraduate level and add the idea to the map.”
8. The agent reads the active focus and bounded graph, stages an explanation, and applies one source-grounded graph revision through WebMCP.
9. The mentor explanation appears in the left rail. The new or changed graph entities pulse in the right rail, and a notice says **Agent changed the map · Undo · Review changes**.
10. The user selects the new graph node. PaperPilot moves the centered PDF to the exact source annotation and announces the page and selection.
11. The user asks the agent to rename, connect, or remove a node. The agent applies another reversible graph revision.
12. The user presses **Undo** and **Redo** to demonstrate the soft check. The evidence trail retains the original mutation and both compensating actions.
13. The user selects a figure or region and requests a description/explanation. The same anchor, graph, and evidence model applies.
14. The user optionally keeps an explanation card in browser-local notes or discards it. Graph changes remain governed by the separate reversible revision history.

### Returning use in the public slice

1. Reuploading a byte-identical PDF may restore its versioned browser-local map, annotations, explanations, and evidence trail.
2. A same-name PDF with a different digest creates a new workspace and never inherits the old graph.
3. Restored content is labeled **Saved in this browser** and never described as account-synchronized.
4. Corrupt or incompatible local state is ignored safely with an explanation; the PDF still opens normally.

### Authenticated service use later

The authenticated port preserves the same visible flow while replacing browser-local authority with actor-private Supabase records, durable revision conflicts, and exact admitted-text/visual custody. That port is not a blocker for the public hackathon proof and must not be claimed before implementation.

## Experience Vocabulary

| Technical concept | Reader-facing label | Evidence-detail label |
| --- | --- | --- |
| WebMCP-capable browser agent | Research mentor | Browser agent / WebMCP client |
| PDF text/region anchor | Highlight / selected source | Spatial source anchor |
| Automatic structural graph | Paper map | System-derived structural map |
| Semantic graph | Knowledge graph | Versioned paper concept graph |
| Graph mutation | Agent changed the map | WebMCP graph revision |
| Logical deletion | Removed from map | Reversible tombstone |
| Compensating revision | Undo / Redo | Inverse/reapplied graph revision |
| Exact document text | From the paper | Exact text reconciled to source anchor |
| Rendered visual source | From the page image | Client-rendered PDF region |
| Agent prerequisite knowledge | Mentor background | Not directly stated by the paper |
| Staged mentor output | Explanation ready | Pending explanation proposal |
| Browser-local persistence | Saved in this browser | Local versioned snapshot keyed by PDF digest |
| Technical provenance | Evidence details | Anchors, callbacks, revisions, digests, timestamps |

## Epics And User Stories

### Epic 1: Start with the real paper

#### US-1.1 — Upload an arbitrary admitted PDF

- As a reader, I want to upload my own scientific PDF so that PaperPilot works on the material I actually need to understand.

Acceptance criteria:

- The empty state has one dominant **Upload a paper** action with an accessible name.
- File-picker and drag-and-drop paths are both available.
- The public slice states its file/page limits and browser-local custody before selection.
- The application does not branch on filename, title, DOI, digest, authors, or known contents.
- A selected PDF displays its filename and meaningful loading/indexing states.
- Non-PDF, encrypted, corrupted, oversized, or non-renderable input produces a specific safe failure and no sample replacement.

#### US-1.2 — Read while the rest of the paper indexes

- As a reader, I want the first page quickly so that whole-paper analysis does not make me wait before reading.

Acceptance criteria:

- The first renderable page opens before whole-document indexing is complete.
- Page navigation, zoom, and fit-width controls remain available during indexing.
- The status distinguishes **Paper ready**, **Indexing paper**, **Building structural map**, **Map ready**, **Map partial**, and **Map failed**.
- Index progress is announced at meaningful milestones, not on every page/token update.
- Cancelling or failing map work does not discard the readable PDF.

### Epic 2: Keep the PDF in the middle

#### US-2.1 — Use a paper-dominant workspace

- As a reader, I want the actual paper to remain visually central so that explanations and graphs never replace what I am reading.

Acceptance criteria:

- At wide widths, the visual order is mentor left, paper center, Graph/Evidence right.
- The paper occupies approximately 55–60% of the usable width when both rails are open.
- The PDF is one continuous vertical document across more than page 1, with ordinary cross-page scrolling, active-page indication, a direct page locator, zoom, and fit-width.
- Using the page locator, a graph source, or an annotation scrolls the existing document to the destination rather than replacing the visible page.
- Opening an explanation, graph detail, or evidence detail does not navigate away from the paper.
- At narrow widths or high zoom, the paper remains the primary view and the two rails become accessible tabs/drawers.
- The app avoids whole-page horizontal scrolling; a bounded PDF viewport may pan when zoom requires it.

#### US-2.2 — Remove the duplicate transcript

- As a reader, I want to select content where it appears in the paper so that I do not have to correlate a detached transcript with the PDF.

Acceptance criteria:

- There is no persistent visible transcript textarea, transcript column, or duplicate text panel.
- A synchronized PDF text layer supports direct spatial selection when reliable.
- The selected words remain highlighted at their page location.
- An optional semantic page/annotation outline may support accessibility without becoming a second visible reading surface.
- Textless or unreliable-text pages remain usable through page/region selection and never display fabricated exact text.

### Epic 3: Mark the exact source

#### US-3.1 — Create a spatial text highlight

- As a reader, I want to highlight a word, equation-text, line, or passage on the PDF so that the mentor and graph share the exact location I mean.

Acceptance criteria:

- A nonempty bounded selection creates an annotation only after it resolves to one page or a supported multi-rectangle range.
- The annotation retains PDF digest, page, rotation, normalized bounds, PDF-style quad points, exact quote when reliable, bounded prefix/suffix, and source/quote digests.
- Multiline and multicolumn selections preserve separate rectangles rather than one misleading bounding box.
- Zoom, fit-width, resize, and rerender keep the highlight aligned.
- A text/geometry mismatch downgrades the anchor to rendered-region authority and states the limitation.
- The agent never supplies the source geometry.

#### US-3.2 — Select a page, equation, figure, or arbitrary region

- As a reader, I want to mark visual content so that charts, diagrams, images, and spatial mathematics can enter the same mentor and graph flow.

Acceptance criteria:

- **Select region** has clear entry, instructions, confirm, and cancel actions.
- A pointer user can draw and adjust a rectangle inside the rendered page.
- **Use whole page** is always available for a renderable page.
- **Use whole figure** is available when the user has manually bounded or selected a figure; automatic figure detection is not required.
- The anchor retains page/rotation, normalized geometry, renderer recipe, and digest-bearing visual identity.
- No caption is invented. Missing caption context says **No caption identified**.
- Removing an overlay never mutates the original PDF bytes.

#### US-3.3 — Use annotations without sight or a pointer

- As a keyboard or screen-reader user, I want a reliable source-selection alternative so that spatial interaction is not pointer-only.

Acceptance criteria:

- Keyboard users can choose the focused text item/paragraph, current page, or a labeled identified item.
- Region geometry has optional labeled numeric controls with bounds, units, validation, and a concise summary.
- **Describe this page** exists for every renderable page.
- Every annotation appears in a keyboard-focusable list with type, page, short quote/description, authority, state, and linked graph count.
- Selecting an annotation from the list moves the visual viewer and graph focus without trapping focus.

### Epic 4: See an automatic whole-paper map

#### US-4.1 — Receive immediate structural coverage

- As a reader, I want a map as soon as I upload the paper so that I can orient myself before I know what to ask.

Acceptance criteria:

- Upload automatically creates one paper root.
- Paper outline entries become section nodes when available and safely bounded.
- Heading heuristics may create provisional section nodes when confidence is sufficient and label them as system-derived.
- Every admitted page belongs to a section/page-range node; weak-text pages receive explicit visual-only page coverage.
- A coverage indicator reports pages indexed, structurally mapped, limited, and failed.
- **Whole-paper structural map ready** never means every scientific claim has been understood.

#### US-4.2 — Enrich the structure into a semantic map

- As a reader, I want the mentor to add main ideas and relationships so that the map becomes a learning tool rather than only a table of contents.

Acceptance criteria:

- The map supports `paper`, `section`, `main idea`, `concept`, `term`, `method`, `result`, `prerequisite`, `figure`, and `equation` nodes.
- It supports the approved directed relationship vocabulary.
- Paper-grounded semantic nodes and edges require at least one valid source anchor.
- Mentor-background nodes may omit paper anchors only when persistently labeled **Mentor background**.
- The agent can progressively enrich one section or the full structural map through bounded reads.
- Map progress identifies structurally covered versus semantically enriched sections.
- A partial or failed semantic pass remains labeled partial/failed and never fabricates coverage.

### Epic 5: Understand and navigate the graph

#### US-5.1 — Explore main ideas without graph expertise

- As a first-time reader, I want a calm graph view so that relationships help me rather than overwhelm me.

Acceptance criteria:

- The default graph emphasizes roughly 5–15 high-salience visible items for a normal paper, with supporting detail progressively disclosed.
- Node type, authority, and agent/system/reader origin are visible without relying on color alone.
- Selecting a node shows its label, short summary, type, authority, linked sources, and relevant relations.
- Search across node labels and summaries plus type/authority filters are available without requiring graph syntax; the same bounded search semantics are exposed to the WebMCP graph-read API.
- Layout motion is restrained and respects reduced motion.
- Layout coordinates never appear as evidence of meaning.

#### US-5.2 — Move from graph to paper and back

- As a reader, I want concepts and relationships to return me to the paper so that the map never becomes an ungrounded diagram.

Acceptance criteria:

- Selecting a grounded node focuses its primary annotation and offers all other source anchors.
- Selecting an edge lists and focuses the anchors that justify that relationship.
- Selecting an annotation focuses every linked node/edge.
- The page/region is visibly marked and announced after navigation.
- A missing source shows **Source incomplete** and keeps the graph item visible for audit.
- The same navigation actions exist in the accessible graph outline; the Sigma canvas is not required.

#### US-5.3 — Arrange annotations and concepts without changing evidence

- As a reader, I want to organize annotation cards and concept positions so that the map matches how I am thinking without rewriting what the paper says.

Acceptance criteria:

- An annotation card can be reordered by pointer and by **Move earlier** / **Move later** controls, with keyboard focus restored to the moved card.
- Dropping an active annotation card onto the graph moves one deterministic current linked node; annotations with no valid linked node remain reorderable and external drag payloads are ignored.
- Active Sigma nodes can be dragged directly. The accessible outline can select the same node, and four keyboard controls move it by a consistent visible increment.
- The PDF overlay and its anchor digest, page, rotation, normalized bounds, PDF quads, quote, and graph links do not move when a card or node is arranged.
- Card order, selected state, and graph coordinates stay outside canonical annotations, semantic graph projections, revisions, evidence events, workspace/graph/annotation digests, and `paperpilot.read_graph` results.
- A semantic WebMCP graph or annotation command still succeeds after any arrangement, and surviving presentation positions reconcile across renderer/Graphology replacement and Human Undo.

### Epic 6: Give the browser mentor useful WebMCP tools

#### US-6.1 — Know what tools are actually ready

- As a reader, I want an honest readiness state so that registration is not confused with agent action.

Acceptance criteria:

- Successful registration lists the exact available PaperPilot tool count and names under details.
- **Tools ready for your research mentor** means registration completed only.
- A read, graph inspection, navigation, explanation stage, graph mutation, or annotation mutation appears only after PaperPilot observes that callback.
- Partial registration aborts/disposes the complete suite and shows **Tool registration failed**.
- WebMCP-unavailable mode preserves the local PDF, map, annotations, Undo/Redo, and saved browser state without native styling.

#### US-6.2 — Let the agent inspect bounded context

- As a reader, I want the mentor to read my active source and map without exposing unrelated content.

Acceptance criteria:

- `read_focus` returns only the active trusted anchor, bounded context, its authority, and related issued IDs.
- `read_graph` returns a bounded overview, focus/issued-node neighborhood, or plain-text search result with current revision/digest, filters, and a truncation indicator.
- Tool results do not include PDF bytes, another paper, a whole library, browser storage inventory, another tab's mutable state, credentials, or hidden prompts.
- The agent can traverse structural sections through issued references and bounded repeated reads; one call never silently truncates a larger source and pretends completeness.
- Paper text and graph labels are marked untrusted content and cannot override the tool contract.

#### US-6.3 — Let the agent navigate, explain, and edit

- As a reader, I want the mentor to act inside PaperPilot so that the experience feels agentic rather than like a static integration.

Acceptance criteria:

- `focus_source` can move only to an issued anchor, node source, or structural section in the active paper.
- `stage_explain` can create only a schema-valid explanation bound to the active source/graph revision.
- `apply_graph` can atomically add, update, relate, detach, restore, or tombstone bounded graph entities.
- `apply_annotation` can label/link only a trusted existing anchor; it accepts no raw PDF coordinates.
- Tool schemas contain no PDF export, original-PDF mutation, hard purge, verification, or cross-paper operation.
- Every callback returns a bounded structured result and a visible evidence event.

### Epic 7: Let the agent evolve the map safely

#### US-7.1 — Apply graph changes without a blocking approval modal

- As a reader, I want the mentor's graph improvements to appear immediately so that the interaction remains fast.

Acceptance criteria:

- A valid agent mutation applies as one atomic graph revision.
- A visible notice names the change and exposes **Undo** and **Review changes**.
- Affected nodes and edges are highlighted without stealing focus.
- Doing nothing leaves the revision applied.
- The revision remains `unreviewed` informationally until the reader acknowledges or edits it; that status does not block use.
- A validation, reducer, mandatory revision/inverse append, or projection-integration failure leaves the pre-command workspace intact and reports the rollback.
- A later optional browser-snapshot quota/write failure does not invalidate an otherwise committed live revision. It shows **Not saved in this browser**, emits no false persistence event, and explains that byte-identical reupload cannot restore the unsaved change.

#### US-7.2 — Add, edit, connect, and remove concepts

- As a reader, I want the mentor to perform the map-maintenance work I ask for so that I can focus on understanding.

Acceptance criteria:

- The agent can add a grounded main idea and connect it to existing nodes in one command.
- It can update bounded editable fields while preserving immutable identity and provenance.
- It can create more than one typed edge between the same endpoint pair using explicit edge keys.
- Removing a node tombstones that node and its incident edges as one reversible revision.
- Removing an edge tombstones only that edge.
- A paper-grounded node/edge without compatible active-paper anchors is rejected.
- A mentor-background node is accepted only with its background authority visibly retained.

#### US-7.3 — Resolve concurrent or stale edits honestly

- As a reader, I want newer work protected so that an old agent view cannot silently overwrite it.

Acceptance criteria:

- Every mutation requires the graph revision/digest the agent read.
- A stale revision applies no partial change and returns a conflict with the current revision.
- Duplicate retries with the same caller-visible idempotency key and canonical command digest return the original result without duplicating entities.
- Reusing an idempotency key with different command content fails; a new intent after a conflict uses a new key after the graph is reread.
- In the authenticated port, entity revisions protect later reader edits from automatic remapping.

### Epic 8: Use Undo and Redo as the soft check

#### US-8.1 — Undo any agent graph or annotation change

- As a reader, I want one-click Undo so that agent mistakes are easy to reverse without interrupting the flow beforehand.

Acceptance criteria:

- Undo is a human UI control and is not registered through WebMCP.
- Undo of create removes exactly the created projection items.
- Undo of update restores every prior editable value.
- Undo of delete restores the node and all incident edges with the same IDs, grounding, and provenance.
- Undo creates a new evidence revision; it does not erase the historical mutation.
- The graph digest after Undo matches the semantic state before the original operation.

#### US-8.2 — Redo when history has not diverged

- As a reader, I want Redo so that I can compare a change without losing it.

Acceptance criteria:

- Redo reapplies the original forward operation as a new attributed revision.
- The graph digest after Redo matches the semantic post-state of the original operation.
- A new divergent edit after Undo clears or invalidates the redo branch with a clear message.
- Redo never partially reapplies an invalid operation.
- Undo/Redo availability is conveyed by disabled state, text, and accessible description—not color alone.

### Epic 9: Learn from a graph-aware research mentor

#### US-9.1 — Receive a predictable explanation

- As an undergraduate reader, I want a stable explanation structure so that I can find the level of detail I need.

Acceptance criteria:

- Every valid explanation contains, in order: **Quick take**, **Where this fits in the paper**, **What you need first**, **How it works**, **Evidence in the paper**, **Related ideas in the map**, and **Limits and uncertainty**.
- Quick take is open first; deeper sections use real headings and progressive disclosure.
- Central jargon is defined rather than used unexplained.
- The explanation does not move the PDF or focus automatically.
- **Go to explanation** moves focus only after user activation.

#### US-9.2 — Keep explanation authorities distinct

- As a reader, I want to know which parts come from the paper and which parts come from the mentor so that I can evaluate the answer.

Acceptance criteria:

- Paper-grounded blocks cite issued spatial anchors.
- Rendered-page observations remain distinct from exact document text.
- Mentor interpretation and mentor background remain visibly labeled.
- External sources remain separately labeled and unverified unless a later system explicitly verifies them.
- Related graph items link to their node/edge details and source grounding.
- A graph node's existence is never presented as proof that the paper or scientific community endorses it.

#### US-9.3 — Explain mathematics and figures accessibly

- As a reader, I want technical and visual material explained without removing the details that make it meaningful.

Acceptance criteria:

- A math explanation identifies the selected equation/text/region and defines the symbols it uses in words.
- **How it works** describes reasoning step by step rather than only restating notation.
- A figure explanation includes an accessible visual description labeled **Mentor interpretation**.
- Visible features, inferred relationships, caption-grounded claims, broader interpretation, and limitations remain distinct.
- The matching source anchor can be reopened from every relevant explanation block.

### Epic 10: Follow the evidence and revision trail

#### US-10.1 — Understand the simple trail

- As a reader, I want an immediate summary of what happened so that provenance does not require technical expertise.

Acceptance criteria:

- The default trail can show: PDF loaded → paper indexed → structural map created → source anchored → WebMCP read → graph read/navigation → explanation staged → graph/annotation revision applied → Undo/Redo → human explanation decision.
- Events appear only after the corresponding operation was actually observed.
- Agent, system, and human actions are textually distinct.
- Undo does not remove the original mutation event.
- The trail never says **verified**, **true**, or **complete semantic map** without separate evidence.

#### US-10.2 — Inspect technical evidence

- As a reader or judge, I want details on demand so that I can audit a map change and its source.

Acceptance criteria:

- Evidence details expose PDF/document digest, page, anchor geometry, quote/region digest, annotation identity, graph base/result revision and digest, affected node/edge keys, forward/inverse summaries, tool/callback ID, operation ID, source coverage, actor, and timestamp authority.
- Layout positions are omitted from semantic graph digests.
- Client-observed, app-derived, agent-asserted, and human actions retain distinct authority labels.
- Details include the explicit statement that a digest proves identity/integrity, not scientific truth.
- No evidence view exposes raw PDF bytes, cookies, credentials, filesystem paths, hidden prompts, or private model reasoning.

### Epic 11: Restore safely and prepare for later cross-paper work

#### US-11.1 — Restore the same paper, never a lookalike

- As a returning reader, I want my browser-local map to reopen only for the exact PDF so that provenance cannot drift across files.

Acceptance criteria:

- Local snapshots are keyed by PDF SHA-256 plus schema version.
- Same filename/different digest creates a new workspace.
- Snapshot parsing is closed and bounded; incompatible/corrupt state fails safely.
- The UI labels local persistence and offers a clear-data action.
- The original PDF is not stored inside graph/evidence JSON and is never rewritten.

#### US-11.2 — Use future-ready identifiers without claiming cross-paper support

- As the product owner, I want document-scoped evidence and collision-free concept keys so that later cross-paper graphs do not require replacing this work.

Acceptance criteria:

- Every source anchor carries one immutable paper/document reference.
- Node and edge keys are globally collision-resistant strings and do not derive from labels or page numbers.
- Optional canonical concept keys do not merge nodes automatically.
- Current WebMCP and UI commands reject foreign-paper anchors/endpoints.
- The UI never presents cross-paper relationships in this release.
- Importing a second paper cannot mutate or hide the first paper's graph snapshot.

### Epic 12: Make the complete journey accessible

#### US-12.1 — Operate the primary flow by keyboard

- As a keyboard user, I want to complete the core workflow independently.

Acceptance criteria:

- Upload, page navigation, zoom, supported text/region alternatives, annotation-list reordering, mentor request, graph-outline node selection and nudging, node/edge inspection, source navigation, Undo/Redo, evidence details, and explanation Save/Discard are keyboard operable.
- Focus is visible and follows a stable logical order independent of the wide-screen visual placement.
- Graph canvas focus does not trap the user; every action exists in the DOM outline.
- Cancel/Escape restores focus to the control that opened selection or a modal.
- Explanation arrival and graph mutations are announced without unexpected focus movement.

#### US-12.2 — Understand the map and source with a screen reader

- As a screen-reader user, I want the same concepts, relationships, sources, and changes available without interpreting the canvas.

Acceptance criteria:

- Paper, Mentor, Knowledge graph, and Evidence are named regions.
- The graph outline exposes node type, label, authority, origin, relations, source count, and actions.
- An annotation list exposes source type, page, quote/description, state, and linked graph items.
- Source navigation announces page and region after movement.
- Meaningful map/indexing milestones, tool callbacks, mutations, rollbacks, Undo/Redo, and explanation readiness use restrained live announcements.
- At 200% zoom and a separate 320 CSS-pixel viewport, no required content or control disappears.
- Reduced-motion preference removes nonessential layout animation and highlight pulsing.

## Edge Cases

| Situation | Required behavior | Prohibited behavior |
| --- | --- | --- |
| PDF has no outline | Build paper + page-range structural nodes and label heading detection uncertainty | Pretend detected sections are author-supplied outline entries |
| PDF has unreliable or no text layer | Render pages, create page/region anchors, and show structural/visual-only coverage | Fabricate exact text or call the semantic map complete |
| PDF exceeds 25 MiB or 200 pages | Reject with the published public-slice limit; otherwise index progressively with bounded work, progress, and cancellation | Freeze the UI, silently truncate the paper, or return the whole document through one tool call |
| A page fails during indexing | Mark that page failed/limited while preserving other pages and honest coverage | Call whole-paper coverage complete |
| User selects across pages | Ask for one page or create separate supported anchors | Collapse cross-page geometry into a false single region |
| Highlight contains multiple lines/columns | Preserve separate quad/rectangle geometry | Use one bounding box containing unrelated text |
| Text does not reconcile with page geometry | Downgrade to rendered-region authority | Preserve exact-text styling because a string was extracted |
| Agent creates a paper-grounded node with no anchor | Reject with a grounding error | Store it as if supported by the paper |
| Agent adds prerequisite knowledge | Accept only as visibly labeled mentor background | Attach paper authority without evidence |
| Agent targets a stale graph revision | Reject atomically and return the current revision | Silently rebase or partially apply |
| Duplicate mutation callback | Replay the original result | Create duplicate nodes/edges/revisions |
| Agent tombstones a node with edges | Tombstone node and incident edges in one revision with a complete inverse | Leave dangling visible edges or destroy history |
| User undoes a delete | Restore identical node/edge IDs, grounding, and provenance | Recreate lookalike entities with new identities |
| User makes a new edit after Undo | Invalidate/clear Redo with an explanation | Reapply an incompatible stale future branch |
| Mandatory revision/inverse commit fails | Roll back to the exact prior semantic workspace and announce it | Leave live state without its required inverse/history |
| Optional browser snapshot write fails | Keep the valid live revision and show **Not saved in this browser** | Claim the change will restore after reupload or emit a false persistence event |
| Agent asks to Undo/Redo | Explain that those controls belong to the reader | Expose them as WebMCP tools |
| Agent supplies raw PDF coordinates | Reject the annotation command | Trust model-authored geometry |
| Graph node has multiple sources | Offer a primary source plus all anchors | Imply one arbitrary source is the only evidence |
| Source disappears or local state is corrupt | Keep the explanation/graph item with **Source incomplete** | Substitute a plausible anchor |
| WebMCP is absent | Keep local Reader/map/annotation/Undo usable and show unavailable state | Display native callback evidence |
| Tool registration partially fails | Dispose all tools and offer retry | Leave a misleading partial tool set active |
| Read occurs but explanation does not | Show the read event and **No explanation received** | Display explanation-ready or saved state |
| Explanation is malformed | Reject it without changing the graph | Render partial unvalidated content |
| Graph mutation is valid but explanation malformed | Keep the separately committed graph revision and report explanation failure | Pretend both operations were one transaction if they were not |
| User reuploads same filename/different bytes | Create a new digest-scoped workspace | Attach the prior graph |
| Agent attempts a cross-paper link | Reject before mutation and name current same-paper scope | Accept because IDs are future-ready |
| User looks for PDF export | No export control exists; explain overlays remain in PaperPilot if relevant | Offer a hidden or agent-callable annotated-PDF export |
| Sigma fails to render | Keep the accessible graph outline fully functional | Make the graph unavailable to every user |

## What We Are Building For The Public Release

1. **Paper-first anonymous Reader**
   - arbitrary bounded PDF upload;
   - dominant central multi-page PDF;
   - no persistent visible transcript;
   - continuous cross-page scroll, active-page locator, zoom, fit-width, loading and error states.
2. **Spatial markup**
   - text-layer selection and multiline quad anchors;
   - page, figure, equation, and region anchors;
   - PDF.js-aligned overlay and accessible annotation list.
3. **Automatic whole-paper structure**
   - full page index;
   - outline/heading/page-range structural seed;
   - coverage ledger and honest partial states.
4. **Knowledge graph**
   - Graphology semantic store;
   - Sigma visual renderer;
   - accessible outline;
   - grounded main ideas, concepts, methods, results, prerequisites, figures, and equations.
5. **Richer WebMCP surface**
   - focus read;
   - graph read;
   - source navigation;
   - graph patch;
   - annotation patch over trusted anchors;
   - graph-aware explanation stage.
6. **Reversible agency**
   - immediate atomic graph and annotation workspace revisions;
   - visible attribution and diff;
   - human-only Undo/Redo;
   - stale-revision and rollback behavior.
7. **Graph-aware mentor**
   - seven teaching sections;
   - text, math, figure, and connection explanations;
   - source/graph links and authority labels.
8. **Evidence and browser-local recovery**
   - graph/annotation/tool/reversal events;
   - PDF-digest-scoped local snapshots;
   - truthful browser-local labels.
9. **Accessibility and release proof**
   - keyboard and screen-reader routes;
   - reflow/reduced motion;
   - cross-PDF and supported-client evidence.

## What We Would Add Later

- Durable authenticated annotations, workspace revisions, explanation records, and actor-private history in Supabase.
- Cross-paper concept links and workspace-level graph filtering.
- User-reviewed entity resolution across papers.
- Zotero/crawler/Scholar-assisted acquisition and metadata reconciliation.
- Vector search only if structural/alias search proves insufficient.
- Multi-user graph collaboration and conflict visualization.
- OCR service and more reliable automatic figure/equation/caption detection.
- Adaptive learning plans, multilingual explanation, text-to-speech, and audio tutoring.
- An optional, explicitly requested annotated-PDF export—only after export re-enters scope and a fresh PDF-writer security/compatibility evaluation selects an implementation.

## Explicit Non-Goals For This Release

- No visible transcript pane.
- No PDF byte rewriting or annotated-PDF export.
- No cross-paper graph UI or synthesis.
- No vector database/RAG requirement.
- No crawler, new Zotero integration, or Scholar scraping in the critical path.
- No server-side explanation model.
- No claim of perfect automatic semantic mapping.
- No automatic scientific verification or hallucination guarantee.
- No permanent hard delete through WebMCP.
- No agent-callable Undo/Redo.
- No claim that Graphology, Sigma, callback receipts, or digests establish scientific truth.

## Submission Proof Points

### WebMCP leverage

- The agent reads the reader's exact spatial focus rather than a detached transcript.
- It reads the current graph/revision and can navigate the paper to issued sources.
- It makes a real source-grounded graph mutation through WebMCP.
- The reader immediately sees the effect and can Undo/Redo it.
- It stages a graph-aware mentor explanation linked to paper anchors and concepts.
- PaperPilot records only callbacks it actually observes and exposes no PDF export, hard purge, verification, or human Undo/Redo tool.

### User value

- The paper stays central while explanations and the map remain one interaction away.
- The automatic structural map makes an unfamiliar paper navigable immediately.
- Spatial annotations remove the location ambiguity created by transcript-based interaction.
- Grounded graph links teach relationships and prerequisites without hiding source boundaries.
- Reversible agency reduces the cost of a mistaken graph edit without forcing approval modals before every useful action.

### Accessibility

- A keyboard user can complete the full flow.
- A screen-reader user can inspect the graph and annotations without the visualization canvas.
- Figure/page explanation has a nonvisual path.
- Authority, origin, mutation state, and tombstone state do not depend on color.

### Honest claims

PaperPilot may claim that it:

- rendered the uploaded PDF and retained the identified source anchor;
- created a structural map covering the reported pages;
- observed named WebMCP callbacks;
- applied a particular graph revision and its inverse/reapplied revision;
- linked graph items and explanation blocks to issued sources; and
- preserved or restored a browser-local snapshot for the exact PDF digest.

PaperPilot must not claim that:

- every PDF has reliable text or a complete semantic map;
- an agent-created graph is scientifically correct;
- the agent privately reasoned from every returned source;
- a digest proves truth;
- the PDF was modified or exported;
- browser-local state is durable across devices; or
- cross-paper graphing exists because the identifiers are future-ready.

## Release Acceptance Matrix

| Proof path | Required observable outcome |
| --- | --- |
| Previously unseen born-digital paper A | Multi-page centered PDF, no transcript, spatial text anchor, structural map coverage, real WebMCP read/graph/explain/mutation, Undo/Redo, node-to-source navigation |
| Different born-digital paper B | Same workflow without code/config change and with independent digest-scoped state |
| Figure-rich paper | Whole-figure or region anchor, accessible description, grounded graph item, source reopen |
| Weak-text/scanned paper | Pages render, page/region anchors work, structural visual-only coverage is honest, semantic completeness is not claimed |
| Unsupported PDF | Specific failure and no substitute content |
| Whole-paper coverage | Every admitted page is mapped, limited, or failed; no eligible page is silently omitted |
| Agent create/update/delete | Each operation is real, bounded, source/authority valid, and produces one revision |
| Stale mutation | Atomic conflict, no partial graph change, current revision returned |
| Undo/Redo | Exact semantic digests restore before/after states while all historical events remain |
| Graph ↔ PDF | Node/edge navigation focuses real annotations; annotation selection focuses linked graph items |
| Explanation | Seven sections, graph/source links, distinct paper/background/interpretation authority |
| WebMCP unavailable | Local Reader/map remains usable and no native-success event appears |
| Graph renderer unavailable | Accessible graph outline retains inspection/navigation/actions |
| Local restore | Same digest restores; same filename/different digest does not |
| Cross-paper attempt | Rejected before mutation; no current cross-paper claim |
| No export | No annotated-PDF control, endpoint, command, or tool; original digest remains unchanged |
| Keyboard/screen reader | Primary journey, graph outline, annotations, navigation, mutation notice, Undo/Redo, and evidence are operable and announced |

## PRD Exit Criteria

This PRD is satisfied only when the public release demonstrates the complete paper → spatial anchor → bounded WebMCP reads → explanation/graph action → reversible revision → source navigation → evidence loop across unrelated PDFs, or explicitly reports a red gate.

Visual polish cannot substitute for missing source geometry, whole-paper coverage, real WebMCP navigation/mutation callbacks, grounding, Undo/Redo, accessibility, or honest failure behavior. Authenticated Supabase persistence remains the next port after the public vertical slice is proven; its absence must remain visible rather than simulated.
