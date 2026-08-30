# Product Requirements Document

Status: guided-build PRD for The WebMCP Challenge, 2026-08-29.

This document translates the approved [`scope.md`](scope.md) into user-visible behavior and testable outcomes. It defines what PaperPilot must do and how it should feel. Technical architecture, schemas, APIs, and implementation sequencing belong in the later Spec and Checklist.

## Product Summary

PaperPilot is an accessibility-first scientific reading workspace for people encountering difficult papers without expert fluency in the paper's field. A user uploads a previously unseen scientific PDF that meets PaperPilot's published admission limits, points directly at a word, equation, passage, figure, or figure region, and asks a WebMCP-capable browser agent for help. The agent acts as a supportive research mentor; PaperPilot keeps the explanation beside the source and makes its evidence trail inspectable.

The product does not promise that an agent cannot hallucinate. It makes the boundary around an explanation legible by distinguishing:

- exact embedded document text;
- a retained rendered page, figure, or crop;
- OCR- or vision-derived source context;
- mentor background knowledge not directly stated by the paper;
- additional external sources;
- observed PaperPilot WebMCP activity and client-asserted agent activity; and
- the authenticated reader's save or discard decision.

### Product promise

> Point at what you do not understand. Learn without leaving the paper. Follow the evidence behind the explanation.

### Product principles

1. **Point, do not retype.** The user starts from the difficult material itself rather than reconstructing it in a generic chat prompt.
2. **Teach in place.** The explanation appears beside the source without losing the reading position or active selection.
3. **Make depth optional.** Plain language is immediate; definitions, mathematical detail, paper context, sources, and technical provenance are progressively disclosed.
4. **Trace, do not overclaim.** Every authority is labeled. Digests and citations improve traceability but are never described as proof of truth.
5. **The agent proposes; the reader decides.** WebMCP tools may read bounded context and stage explanations. They may not save, accept, verify, or discard on the user's behalf.
6. **Arbitrary means paper-agnostic.** The product may impose honest file and resource limits, but no workflow may recognize or depend on a particular paper's identity or content.
7. **Accessibility is part of the primary flow.** Keyboard and screen-reader users receive an intentional explanation path, not a later compatibility layer.
8. **Calm beats crowded.** The default experience borrows Notion-like clarity and keeps diagnostic detail available without making it the first thing a new reader sees.

## Target User

### Primary persona: the first hard-paper reader

The primary user is a general reader at approximately undergraduate level reading an early difficult scientific paper. They have basic domain knowledge and genuine interest, but the paper assumes vocabulary, mathematics, methods, or visual literacy they have not yet acquired.

They may be:

- an undergraduate reading a paper for a course or first research project;
- a technically capable person crossing into an unfamiliar field;
- a member of the public trying to understand scientific evidence; or
- a reader who benefits from screen-reader access or reduced visual/cognitive complexity.

### Primary jobs to be done

- “Help me understand this exact thing without making me leave the paper.”
- “Define the jargon and prerequisite concepts the authors assume I know.”
- “Walk me through this equation or technical mechanism without erasing the real details.”
- “Describe this figure accessibly and explain what its selected region means.”
- “Connect several parts of this paper so I can synthesize the authors' argument.”
- “Show me which parts of the explanation come from the paper and which parts come from elsewhere.”
- “Let me keep the explanations that help, with my own takeaway, and return to them later.”

### What PaperPilot must not assume

- The user knows how to write a high-quality model prompt.
- The user knows what WebMCP, provenance, OCR, a digest, or a browser tool is.
- The PDF has a clean text layer, simple reading order, detectable figures, or accessible captions.
- The user can use a mouse, perceive a visual crop, distinguish colors, or tolerate unexpected focus movement.
- The browser agent or external network is always available.
- A cited external page is accessible, authoritative, or correct.

## Core User Journey

### First use

1. The user opens a calm library screen with one dominant **Upload a paper** action and the promise: “Highlight anything. Ask your research mentor. Follow the evidence.”
2. The user chooses a PDF through drag-and-drop or a file picker. Before selection, the screen states the supported file type, published size/page limits, and privacy posture.
3. The paper appears immediately with human-readable states such as **Checking file**, **Preparing pages**, **Finding selectable text**, and **Ready to read**.
4. When the first page is renderable, PaperPilot exposes a prominent **Open paper** action. It does not navigate or move focus unexpectedly.
5. Reader opens at the first available page. If selectable text is still processing or unavailable, visual-region interaction remains available and the limitation is explained.
6. The user highlights a term, line, equation-text, or passage, or enters **Select region** and chooses a whole figure or rectangular region.
7. PaperPilot keeps the selection visibly active and shows a compact sharing preview: document, page, selected text or image region, nearby context, and caption when available.
8. PaperPilot displays **Ready for your research mentor** and suggests a request such as: “Explain this at an undergraduate level and show what comes from the paper versus background knowledge.”
9. The user asks the browser agent in its normal conversation surface. PaperPilot moves through truthful states: **Selection ready**, **Mentor reading**, and **Explanation ready for review**.
10. The explanation opens beside the paper without changing the page or original selection. A screen reader receives an announcement and an explicit **Go to explanation** action; focus is not moved automatically.
11. The mentor card opens with **In plain language** and progressively reveals terms, steps, paper context, background knowledge, external sources, and limitations.
12. The user may request **Make it simpler**, **Go deeper**, or **Show the math**. Each follow-up becomes a separate response tied to the same selection rather than overwriting an earlier response.
13. The user opens the simple evidence trail—**From the paper → Added by the mentor → Saved by you**—and may expand **Show evidence details**.
14. The user optionally writes **My takeaway**, then chooses **Save to notes** or **Discard**.
15. A saved note remains attached to the paper and reopens with the exact source selection, mentor response, citations, trail, and user takeaway.

