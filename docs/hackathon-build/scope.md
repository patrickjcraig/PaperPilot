# Project Scope

**Status:** Approved redesign baseline for The WebMCP Challenge, 2026-08-30
**Owner decision:** The knowledge graph, spatial PDF annotation, and a substantially richer WebMCP surface are now the first implementation priority. Networking, Zotero, crawler expansion, and broad service plumbing remain later work.

This document is the canonical product scope for the current PaperPilot hackathon build. It supersedes the earlier transcript-led, two-tool Reader plan wherever the two conflict. Earlier live-demo evidence remains valid as historical proof of WebMCP registration and callbacks; it is not the target product experience.

The public flow is paper-agnostic: a previously unseen admitted PDF follows the same parser, map, anchor, graph, WebMCP, and reducer paths, and paper-specific application logic is prohibited.

## Project Name

- **PaperPilot** — confirmed.

## One-Line Summary

PaperPilot is a paper-centered WebMCP research mentor that lets a reader point directly at difficult text, mathematics, or figures, understand it in place, and build a source-grounded knowledge graph whose agent edits are visible, reversible, and traceable to the paper.

## North Star

> Read the real paper in the middle. Point at the hard part. Let a research mentor explain and map it. Follow every idea back to its source—and undo any agent edit you do not want.

## Target User

The first user is a general reader at approximately undergraduate level encountering an early difficult scientific paper. They have basic prior knowledge and enough motivation to read the paper, but not the paper's assumed vocabulary, mathematics, methods, or visual literacy.

The user should not need to copy text into a disconnected chatbot, learn graph terminology, understand WebMCP, or reconstruct where an explanation came from. PaperPilot should feel hip, calm, modern, and approachable, with accessibility treated as part of the core interaction rather than a compatibility pass.

## Problem

Scientific papers are spatial documents, but most AI reading tools detach answers from that spatial context. A reader highlights a sentence, asks a question elsewhere, receives an answer, and then has to determine:

- where the relevant statement appears on the actual page;
- how the statement connects to the paper's other ideas;
- which parts of the answer come from the paper;
- which parts are mentor background or interpretation; and
- whether an agent changed the reader's notes or conceptual model correctly.

The current PaperPilot prototype proves a bounded WebMCP read/stage loop, but its visible transcript separates selection from the PDF, its graph is absent, and its two tools cannot navigate or evolve the reader's understanding. The redesign closes those gaps.

## Core Experience

1. The user uploads a previously unseen scientific PDF that meets the published admission limits.
2. PaperPilot renders the actual PDF as one continuous vertical document in the dominant middle workspace. There is no persistent visible transcript pane or page-at-a-time carousel.
3. While the PDF loads, PaperPilot automatically creates a whole-paper structural map from trustworthy document structure: title, outline, detected headings, page ranges, figures or visual-only pages when available. If structure is weak, every page still receives honest map coverage.
4. The user highlights words where they appear on the page or draws/selects a figure, equation, or visual region. PaperPilot creates a spatial source anchor and visible annotation overlay.
5. The user asks the browser research mentor for an explanation, a prerequisite, a comparison, or a graph change.
6. WebMCP tools let the agent read only the active anchored source and a bounded graph view, navigate to existing source anchors, stage a structured mentor explanation, and apply bounded graph or annotation patches.
7. Explanations appear in the left mentor rail without moving the paper. Selecting an explanation citation, annotation, or graph node returns the user to the exact page region.
8. Agent graph edits apply immediately but reversibly. A visible revision notice describes what changed, and human-only **Undo** and **Redo** controls provide the soft check. Deletion creates a reversible tombstone rather than destroying history.
9. The right rail switches between **Knowledge graph** and **Evidence trail**. The graph helps the reader think; the trail shows what source, tool callback, graph revision, and human action produced the current state.
10. The public no-login `/webmcp/` vertical slice ships first. The same contracts then move into the authenticated Supabase-backed service.

## Product Layout

At wide widths:

