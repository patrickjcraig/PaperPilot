# Project Scope

Status: approved guided-build scope for The WebMCP Challenge, 2026-08-29.

This is the canonical product scope for the current hackathon build. It supersedes earlier webpage-first demo priorities where they conflict, while preserving the security, provenance, actor-privacy, and human-authority work already completed in the repository.

## Project Name Candidates

- **PaperPilot** — confirmed by the participant; no rename is in scope.

## One-Line Summary

PaperPilot turns a previously unseen, user-uploaded scientific PDF that meets its published admission limits into an accessible, WebMCP-powered learning surface where a browser agent explains selected words, equations, passages, figures, and figure regions while every explanation carries a visible evidence trail.

## Target User

The first user is a general reader at approximately undergraduate level encountering an early difficult scientific paper. They have basic prior knowledge and enough motivation to read the paper, but they are not fluent in its specialized vocabulary, mathematical notation, research methods, or visual conventions.

The user should not need to know how to prompt an expert model, search for prerequisite material across many sites, or understand provenance terminology before receiving help. PaperPilot should feel hip, calm, contemporary, and easy to navigate rather than institutional or intimidating.

## Problem

Scientific papers are still largely static reading surfaces. A reader who gets stuck on one word, line, equation, passage, figure, or part of a figure must leave the document, search across unrelated resources, reconstruct missing prerequisite knowledge, judge which explanation is trustworthy, and then find their place again.

Existing paper-explanation products often produce an answer without a sufficiently inspectable boundary between:

- what the paper directly says;
- what was extracted or inferred from a rendered page;
- what the agent supplied from general background knowledge;
- what came from an additional external source; and
- what the reader chose to keep.

That ambiguity creates both a literacy barrier and a trust barrier. PaperPilot does not promise that an agent can never hallucinate. It makes hallucination and unsupported interpretation easier to detect by retaining the exact material supplied to the agent and labeling every other authority separately.

## Core Workflow

1. The user uploads a scientific PDF that PaperPilot has never seen before.
2. PaperPilot validates and renders the document without using paper-specific or hard-coded content.
3. In Reader, the user selects one learning surface or deliberately assembles a bounded same-paper source set:
   - a word or technical term;
   - a line, equation, or passage;
   - a whole figure and available caption; or
   - an optional rectangular region within a figure or page.
4. The user asks their WebMCP-capable browser agent to explain the active selection.
5. A PaperPilot WebMCP read tool returns a bounded representation of the selected source and its provenance—not the user's whole library.
6. The browser agent responds as a supportive research mentor. It may explain jargon, prerequisites, mathematics, mechanisms, within-paper relationships, or visual content and may consult authoritative external sources.
7. The agent calls a PaperPilot WebMCP write tool to stage one structured explanation. Staging cannot accept, verify, or silently file the result.
8. PaperPilot shows the source on the left, the mentor explanation in the center, and the evidence trail on the right.
9. The user chooses **Save to notes** or **Discard**. The friendly interface labels map to an explicit retained human accept/reject decision.
10. A saved explanation survives refresh and remains reopenable with its source selection, authority labels, agent proposal, citations, and human decision intact.

## What We Are Building

### Arbitrary-PDF support contract

The core experience must work from user-uploaded PDFs and may not recognize or depend on curated paper content.

- Accept syntactically valid, non-encrypted PDFs within published byte and page limits.
- Render every admitted page so visual-region interaction does not depend on a clean embedded text layer.
- When reliable embedded text exists, retain exact word, line, equation-text, and passage selections with page identity, surrounding context, offsets, and content digests.
- When embedded text is unavailable or unreliable, support rectangular page-region interaction. Any OCR- or vision-derived text is labeled **Derived from page image**, never presented as exact embedded text.
- Support image-only or scanned papers through visual-region explanation even when exact text selection is unavailable.
- Reject corrupted, encrypted, unsupported, or oversized files with an explicit reason and no substituted fixture content.
- Rehearsal may use a real paper selected in advance, but no application behavior may be conditional on that paper's identity or contents.

### Equal first-class text and figure interaction

Text and figures share one explanation and provenance model.

- Text selections range from one term to a bounded multi-line passage.
- Mathematics may be selected from the text layer when reliable or as a rendered visual region when layout is significant.
- Figure interaction supports both a manually selected whole figure and an optional rectangular subregion. Automatic figure detection is helpful but is not required for the first release.
- Preserve the full figure bounds, selected subregion, page number, crop coordinates, available caption, bounded page context, and digests of the retained visual artifacts.
- A figure explanation includes a screen-reader-friendly description as well as interpretation of the selected visual content.