### Returning use

1. The library shows recent papers and **Continue reading** while keeping upload prominent.
2. Reopening a paper restores the last durable page position, saved notes, valid pending mentor responses, and evidence trails.
3. PaperPilot does not restore an unfinished drag selection or a browser-agent request that never produced a valid staged response.
4. Selecting a saved note reopens its source position and explanation without replacing the user's current reading state until they choose to navigate.

### Within-article synthesis

1. For ordinary explanation, the active selection may be interpreted with bounded, identified context from its section and the paper's stated purpose.
2. For deliberate synthesis, the user chooses **Add to Connect ideas** on multiple passages, equations, whole figures, or figure regions from the same paper.
3. A visible **Connect ideas** tray lists every selected item with its type, page, short preview, and remove action.
4. The user asks the mentor to compare, reconcile, or synthesize those items.
5. The resulting response identifies every source item it used and preserves a separate trail edge to each one.
6. Connect ideas never silently includes another paper, the user's whole library, or unlisted document content.

## Experience Vocabulary

The interface uses reader language by default and reveals technical language only in evidence details.

| Product concept | Default label | Detailed label when needed |
| --- | --- | --- |
| WebMCP-capable browser agent | Research mentor | Browser agent / WebMCP client |
| Staged agent output | Explanation ready for review | Pending mentor proposal |
| Accepted human decision | Save to notes | Accepted by authenticated reader |
| Rejected human decision | Discard | Rejected by authenticated reader |
| Exact PDF text | From the paper | Exact embedded document text |
| OCR or vision result | Derived from page image | OCR/vision-derived source context |
| Model prior knowledge | Mentor background | Not directly stated by the paper |
| Other websites or publications | External sources | Client-declared external citations |
| Tool lifecycle | Mentor activity | PaperPilot WebMCP registration and invocation activity |
| Cryptographic/content details | Evidence details | Digests, locators, coordinates, timestamps, and policy versions |

## Epics And User Stories

### Epic 1: Begin without friction

#### US-1.1 — Understand the empty state

- As a first-time reader, I want one obvious starting action so that I do not need to understand PaperPilot before using it.

Acceptance criteria:

- With no papers present, **Upload a paper** is the dominant action and receives a meaningful accessible name.
- The empty state contains the one-sentence promise and no fake papers, fabricated activity, or preloaded demonstration content.
- File type, size/page limits, and a short privacy explanation are available before the user opens the file picker.
- Drag-and-drop and file-picker paths are both present; neither is the only accessible path.
- Keyboard focus enters the page at a meaningful heading and reaches the upload action in a predictable order.

#### US-1.2 — Resume a recent paper

- As a returning reader, I want to continue a recent paper so that I can return to learning with minimal navigation.

Acceptance criteria:

- When at least one paper exists, recent papers show title, readiness, last durable reading position, and **Continue reading**.
- **Upload a paper** remains visible without requiring the user to open another screen.
- A paper that is still processing displays its current human-readable state rather than appearing ready.
- A paper with a recoverable problem exposes a clear next action; it does not look identical to a successful paper.

### Epic 2: Upload and enter Reader honestly

#### US-2.1 — See meaningful preparation states

- As a reader, I want to know what PaperPilot is doing with my PDF so that I can decide whether to read, wait, or fix a problem.

Acceptance criteria:

- A selected file appears immediately with its display name and one of the approved reader-facing states.
- The user can distinguish file validation, page preparation, selectable-text preparation, ready, and terminal failure.
- A page-ready paper exposes **Open paper** even if selectable-text preparation continues.
- State changes are announced without repeatedly interrupting a screen-reader user.
- The interface never displays a permanent indeterminate spinner without explanatory text.

#### US-2.2 — Continue when text is weak

- As a reader of a scanned or structurally difficult PDF, I want to use rendered-page selection so that a weak text layer does not end the reading session.

Acceptance criteria:

- If rendered pages are usable but selectable text is absent or unreliable, Reader displays **Selectable text is limited in this document**.
- Whole-page and visual-region explanation remain available.
- OCR- or vision-derived wording displays **Derived from page image** wherever it is quoted or used as context.
- Derived wording never receives exact-text styling or a claim that it was embedded in the document.
- A user can learn what the limitation changes without reading technical extraction diagnostics.