```text
┌────────────────────┬──────────────────────────────────────┬──────────────────────┐
│ Research mentor    │                Paper                 │ Graph | Evidence     │
│                    │                                      │                      │
│ Active question    │ Actual PDF pages                     │ Whole-paper map      │
│ Explanation        │ Selectable PDF.js text layer         │ Main ideas           │
│ Terms / math       │ Highlight + annotation overlay       │ Relationships        │
│ Source citations   │ Figure/region selection              │ Provenance trail     │
│                    │ Page navigation + zoom               │ Undo / Redo          │
└────────────────────┴──────────────────────────────────────┴──────────────────────┘
```

- The paper owns roughly 55–60% of the usable width and is always the visual center.
- The mentor rail sits on the left.
- The right rail uses Graph/Evidence tabs rather than adding a fourth narrow column.
- At narrow widths, the paper remains primary and the rails become accessible tabs or drawers.
- Logical reading order remains paper → mentor → graph/evidence even when wide-screen CSS places the mentor visually on the left.

## What We Are Building

### 1. A central, spatially annotated PDF Reader

- PDF.js renders a continuous vertical page stack with bounded mounting, active-page tracking, a direct page locator, zoom, and honest loading/error states.
- A synchronized transparent text layer lets users select words where they appear in the PDF.
- A PaperPilot-owned DOM/SVG annotation layer renders text highlights, equation marks, figure bounds, and arbitrary regions.
- Text anchors retain page, rotation, PDF-space quad points, normalized bounds, exact quote, bounded prefix/suffix, admitted extraction identity when available, and digests.
- Visual anchors retain the exact rendered page/region identity, page, rotation, normalized bounds, renderer recipe, and artifact digest when persisted.
- The original uploaded PDF remains immutable.
- The visible transcript window is removed. An accessible semantic page/annotation outline may support assistive technology, but it is not a second visual reading surface.

### 2. An automatic whole-paper knowledge map

Every admitted PDF gets a map immediately.

- The initial map is structural and honest: one paper node, section or heading nodes where confidently detected, and page/visual-only fallback nodes for uncovered material.
- The map shows coverage progress so “whole paper” means every page belongs to a visible structural region, not that an agent has already understood every claim.
- Semantic nodes—main ideas, concepts, terms, methods, results, prerequisites, figures, and equations—are added or refined by the browser mentor and the reader.
- Paper-grounded nodes and edges require one or more valid source anchors.
- Mentor-background nodes are allowed for prerequisites but remain visibly labeled **Mentor background** and cannot masquerade as paper claims.
- Layout position is a presentation preference, not scientific meaning or provenance.

### 3. A Graphology-backed graph model

- Use Graphology's `MultiDirectedGraph` with self-loops disabled.
- Use stable explicit string keys for nodes and edges; never treat insertion order as identity.
- Canonical PaperPilot records—not a Graphology memory dump—are the persistence and audit authority.
- Supported first-release node types: `paper`, `section`, `main_idea`, `concept`, `term`, `method`, `result`, `prerequisite`, `figure`, and `equation`.
- Supported first-release edge types: `contains`, `defines`, `depends_on`, `uses`, `enables`, `supports`, `contrasts_with`, `produces`, `evidenced_by`, and `appears_in`.
- The rendered graph has an equivalent keyboard-operable outline. Graph visualization is never the only way to inspect or edit it.

### 4. A richer WebMCP interface

PaperPilot will register a focused suite rather than only a source read and explanation stage:

- `paperpilot.read_focus` — read the active human-minted text/region anchor and its bounded context.
- `paperpilot.read_graph` — read a bounded whole-map overview, focused neighborhood, issued-node neighborhood, or plain-text graph search result.
- `paperpilot.stage_explain` — stage one structured research-mentor explanation bound to the active source and graph revision.
- `paperpilot.apply_graph` — add, update, connect, unlink, or tombstone graph items as one reversible revision.
- `paperpilot.apply_annotation` — label or link an existing trusted anchor without accepting model-authored coordinates.
- `paperpilot.focus_source` — navigate the central paper to an existing source anchor and announce it.

The tool surface is deliberately capable enough for the agent to traverse the paper, inspect the current conceptual model, explain material, and make visible graph changes. It still cannot replace the original PDF, export a modified PDF, hard-delete history, claim verification, or activate Undo/Redo for the reader.

### 5. Reversible agent mutations as the soft user check

