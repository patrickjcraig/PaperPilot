# PaperPilot

A WebMCP research mentor that turns questions on a real scientific paper into source-linked explanations and ideas you can inspect, organize, and undo.

[Try PaperPilot](https://patrickjcraig.github.io/PaperPilot/webmcp/) · [Watch the demo](https://youtu.be/EDpbN35rDfQ) · [Explore the MIT-licensed code](https://github.com/patrickjcraig/PaperPilot)

## Inspiration

Scientific papers assume you know the vocabulary, mathematics, and how to read their figures. A summary can explain the topic without teaching you the sentence that stopped you.

Moving that sentence into a separate chat loses its location. Which paragraph supports the answer? What came from the authors, and what is model-supplied background? PaperPilot gives undergraduate-level readers a patient research mentor without losing sight of the paper.

## What it does

The actual PDF stays in the middle, with continuous scrolling, a mentor beside it, and a knowledge graph and evidence trail on the other side. There is no persistent duplicate transcript.

Highlight text on the page or mark a region with a description. PaperPilot creates an immutable source anchor, a visible annotation, and a linked reader-authored idea. A whole-paper structural map helps you navigate; separately labeled, unreviewed semantic suggestions provide starting points, not a claim that the application understands every page.

The browser agent can explain prerequisites, connect concepts, add a question annotation, and return to the source. Seven mentor sections organize the response from a quick take through mechanisms, evidence, related ideas, and uncertainty. Individual claims distinguish document evidence, interpretation, background, and unverified external citations.

## Why WebMCP

The page knows facts an agent should not invent: the active PDF, selected words, source geometry, issued identifiers, and current graph revision. WebMCP makes that application knowledge and its permitted actions available through structured tools.

PaperPilot registers six native capabilities through `document.modelContext.registerTool`: `paperpilot.read_focus`, `paperpilot.read_graph`, `paperpilot.focus_source`, `paperpilot.apply_graph`, `paperpilot.apply_annotation`, and `paperpilot.stage_explain`. They support bounded reading, literal graph search, source navigation, reversible edits, and explanation staging. The agent changes the same graph and annotations the reader uses.

Current public-release evidence records actual native callbacks on *Attention Is All You Need* and the unrelated GW150914 paper, plus limited-text and invalid-input checks. Registration alone is not our demonstration of agent use.

## Human–agent collaboration

The reader chooses what is confusing. The agent teaches and organizes. The application checks sources, authority, revisions, and duplicate commands before committing an edit with a receipt and reversible history. Stale or foreign-paper requests fail rather than silently changing the context.

Agent changes can appear immediately, but reader-side Undo and Redo provide the soft check. Mentor explanations remain local drafts until a separate Save decision. Saving, discarding, Undo/Redo, and PDF export are not WebMCP capabilities.

A source link establishes traceability, not scientific correctness. Neither a successful callback nor a digest proves that the model interpreted the paper correctly.

## How we built it

The public application is an anonymous static reader on GitHub Pages: no account, API key, database, or local server is needed. PDF.js renders the document; PaperPilot owns the spatial annotations and source anchors. Canonical records and a reversible reducer govern state. Graphology supplies topology, while Sigma and a complete keyboard-operable DOM outline provide graph views. Moving a node changes presentation, not evidence.

Optional browser recovery is tied to the exact PDF bytes by SHA-256. It retains workspace records and saved notes, not the PDF itself or unsaved mentor drafts. The original document is unchanged, and annotated-PDF export is excluded.

Codex helped with planning, implementation, tests, bounded parallel reviews, and browser verification. Real failures became regression tests: one navigation bug reported the right page while the viewer settled elsewhere after Undo/Redo. Replaying the repaired interaction checked the visible effect, not just the response. The demo uses edited live capture and disclosed synthetic narration.

## What I learned

This was my first experience with WebMCP and MCPs generally. I learned to design an agent-centric application around explicit capabilities, not an agent's unlimited access. The most valuable lesson was separating intent, source evidence, applied effects, and human judgment—and making those differences visible in the product.

## Try the flow

1. Open the public app in a WebMCP-capable browser/agent environment. Choose **Open the live demo** or a supported PDF.
2. Highlight a difficult passage, give it an idea label, and choose **Add highlight to the graph** above the PDF.
3. Ask the agent to read the selected source and graph, add a grounded concept and question annotation, return to the source, and stage an explanation with background clearly labeled.
4. Inspect the evidence trail, follow a source link, and use Undo/Redo to compare changes. The note can stay unsaved.

## Honest boundaries

This is a single-paper prototype, not universal PDF understanding. Admission is bounded to 25 MiB and 200 pages. Text extraction varies; there is no OCR service. Figure regions currently return `locator_only` and `pixelUseVerified: false`: a reader description is not proof that the agent observed pixels.

Accessibility shaped keyboard controls, descriptions, status announcements, and the non-canvas outline. The owner manually tested in Microsoft Edge without a screen reader. Human acceptance of the primary keyboard/screen-reader flow and graph accessibility, literal 200% zoom, and second-machine access remains unverified and is deferred for this hackathon entry. This is not an accessibility-certified service or general production signoff. Native WebMCP was tested with OpenAI Codex's in-app browser on Windows, not established by the separate Edge report. Without WebMCP, the manual reader remains usable, but native-agent success is not claimed.

## Existing project, new challenge work

PaperPilot already had discovery, project/import, and authenticated-service foundations. The challenge work refocused it into this paper-first public reader: spatial annotations, structural mapping, graph interaction, six native tools, claim-level mentor provenance, reversible commands, and browser recovery. Those older foundations are not presented as new work or as the public deployment's backend. The [dated change disclosure](https://github.com/patrickjcraig/PaperPilot/blob/main/docs/HACKATHON-CHANGELOG.md) and [current release evidence](https://github.com/patrickjcraig/PaperPilot/blob/main/docs/release/PUBLIC-RELEASE-REFRESH-2026-09-02.md) preserve that distinction.