#### US-2.3 — Recover from an unsupported file

- As a reader, I want a specific explanation when PaperPilot cannot admit my PDF so that I know what to try next.

Acceptance criteria:

- Encrypted, damaged, oversized, over-page-limit, non-PDF, and non-renderable inputs produce distinguishable user-facing outcomes.
- Explanation and selection actions remain disabled for a page that cannot be rendered.
- PaperPilot never loads sample content or a different paper after an upload failure.
- Error text contains a safe next step, such as choosing an unlocked copy or a smaller document, when a recovery is possible.
- Internal storage paths, credentials, provider responses, or security diagnostics never appear in the user message.

### Epic 3: Point at difficult material

#### US-3.1 — Select exact text

- As a reader, I want to highlight a term, line, equation-text, or passage so that the mentor receives the exact material I am reading.

Acceptance criteria:

- A reliable text layer supports selections from one non-whitespace term through a published bounded passage length.
- After selection, the chosen text remains visibly marked and exposes **Explain** and **Add to Connect ideas**.
- Before mentor use, PaperPilot shows the selected text, page, and bounded context that will be shared.
- The preview makes it clear when mathematical layout may be better handled as a visual region.
- Reversing or adjusting a selection updates the preview before a mentor request begins.
- Once a mentor request begins, its source snapshot is frozen; later selection changes do not retarget it.

#### US-3.2 — Select a figure or visual region

- As a reader, I want to choose a whole figure or part of a page so that diagrams, charts, images, and visually significant mathematics are teachable surfaces.

Acceptance criteria:

- **Select region** creates a clear mode with instructions, visible focus, cancel, and completion actions.
- A pointer user can draw and adjust one rectangle within the rendered page bounds.
- **Use whole figure** is available when a whole figure has been identified or manually bounded; automatic figure detection is not required for success.
- The sharing preview shows the full retained visual context, selected subregion, page, and caption when available.
- The selected region stays outlined while the request is pending and can be reopened from the resulting explanation.
- Coordinates or technical image metadata are not required reading in the default view.

#### US-3.3 — Know what will be shared

- As a reader, I want to inspect the bounded selection before agent access so that I do not unknowingly expose unrelated paper or workspace content.

Acceptance criteria:

- The preview lists every source item that will be made available to the mentor.
- The preview distinguishes exact document text, rendered imagery, and derived wording.
- The preview does not include another paper, another user's data, unrelated notes, or the full library.
- The user can cancel without creating a mentor proposal or human decision.
- Starting a request preserves the exact preview as the request's source snapshot.

### Epic 4: Use the primary flow without relying on sight or pointer input

#### US-4.1 — Operate Reader and selection by keyboard

- As a keyboard user, I want to navigate pages and create supported selections without a pointer so that I can use the primary learning workflow independently.

Acceptance criteria:

- Upload, page navigation, zoom controls, text selection alternatives, visual-selection alternatives, sharing preview, mentor handoff, explanation review, evidence inspection, follow-up, save, and discard all have keyboard-operable paths.
- Focus is visibly apparent and follows a stable order that does not depend on the visual left/center/right layout.
- The active selection is communicated by both a visual outline and persistent text naming its type, page, and short preview.
- Region mode supplies keyboard-operable cancel and confirm controls and never traps focus in the PDF viewport.
- No required status, selection, authority, warning, or decision is communicated by color or motion alone.

#### US-4.2 — Ask about visual content nonvisually

- As a screen-reader user, I want a labeled way to request visual explanation so that arbitrary rectangle drawing is not my only path.

Acceptance criteria:

- Reader offers **Describe this page** for every renderable page.
- When a figure or caption is identified, Reader presents it as a named choice and allows the user to request an explanation of that item.
- If no labeled figure or caption can be identified, PaperPilot says so and still offers page-level description; it never invents a caption.
- PaperPilot does not claim that choosing a labeled item is equivalent to selecting an arbitrary visual subregion.
- The resulting figure or page description is labeled **Mentor interpretation** and any OCR/vision wording is labeled **Derived from page image**.

#### US-4.3 — Experience one coherent three-region workspace

- As an assistive-technology or zoomed user, I want the source, explanation, and evidence trail to remain one coherent journey regardless of layout.

Acceptance criteria:

- Source, explanation, and evidence have meaningful region names and one stable logical reading order.
- At narrow widths or browser zoom, the regions stack or switch views without losing content, controls, status, or the source-to-response relationship.
- The overall application avoids two-direction page scrolling; the PDF viewport may remain a clearly bounded pan/zoom surface.
- Reduced-motion preferences are respected and motion is never required to understand mentor activity.
- Streaming or repeated status updates are announced sparingly; users do not hear every incremental token or progress repaint.

### Epic 5: Ask a real WebMCP research mentor

#### US-5.1 — Know when PaperPilot tools are actually available

- As a reader, I want an honest readiness state so that I know whether my browser mentor can interact with PaperPilot.

Acceptance criteria:

- Successful registration displays **Tools ready for your browser mentor**.
- This state means PaperPilot made tools available; it does not claim that an agent discovered or invoked them.
- If the client exposes an independently observable discovery event, the interface may display it as a separate event. Otherwise, discovery is shown only in the browser-agent interface during the judge demonstration.
- Before a source-read callback occurs, PaperPilot displays **Waiting for your browser mentor—nothing has been shared yet** rather than **Mentor reading**.
- The normal reading and saved-note experience remains usable when tools are unavailable.

#### US-5.2 — See the real WebMCP activity sequence

- As a reader or judge, I want visible proof of the interaction PaperPilot actually observed so that a simulated or local path cannot masquerade as WebMCP.

Acceptance criteria:

- The default evidence trail includes **Tools ready**, **Selection read through WebMCP**, **Explanation received through WebMCP**, and **Awaiting your decision / Saved by you / Discarded by you** as applicable.
- **Selection read through WebMCP** appears only after PaperPilot observes the bounded source-read callback.
- The read event names the paper, page, selection type, and number of shared source items and states that no other papers or library content were shared.
- **Explanation received through WebMCP** appears only after PaperPilot accepts a valid structured staged response.
- Tool names, timestamps, locators, coordinates, digests, and payload details remain available under **Show evidence details**.
- PaperPilot never claims to observe the agent's hidden reasoning, model identity, or correct use of returned context unless the client supplies an explicitly labeled assertion.

#### US-5.3 — Keep requests bound to frozen sources

- As a reader, I want each request to remain attached to the source I submitted so that a later selection cannot corrupt the explanation trail.

Acceptance criteria:

- Starting a request freezes one source selection or one visible same-paper Connect ideas set.
- Changing the current selection or synthesis tray after submission does not change the in-flight request.
- PaperPilot continues to identify the frozen source while the request is pending.
- The user may cancel the request without losing the underlying source selection.
- A late result after cancellation or navigation stays separate, remains bound to its original source, and does not auto-open or auto-save.
- Duplicate valid responses are shown as the same proposal or clearly separate proposals; they never overwrite another response silently.

#### US-5.4 — Recover from mentor and WebMCP failures

- As a reader, I want actionable and truthful failure states so that I know what happened and can retry without losing my work.

Acceptance criteria:

- PaperPilot distinguishes **WebMCP unavailable**, **Tool registration failed**, **Mentor cancelled**, **Connection interrupted**, **Selection shared; no explanation received**, and **Mentor response could not be verified**.
- A tool-registration failure never displays **Tools ready**.
- A source read without a staged explanation stops at the last confirmed event and does not imply success.
- A malformed or invalid staged response does not appear as an explanation, creates no saved note, and leaves the source available for retry.
- Reading and existing notes remain usable throughout the failure.
- A local-review path displays **Local review—WebMCP was not invoked** in the status area, explanation, evidence trail, and any saved note created from that path.

### Epic 6: Learn from a structured research mentor

#### US-6.1 — Receive a predictable explanation

- As an undergraduate reader, I want every mentor response organized the same way so that I can find the level of help I need.

Acceptance criteria:

- Every valid staged response contains, in order: **In plain language**, **Key terms**, **How it works / step by step**, **Connection to the paper**, **Background knowledge**, **External sources**, and **Uncertainty or limitations**.
- **In plain language** is expanded when the response opens; later sections use real headings and progressive disclosure.
- An empty section says that nothing was supplied or used rather than disappearing in a way that implies evidence exists.
- Paper-grounded statements, page-image-derived interpretation, mentor background, and external material retain visible authority labels at the point of use even when evidence details are collapsed.
- The explanation avoids an unexplained expert term when that term is central to the selected content; such terms appear in **Key terms**.
- Uncertainty is not hidden because the user chose a simpler reading level.

#### US-6.2 — Understand difficult mathematics

- As a reader of mathematical or technical material, I want a step-by-step explanation that preserves the paper's meaning so that simplification does not become distortion.

Acceptance criteria:

- A math response identifies the selected equation or visual region before explaining it.
- **How it works / step by step** defines symbols used in the explanation and describes the reasoning in words, not only rendered notation.
- When layout matters, the response remains bound to the retained visual region rather than claiming exact text authority.
- **Connection to the paper** explains the role the mathematics plays in the selected paper context, or says when the available context is insufficient.
- The mentor may state prerequisites under **Background knowledge** but cannot label them as statements made by the paper without a separate paper source.

#### US-6.3 — Understand figures accessibly

- As a reader, I want both a description and an interpretation of selected visual material so that I can understand what is shown and why it matters.

Acceptance criteria:

- A figure response includes a screen-reader-friendly description labeled **Mentor interpretation**.
- The response distinguishes visible features, inferred relationships, caption-grounded claims, and broader interpretation.
- The whole retained figure context and any selected subregion can be reopened from the response.
- If no caption was found, the response and evidence trail say **No caption identified** rather than fabricating one.
- A figure spanning pages or containing ambiguous labels is described with an explicit limitation.

#### US-6.4 — Adjust explanation depth without losing history

- As a reader, I want to make an explanation simpler or deeper so that the mentor can meet me where I am.