- `apply_graph` and `apply_annotation` may change the working map immediately.
- Each mutation records actor, tool, base revision, forward patch, inverse patch, affected keys, source anchors, reason, timestamp, and before/after digests.
- A graph mutation is visibly announced and highlighted.
- **Undo** and **Redo** are ordinary human UI controls and remain outside the WebMCP tool list.
- Delete operations create tombstones and include all affected incident edges in the same inverse patch.
- A stale base revision is rejected; the agent must reread instead of silently rebasing.
- A new edit after Undo clears the redo branch.
- Reversible application is not verification. Graph items retain their authority labels and uncertainty.

### 6. A graph-aware research-mentor explanation

The default mentor response uses:

1. **Quick take**
2. **Where this fits in the paper**
3. **What you need first**
4. **How it works**
5. **Evidence in the paper**
6. **Related ideas in the map**
7. **Limits and uncertainty**

The voice is a patient, precise research mentor speaking to an undergraduate reader. Paper evidence, rendered-page observation, derived context, mentor interpretation, mentor background, and external sources remain distinct at the point of use.

### 7. Bidirectional paper ↔ graph navigation

- Selecting an annotation focuses linked graph nodes.
- Selecting a graph node highlights its source anchors and moves the paper to the primary one.
- Selecting an edge shows the anchors that justify the relationship.
- An explanation citation navigates to the matching annotation.
- Missing or stale sources remain visible as **Source incomplete** rather than silently disappearing.

### 8. An evidence trail that includes graph history

The evidence trail records:

- PDF identity and page/region anchor;
- automatic structural-map derivation;
- WebMCP registration and observed callbacks;
- explanation proposal and source coverage;
- graph/annotation revision with before/after digest;
- Undo or Redo action;
- authority and uncertainty for each node/edge; and
- any later authenticated persistence decision.

The trail does not claim that a digest proves truth, a graph relation is scientifically correct, or an agent used context correctly merely because a callback occurred.

### 9. Arbitrary-PDF and accessibility contracts

- No application path may recognize a rehearsal paper by filename, title, DOI, digest, or content.
- Born-digital papers use spatial text selection when the text layer can be reconciled honestly.
- Weak-text and scanned papers retain page/figure/region anchors and a structural page map.
- Corrupt, encrypted, oversized, or non-renderable inputs fail explicitly with no fixture substitution.
- Keyboard users can upload, move pages, zoom, create supported anchors, navigate annotations, inspect/edit the graph outline, request mentor help, and use Undo/Redo.
- Screen-reader users receive named regions, source summaries, graph structure, graph changes, status announcements, and source-navigation results.
- Proposed, agent-applied, user-authored, system-derived, and tombstoned states differ by text/icon/pattern as well as color.
- The full flow remains usable at 200% zoom, 320 CSS pixels, and with reduced motion.

### 10. Public vertical slice first, durable service second

The first release target is the public no-login `/webmcp/` experience because it is the fastest judge-visible proof of the new interaction. It may use browser memory/localStorage, clearly labeled as prototype persistence.

After that vertical slice is proven, the same anchor, graph, revision, explanation, and evidence contracts move into the authenticated Next.js/Supabase service. The serverless production topology remains Vercel Functions + Workflow + disposable Sandbox + Supabase PostgreSQL/Storage. Infrastructure work that does not unblock the public graph/annotation/WebMCP proof is deprioritized.

### 11. Future-ready, not prematurely cross-paper

Current graph interaction remains within one uploaded paper. Records use stable document-scoped keys plus optional canonical concept keys so a later workspace graph can connect ideas across papers without rewriting anchor provenance.

Cross-paper relationships, global deduplication, embeddings, and literature retrieval are explicitly later work. No current UI may imply those connections exist.

## `pdfAnnotate` Decision