### WebMCP as the essential interaction layer

The browser agent performs the explanation; PaperPilot provides tools, source custody, review, and persistence.

- Register actual tools through `document.modelContext.registerTool` on the signed-in Reader surface.
- Expose a read-only tool that describes the active selection and returns only the bounded source context needed for the explanation.
- Expose a mutation tool that stages one closed, structured mentor explanation and its declared external sources for private human review.
- Keep tool descriptions and schemas concise enough for reliable browser-agent use; trusted client code computes identifiers, timestamps, offsets, and digests rather than asking the model to perform those transformations.
- Do not expose an accept, approve, or verify tool. Only the authenticated user may save the explanation as a note.
- Detect unsupported or failed WebMCP registration explicitly. A local fallback may exercise the same review UI but must say that WebMCP was not invoked.

### Canonical research-mentor explanation

Every staged response uses one accessible, predictable structure with progressive disclosure:

1. **In plain language**
2. **Key terms**
3. **How it works / step by step**
4. **Connection to the paper**
5. **Background knowledge**
6. **External sources**
7. **Uncertainty or limitations**

The default voice is a patient, precise research mentor speaking to an undergraduate reader with basic prior knowledge. The answer may teach prerequisite concepts and communicate difficult mathematics, but it must not present mentor knowledge as if the paper stated it.

Within-paper synthesis is in scope in two forms: contextual explanation of one selection using bounded, identified context, and deliberate selected-evidence synthesis across multiple user-visible passages, equations, figures, or regions from the same document. The complete source set is shown and frozen before submission. The response must explain a meaningful relationship among the items or state that the supplied evidence does not support one. Unbounded whole-paper, whole-library, or cross-paper synthesis is not.

### Visible evidence trail

The product visibly separates five kinds of authority:

| Trail lane | What it may contain | What PaperPilot may claim |
| --- | --- | --- |
| Document evidence | exact embedded text, rendered page or crop, caption, document/page identity, offsets or coordinates, digests | PaperPilot retained this exact source artifact from the uploaded document |
| Derived source context | OCR, vision-derived text, inferred caption or region description | derived from the retained page image; not exact embedded text |
| Agent activity | WebMCP calls, agent proposal, declared transformations and citations | client-asserted activity plus server-observed PaperPilot tool receipt |
| Teaching knowledge | general explanation and prerequisite concepts | useful mentor background; not directly stated by the paper unless separately grounded |
| Human decision | save/discard actor, unchanged mentor proposal, optional separately labeled user takeaway, database time | an authenticated user explicitly kept or rejected this proposal |

External authoritative sources remain distinct from both the uploaded paper and uncited mentor background. PaperPilot retains their URLs, titles when available, access context, and association with the relevant explanation section. A citation improves traceability but is not itself proof that the source or claim is correct.

### Accessibility baseline

- Semantic headings, landmarks, controls, tables, and status messages.
- Complete keyboard operation for Reader navigation, text selection alternatives, figure-region controls, explanation review, and save/discard.
- Visible focus, sufficient contrast, reduced-motion respect, and no color-only provenance distinctions.
- Screen-reader announcements for upload/processing state, active selection, agent staging, errors, and save/discard outcomes.
- Accessible names and descriptions for figures, regions, provenance steps, and source links.
- Mentor-generated figure descriptions that remain labeled as agent interpretations.
- Calm progressive disclosure so the main explanation is readable without hiding the evidence trail from users who need it.

### Judge-ready experience

- Public HTTPS deployment usable in a supported WebMCP client.
- A real, previously unseen admitted PDF upload during the judge flow; no fixture-specific product logic.
- One rehearsed text or equation explanation and one rehearsed figure-region explanation using the same general implementation available to every upload.
- Refresh proof showing the saved note and evidence trail remain durable.
- Truthful unsupported-browser and unsupported-PDF states.
- Public repository, open-source license, setup instructions, short demo video, dated new-work disclosure, and post-deadline release freeze as required by the repository compliance gate.

### Definition of done for Scope

PaperPilot's hackathon proof of concept is done when:

- multiple unrelated, valid scientific PDFs can be uploaded without paper-specific configuration;
- a reliable-text PDF completes the exact text-selection flow;
- a figure-rich PDF completes both whole-figure and region-selection flows;
- a weak-text or scanned PDF can still use visual-region explanation with derived authority labeled correctly;
- real WebMCP tools carry bounded selection context to the browser agent and stage the structured response back into PaperPilot;
- a bounded, visible same-paper source set can produce selected-evidence synthesis without silently adding or omitting source items;
- the app never exposes an agent-callable approval path;
- document evidence, derived context, agent activity, mentor knowledge, external sources, and human decisions remain visually and durably distinguishable;
- the primary flow is keyboard operable and understandable with a screen reader;
- saved explanations survive refresh; and
- no fallback, OCR result, agent assertion, or citation is presented with stronger authority than the system actually has.

## What We Are Not Building

- Curated, deterministic, or paper-specific demo logic.
- Support for corrupt, encrypted, malicious, or unbounded PDFs.
- Perfect embedded-text recovery, OCR, equation parsing, caption detection, or reading-order reconstruction for every PDF producer.
- New Zotero, crawler, literature-discovery, networking, collaboration, or broad project-management features.
- Autonomous acceptance, verification, or project filing by an agent.
- Cross-paper or whole-library synthesis.
- A complete prerequisite-concept graph or adaptive course curriculum.
- Multilingual translation, text-to-speech, or full audio tutoring in this release.
- Multiple model-provider integration or model-routing infrastructure inside PaperPilot.
- Automatic proof that an external citation is authoritative or that an explanation is true.
- Full mobile feature parity beyond a usable responsive judge experience.

These features are deferred by name because each is valuable enough to distract from the one sharp promise: understand any admitted paper through direct text and figure interaction without losing the evidence trail.

## Inspiration And References

- **Explainpaper:** borrow the direct highlight-to-explain gesture; go beyond it with figures, structured teaching, and inspectable authority boundaries.
- **Perplexity:** borrow the proximity of sources to explanatory text; avoid treating a citation list as sufficient provenance.
- **Notion:** borrow calm document surfaces, strong typography, progressive disclosure, and an interface that feels approachable even when the content is difficult.
- **Research mentorship:** the agent should feel like a patient mentor sitting beside the reader, not a generic chatbot floating above the document.

## Demo Path

The target presentation is one continuous flow under three minutes:

1. Upload a real scientific PDF not recognized by the application.
2. Open Reader and select a difficult term, equation, or short passage.
3. Ask the browser agent to explain it. Show the PaperPilot selection-read and explanation-stage WebMCP tools being used.
4. Reveal the structured mentor card and briefly distinguish paper-grounded text, mentor background, and any external source.
5. Select a complete figure, narrow to one region, and request a screen-reader-friendly description plus an explanation of what the region means.
6. Open the evidence trail and show the retained document/page/crop, hashes, agent activity, explanation authorities, and uncertainty.
7. Choose **Save to notes**, refresh, and reopen the result to prove persistence and human authority.
8. Close with: “The agent teaches; PaperPilot proves what it saw; the reader decides what to keep.”

The exact rehearsal paper is replaceable. The same steps must work with another admitted PDF without changing code or configuration.

## Submission Story

PaperPilot addresses a common reason people abandon scientific reading: the paper assumes vocabulary, mathematics, methods, and visual literacy that the reader has not yet acquired. WebMCP turns the Reader into an agent-native teaching surface. Instead of copying fragments into an unrelated chatbot, the user points at the exact thing they do not understand, the browser agent receives bounded source context through structured tools, and PaperPilot stages the explanation back beside the source.

The distinctive contribution is provenance-aware teaching. PaperPilot preserves where the explanation came from without making the false promise that agents cannot hallucinate. It distinguishes exact document evidence, image-derived interpretation, mentor background, external citations, agent activity, and the reader's decision. The result is more accessible than a static paper and more inspectable than generic PDF chat.

PaperPilot is an existing application. The submission must clearly identify the post-2026-08-25 WebMCP Reader, text-and-figure selection, structured mentor explanation, evidence trail, accessibility work, and judge experience as the new challenge work.

## Timebox

- **By Tuesday, 2026-09-01:** feature-complete text, figure, WebMCP, evidence-trail, and accessibility proof of concept.
- **Wednesday, 2026-09-02:** cross-PDF verification, public deployment, README/judge-flow reconciliation, and demo rehearsal.
- **Before Thursday, 2026-09-03 13:00 PT:** record and publish the demo, complete the Devpost entry, tag the exact release, verify the public artifacts, and freeze the submitted repository and live site through judging.