Acceptance criteria:

- **Make it simpler**, **Go deeper**, and **Show the math** are available for a valid response.
- Each action creates a suggested follow-up for the browser mentor and remains bound to the same frozen source or source set.
- Each returned follow-up is a separate proposal with its own activity and evidence trail.
- An earlier response remains readable and is never silently rewritten.
- The user may save more than one response about the same source; each saved note remains distinguishable.

### Epic 7: Connect ideas within one paper

#### US-7.1 — Build a visible same-paper source set

- As a reader, I want to collect several relevant items from one paper so that I can ask how they relate.

Acceptance criteria:

- **Add to Connect ideas** is available for supported text, equation, whole-figure, and region selections.
- The tray identifies every item by type, page, authority, and short preview and provides a remove action.
- Keyboard and screen-reader users can add, inspect, and remove items.
- Duplicate items are prevented or visibly identified rather than silently counted twice.
- An item from another paper is rejected with an explanation; Connect ideas is never cross-paper in this release.
- The published item/size limit is shown before the user exceeds it, and PaperPilot never silently omits an item.

#### US-7.2 — Ask for genuine selected-evidence synthesis

- As a reader, I want the mentor to explain a meaningful relationship among selected items so that I can understand an argument, mechanism, or apparent tension within the paper.

Acceptance criteria:

- The sharing preview lists the complete frozen source set before the request starts.
- A synthesis response addresses every included source item and identifies the relationship it found.
- Independent mini-summaries with no relationship do not satisfy a successful synthesis response.
- If the supplied evidence does not support a defensible relationship, the mentor response says so rather than filling the gap with unlabeled background knowledge.
- The response may use mentor background and external sources, but those remain separate from claims about what the selected paper evidence supports.
- PaperPilot never labels selected-evidence synthesis as a complete whole-paper analysis.

#### US-7.3 — Preserve the synthesis source set

- As a reader, I want the complete source set retained with the response so that I can audit the synthesis later.

Acceptance criteria:

- Each source item has its own edge in the simple and detailed evidence trail.
- Editing the current Connect ideas tray after submission does not alter the submitted set.
- Reopening a saved synthesis identifies and reopens every still-available source item.
- If one retained source becomes unavailable, the note displays **Source incomplete** and identifies the missing item rather than presenting a complete trail.

### Epic 8: Follow the evidence without becoming a provenance expert

#### US-8.1 — Understand the simple trail

- As a reader, I want an immediate explanation of where the answer came from so that I can evaluate it without reading technical metadata.

Acceptance criteria:

- The default trail presents document/source, WebMCP mentor activity, and human decision in a stable order.
- Before decision, it ends with **Awaiting your decision**; after action, it displays **Saved by you** or **Discarded by you**.
- Exact document content, derived visual/OCR context, mentor background, and external sources remain distinguishable in the explanation itself, not only in detailed metadata.
- The trail does not describe the mentor response as verified or true.
- Labels, icons, text, and accessible names communicate authority without relying on color.

#### US-8.2 — Inspect evidence details

- As a reader or judge, I want technical detail on demand so that I can audit the selected source and actual WebMCP handoff.

Acceptance criteria:

- **Show evidence details** reveals the document identity, page, exact-text offsets or image crop coordinates, retained context, authority, citations, observable WebMCP events, timestamps, and digests.
- Client-asserted times or agent labels are visibly distinguished from PaperPilot receipt and human-decision records.
- A digest is described as an integrity/identity aid, not proof that a claim is correct or publicly available.
- Each response and follow-up has its own details; evidence is not pooled across responses.
- The details remain understandable and operable at narrow widths, browser zoom, and with a screen reader.

#### US-8.3 — Evaluate external sources honestly

- As a reader, I want external citations separated from paper evidence so that I can decide how much weight to give them.

Acceptance criteria:

- **External sources** says **No external sources used** when the mentor supplies none.
- Every supplied source shows a destination and its verification/access warning when applicable.
- Missing, malformed, inaccessible, or unverified citations remain visible beside the citation and in a saved note.
- A citation warning never prevents an informed save, but it cannot be removed by saving.
- Opening an external source preserves the PaperPilot reading state and does not include document text, selection content, or workspace context in the destination.
- PaperPilot does not certify that the source is authoritative or that it proves the mentor's statement.

### Epic 9: Keep only what helps

#### US-9.1 — Review before retaining

- As a reader, I want every response to remain a proposal until I decide so that the browser agent cannot author my notes autonomously.

Acceptance criteria:

- A valid mentor response first appears as **Explanation ready for review** and does not appear in saved notes.
- Only **Save to notes** creates a saved note and changes the human-decision trail to **Saved by you**.
- No WebMCP-visible action, browser-agent message, or follow-up can represent the user's save decision.
- **Discard** removes the proposal from active review, records and announces **Discarded by you**, and creates no saved note.
- A discarded-items archive and undo workflow are not required for this release.
- Citation warnings and uncertainty remain visible during review and after save.

#### US-9.2 — Add a personal takeaway without rewriting the mentor