The project evaluated [`highkite/pdfAnnotate`](https://github.com/highkite/pdfAnnotate) at commit `b5e5bc2a4947d604610d15d78f47289074a0f2b7`.

- Its package is a PDF annotation byte writer/parser, not a viewer or live overlay.
- Because annotated-PDF export is explicitly out of scope, the package has no runtime responsibility in this release and will not sit on the critical path.
- PaperPilot adopts interoperable PDF-style rectangles and quad points in its owned anchor contract and records the library as the evaluated future export adapter.
- If export returns later, it requires a maintained attributed fork, worker isolation, Unicode fixes, output validation, and explicit human initiation. The original PDF is never overwritten.

This is a deliberate use of the repository's design constraints without pretending it can provide the in-window experience it does not implement.

## Definition of Done

The redesigned hackathon proof is done when:

- the actual PDF is the dominant middle surface and no visible transcript pane remains;
- two unrelated valid PDFs create automatic structural maps covering all admitted pages without paper-specific code;
- a user can spatially highlight text and select a figure/region directly on the paper;
- anchors remain visibly aligned through zoom and page navigation;
- the graph shows multiple node/edge types, source grounding, and mentor-background distinction;
- the browser agent autonomously calls read, explanation, navigation, and reversible graph-mutation tools in a recorded supported client;
- the agent can add and tombstone nodes, and human Undo/Redo visibly restores the correct graph and source links;
- graph nodes, edges, annotations, explanations, and activity link back to exact source anchors;
- a graph node can focus its paper location and an annotation can focus its graph neighborhood;
- the evidence trail distinguishes automatic structure, document evidence, agent interpretation, graph revision, and human reversal;
- the primary path is keyboard operable and screen-reader understandable;
- unsupported PDFs, absent WebMCP, stale graph revisions, missing sources, and failed mutations stop honestly; and
- the public repository, MIT license, live URL, demo plan, and release claims reflect the redesigned product rather than the historical transcript prototype.

## What We Are Not Building Now

- A persistent visible transcript beside or beneath the PDF.
- Annotated-PDF download, PDF byte rewriting, or overwriting the uploaded original.
- A crawler, Google Scholar scraper, new Zotero flow, or broader networking work.
- Cross-paper graph interaction, whole-library synthesis, or collaboration on the graph.
- A vector database, embeddings pipeline, or RAG index for the hackathon proof.
- A second server-side explanation model; the WebMCP browser agent remains the mentor.
- Perfect semantic understanding from automatic structural parsing.
- Automatic scientific verification, citation authority scoring, or a guarantee against hallucination.
- Agent-controlled Undo/Redo, permanent hard deletion, or silent graph rebasing.
- Perfect figure, equation, caption, or heading detection across every PDF producer.
- Full native annotation import/export compatibility with every PDF implementation.
- Multilingual translation, text-to-speech, or an adaptive curriculum in this release.

## Demo Path

The target presentation is one continuous flow under three minutes:

1. Upload a previously unseen scientific PDF.
2. Open the Reader: the paper is centered and the whole-paper structural map appears automatically.
3. Highlight a difficult sentence where it appears on the PDF. Show the spatial annotation and graph focus.
4. Ask the browser mentor to explain it and improve the map.
5. Show autonomous `read_focus`, `read_graph`, `stage_explain`, and `apply_graph` callbacks.
6. Reveal the graph-aware explanation, a new grounded main-idea node, and its exact source link.
7. Ask the agent to remove or change a node; show the reversible revision, then press **Undo** and **Redo**.
8. Select a figure or visual region and show the same anchor/evidence mechanism.
9. Click a graph node to jump back to the paper and open the evidence trail.
10. Close with: “The paper stays central, the agent can teach and organize, every idea points back to evidence, and the reader can always undo.”

## Submission Story

PaperPilot turns WebMCP from a two-call integration into an agentic reading environment. The browser mentor can inspect the exact spatial focus, understand the reader's evolving paper map, navigate the document, explain difficult material, and modify the map through typed tools. The app gives those mutations real product effect while keeping them reversible and auditable.

The distinctive visual is immediate: mentor on the left, real paper in the middle, knowledge graph and evidence on the right. A judge sees the source, agent action, graph change, Undo/Redo, and provenance in one frame.

## Timebox And Priority

- **First:** redesign and redeploy the public `/webmcp/` vertical slice with central PDF annotation, automatic whole-paper map, richer WebMCP tools, reversible graph edits, and evidence.
- **Second:** prove text, figure/region, graph mutation, Undo/Redo, accessibility, and failure behavior across unrelated PDFs.
- **Third:** fold the proven contracts into the authenticated Supabase-backed service.
- **Later:** cross-paper knowledge links, Zotero/crawler/networking expansion, vector retrieval, and PDF export.