- As a reader, I want to write my own interpretation separately so that my thinking is not confused with the agent's response.

Acceptance criteria:

- **My takeaway** is optional and visibly labeled as user-authored.
- The staged mentor response is read-only and remains byte-for-byte/meaningfully unchanged from what arrived for review.
- Saving succeeds without a takeaway.
- Editing a takeaway does not alter source evidence, mentor sections, citations, or activity history.
- A saved note presents mentor content and user takeaway as separate authored sections.

#### US-9.3 — Persist and reopen accepted work

- As a reader, I want saved explanations to survive refresh and return me to their source so that PaperPilot becomes a durable learning notebook.

Acceptance criteria:

- Refresh restores the last paper/page, saved notes, evidence trails, citation warnings, activity, human decision, and **My takeaway**.
- A valid staged but undecided response that reached PaperPilot returns as **Awaiting your decision** for the same authenticated actor.
- Another workspace member, including an owner, cannot see the actor's pending response through ordinary product views.
- Opening a saved text note returns to and outlines its source selection when available.
- Opening a saved visual note returns to the page and outlines the full figure or selected region when available.
- If the source document or one source item is no longer available, the note remains readable with **Source incomplete** and never pretends the full source can be reopened.
- An unfinished rectangle, local highlight not submitted, or browser request that never yielded a valid response is not restored as completed work.

### Epic 10: Recover without losing trust

#### US-10.1 — Preserve work across authentication and save failures

- As a reader, I want recoverable failures to preserve my staged work so that I do not lose a useful explanation at the final step.

Acceptance criteria:

- If authentication expires before save or discard, PaperPilot does not reveal private content on the sign-in page and explains that the decision requires sign-in.
- After the same user reauthenticates, a valid actor-private staged proposal remains available when policy permits.
- If save fails, the explanation and **My takeaway** remain in review, the UI says **Not saved**, and retry is available.
- **Saved by you** never appears before a successful durable save.
- Repeating a save after an uncertain outcome does not create two visible notes.

#### US-10.2 — Handle mixed-quality pages honestly

- As a reader, I want PaperPilot to describe the capability of the current page so that one good page does not create a false promise for the whole document.

Acceptance criteria:

- Each page exposes its strongest honest interaction state: exact selectable text, rendered-region only, or unavailable.
- Moving between pages updates the capability message without changing previously retained source authority.
- A page with scrambled or mismatched text downgrades to visual-region use rather than presenting that text as exact.
- A page that cannot render disables explanation for that page only when the rest of the paper remains usable.
- Product claims refer to admitted user-uploaded PDFs and page-level capabilities, not universal support for every PDF.

## Edge Cases

The following outcomes are product requirements, not optional diagnostics.

| Situation | Required behavior | Prohibited behavior |
| --- | --- | --- |
| Library is empty | Show the promise, one primary upload action, limits, and privacy context | Show a fixture as if it belongs to the user |
| User uploads a second unrelated paper | Show that paper's actual identity/pages and keep existing papers separate | Reuse a cached demo explanation or paper-specific configuration |
| PDF is encrypted | Explain that an unlocked copy is required | Request or retain the password in the normal upload flow |
| PDF is corrupt or cannot render | Identify the file/page problem and disable affected explanation actions | Substitute sample content or claim processing is still active forever |
| PDF is valid but exceeds a published limit | State the relevant limit and a safe next action | Fail with a generic server error |
| Some pages have exact text and others do not | Update capability per page | Apply one document-wide exact-text badge |
| Text visually disagrees with the rendered page | Downgrade that selection path to **Derived from page image** or visual-only | Preserve exact-text authority because extraction technically returned a string |
| Figure has no caption | Display **No caption identified** | Infer a caption and present it as document text |
| Figure label is ambiguous | Show the ambiguity and allow page-level/region selection | Silently choose one label |
| Figure spans pages | Identify the retained page(s) and limitation | Present one crop as the complete figure without warning |
| User starts mentor interaction with no valid selection | Explain how to highlight text, choose a visual region, or use nonvisual options | Send unrelated page or library context automatically |
| User changes selection during a request | Keep the request bound to its frozen source | Retarget the pending request |
| User cancels and a result arrives late | Keep it separate and attached to the original source; do not auto-open | Treat it as the current explanation or save it |
| Two valid follow-ups arrive out of order | Display each as its own proposal with its own source/activity trail | Reorder history in a way that implies one overwrote the other |
| Duplicate staging is observed | Show one stable proposal or explicitly distinguish intentional repeats | Create indistinguishable duplicate saved notes |
| WebMCP is absent | Retain selection, explain supported paths, and keep Reader usable | Display **Tools ready** or native success |
| Tool registration fails | Display a distinct registration error and retry path | Reclassify the failure as unsupported without saying registration failed |
| Tools are ready but no read occurs | Say nothing has been shared yet | Display **Mentor reading** |
| Source read occurs but no stage occurs | Display **Selection shared; no explanation received** | Display **Explanation ready** |
| Agent response is malformed | Reject it as an explanation, keep source for retry, and say nothing was saved | Render partial unvalidated fields as a trustworthy mentor card |
| No external source is used | State **No external sources used** | Hide the section or imply citations exist |
| External citation is broken or unverified | Preserve a visible warning during review and after save | Convert it to paper evidence or remove the warning on save |
| User saves despite a citation warning | Save the explanation and retain the warning | Block all saving or imply the warning was resolved |
| User discards a response | Announce discard, remove it from active review, create no note | Erase the fact of the human decision from the visible current trail before confirmation |
| Save fails | Keep response/takeaway intact with **Not saved** and retry | Show **Saved by you** or clear the review form |
| Authentication expires before decision | Require reauthentication without exposing the private proposal; resume for the same actor when possible | Lose the staged result silently or show it to another signed-in user |
| Pending response exists on refresh | Restore it as **Awaiting your decision** for its staging actor | Promote it into saved notes |
| Unfinished selection exists on refresh | Restore normal reading state, not a fake completed request | Present a local drag/highlight as staged evidence |
| Connect ideas contains a duplicate | Prevent or label the duplicate | Count it as separate evidence without disclosure |
| Connect ideas includes another paper | Reject the item and explain same-paper scope | Submit a cross-paper set |
| Connect ideas exceeds a published bound | Identify the bound before submission and let the user remove items | Silently truncate the set |
| Connect ideas changes during a request | Keep the submitted set frozen | Apply later additions/removals to the active request |
| Selected items do not support a relationship | Mentor says the supplied evidence does not establish one | Fabricate a relationship from background knowledge and call it paper synthesis |
| Source paper later becomes unavailable | Keep the saved explanation with **Source incomplete** and identify what cannot reopen | Pretend the source is still available or silently drop the note |
| Local review fallback is used | Repeat **Local review—WebMCP was not invoked** in status, response, trail, and saved note | Use native WebMCP styling or count it as submission proof |

## What We Are Building

The Tuesday feature-complete candidate includes all of the following product behaviors:

1. **Calm library and upload**
   - empty and returning states;
   - paper-agnostic admitted-PDF upload with published limits;
   - honest validation, rendering, text-readiness, and failure states.
2. **Page-based Reader**
   - durable page navigation;
   - page-level capability messaging;
   - exact text selection when reliable;
   - rendered whole-page, figure, equation, and region selection otherwise.
3. **Accessible selection**
   - pointer and keyboard paths;
   - page description and identified figure/caption choices for nonvisual readers;
   - sharing preview for every request.
4. **Real WebMCP mentor handoff**
   - truthful tools-ready state;
   - observable bounded source-read and structured stage events;
   - suggested prompts and normal browser-agent conversation;
   - explicit unavailable, failed, cancelled, interrupted, and invalid-response behavior.
5. **Structured research-mentor explanation**
   - seven canonical sections;
   - plain-language default;
   - jargon, mathematics, paper connection, background knowledge, external sources, uncertainty;
   - accessible figure/page descriptions;
   - separate simpler/deeper/math follow-ups.
6. **Selected-evidence synthesis**
   - visible same-paper Connect ideas set;
   - multiple passages/equations/figures/regions;
   - genuine relationship synthesis or an explicit statement that the supplied evidence does not support one;
   - one source edge per included item.
7. **Progressively disclosed evidence trail**
   - visible WebMCP activity in the default trail;
   - exact versus derived versus mentor versus external authority at the point of use;
   - technical metadata on demand;
   - no overclaim about truth, agent reasoning, discovery, or citation authority.
8. **Human review and durable notes**
   - immutable mentor proposal;
   - optional separate **My takeaway**;
   - explicit **Save to notes** and **Discard**;
   - actor-private pending proposals;
   - refresh and source reopen behavior.
9. **Primary-flow accessibility**
   - semantic regions and headings;
   - keyboard completion of primary tasks;
   - screen-reader announcements and focus discipline;
   - non-color authority and status distinctions;
   - zoom/reflow and reduced-motion behavior.
10. **Judge-facing proof**
    - replaceable real-PDF flow;
    - text, visual, synthesis, persistence, failure, and accessibility evidence;
    - honest native versus local-fallback distinction.

## What We Would Add With More Time

The following ideas are intentionally deferred and must not be smuggled into the Tuesday acceptance gate:

- multilingual explanation and translation;
- text-to-speech or a full audio tutor;
- adaptive reading levels based on a persistent learner profile;
- a prerequisite-concept graph or course-like learning path;
- automatic high-confidence figure, panel, caption, and equation detection across PDF producers;
- user-visible discarded-proposal history, undo, and bulk review;
- cross-paper or whole-library synthesis;
- collaborative annotation, discussion, shared mentor sessions, or instructor workflows;
- automatic external-source retrieval verification or authority scoring;
- broad note export, citation-manager export, and publication-ready writing tools;
- new Zotero, crawler, discovery, or project-management work;
- multiple mentor/model providers and routing controls;
- offline mentor interaction;
- full mobile visual-region editing parity;
- comprehensive accessibility conformance claims beyond the tested primary flow;
- support for encrypted, corrupt, malicious, unbounded, or non-renderable PDFs.

## Submission Proof Points

### WebMCP leverage

- The browser agent receives the user's bounded paper selection through an actual PaperPilot WebMCP read callback.
- The agent returns a structured explanation through an actual PaperPilot WebMCP staging callback.
- The page shows what PaperPilot made available and what callbacks it observed without claiming access to hidden agent reasoning.
- No agent-callable tool may save, accept, discard, or verify the explanation.
- The same general tool flow works for text, a figure/region, and a same-paper synthesis set.

### Execution

- A previously unseen admitted PDF completes upload, selection, real WebMCP activity, explanation review, save, refresh, and source reopen.
- A separate figure-rich paper completes whole-figure and subregion paths.
- A weak-text or scanned paper remains useful through visual-region interaction with derived authority visible.
- Unsupported-PDF and unavailable-WebMCP paths fail clearly without fixture substitution or false success.
- The primary demonstration flow is keyboard operable and has a documented screen-reader walkthrough.

### Potential impact

- The workflow removes the need to copy scientific content into a disconnected chatbot and manually reconstruct context.
- Undergraduate readers receive prerequisite teaching without losing the original source.
- Figure descriptions and nonvisual controls expand access to information that is often locked in visual-only scientific communication.
- Durable notes preserve the reader's own takeaway separately from the mentor's explanation.

### Creativity and ambition

- PaperPilot treats every word, equation, passage, figure, and selected region as an agent-native teaching surface.
- Selected-evidence synthesis lets a reader deliberately connect multiple parts of one paper without pretending the agent analyzed an invisible whole document.
- The visible evidence trail turns provenance into part of the learning experience rather than a back-office audit log.
- The central visual demonstrates the source, mentor, WebMCP activity, and human decision at once.

### Claims PaperPilot may make in the submission

- PaperPilot retained the displayed document selection or rendered visual source.
- PaperPilot observed its WebMCP source-read and explanation-stage callbacks.
- The displayed mentor response arrived through the declared path and remains unchanged in the saved note.
- The reader explicitly chose to save or discard it.
- Authority labels and evidence details help a reader inspect unsupported interpretation.

### Claims PaperPilot must not make

- Every PDF works, every page has accurate text, or every figure is detected.
- PaperPilot guarantees that the mentor does not hallucinate.
- A cited source is authoritative or proves the claim.
- A content digest proves truth, authorship, legality, or public availability.
- PaperPilot observed the browser agent's private reasoning or tool discovery when it did not.
- A local-review fallback is proof of WebMCP execution.
- The selected-evidence synthesis represents the entire paper unless the entire paper was actually supplied under a later explicit contract.

## Release Acceptance Matrix

The product is ready to enter technical release verification only when every row below has observable evidence.

| Proof path | Required observable outcome |
| --- | --- |
| Previously unseen born-digital paper | Exact text selection → real WebMCP read → valid staged explanation → review → save → refresh/reopen |
| Different figure-rich paper | Whole-figure and rectangular-region explanation, accessible description, full-context/subregion evidence |
| Weak-text or scanned paper | Rendered-region explanation remains available; all derived wording is labeled |
| Same-paper Connect ideas | At least two identified source items produce a relationship synthesis or an explicit insufficient-evidence result; complete frozen source set remains visible |
| Page-level capability mix | Exact-text and visual-only pages are labeled independently within one paper |
| Unsupported PDF | Explicit reason and next action; no fixture or replacement content |
| Native WebMCP unavailable | Honest unavailable state; selection and saved notes remain usable; no native-success styling |
| Registration failure | Distinct error and retry; no **Tools ready** state |
| Read without stage | **Selection shared; no explanation received**; no explanation or save |
| Invalid mentor response | Rejected as invalid; source preserved; nothing saved |
| In-flight selection change | Result remains attached to the original frozen selection |
| External-source warning | Warning visible in review and after save; citation never appears as paper evidence |
| Save failure and retry | Proposal/takeaway preserved; one eventual note; no premature success |
| Refresh with pending proposal | Same staging actor sees **Awaiting your decision**; no workspace-wide disclosure |
| Keyboard path | Upload, navigation, selection alternative, handoff, review, evidence, save/discard complete without pointer input |
| Screen-reader path | Processing, selection, mentor activity, explanation readiness, evidence categories, and decisions are announced and navigable in stable order |
| Local review fallback | Label persists in status, explanation, evidence, and saved note and does not count as native proof |

## PRD Exit Criteria

This PRD is satisfied when the implemented product demonstrates every Tuesday-scope behavior above or explicitly fails the build checkpoint. Visual polish cannot substitute for a missing source-selection, real-WebMCP, evidence, human-decision, persistence, paper-agnostic admitted-PDF, synthesis, or accessibility path.

The technical Spec must preserve these user-visible distinctions even if it chooses a narrower internal implementation. Any technical constraint that would remove a required product behavior must return to this PRD for an explicit scope decision rather than being silently reclassified as complete.
