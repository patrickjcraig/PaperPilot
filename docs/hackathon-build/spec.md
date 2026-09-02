# PaperPilot Technical Specification

**Status:** Approved redesign architecture, 2026-08-30

**Target:** public `/webmcp/` graph-and-annotation vertical slice first

**Product contract:** [`scope.md`](./scope.md) and [`prd.md`](./prd.md)
**Build contract:** [`checklist.md`](./checklist.md)

> **Supersession notice:** This specification replaces the transcript-led Reader, source-left layout, two-tool-only WebMCP surface, graph deferral, and mandatory pre-apply approval model from the prior specification. Earlier source-read/stage recordings remain historical evidence only. The new release target centers the actual PDF, adds spatial annotations and an automatic structural whole-paper map, uses Graphology/Sigma, exposes richer WebMCP navigation and mutation tools, and governs agent graph edits with visible Undo/Redo.
>
> **Infrastructure invariant retained:** Production remains serverless: Vercel Next.js Functions + Vercel Workflow + one fresh non-persistent Vercel Sandbox per PDF attempt, with Supabase PostgreSQL and private Supabase Storage as the only durable authorities. No local database, VPS, shared production filesystem, or polling-worker fallback is allowed. That authenticated port follows the public product proof rather than blocking it.

## Overview

PaperPilot is a paper-centered research-mentor workspace. The browser renders an arbitrary bounded PDF with PDF.js, creates source anchors directly on its pages, derives an honest whole-paper structural map, and holds a semantic `MultiDirectedGraph` in Graphology. Sigma renders the visual graph; an equivalent DOM outline provides accessibility and a non-canvas control path.

A WebMCP-capable browser agent can:

1. read the current trusted source focus;
2. read a bounded graph overview or neighborhood;
3. navigate the PDF to an issued source;
4. stage a graph-aware mentor explanation;
5. apply one atomic, reversible graph patch; and
6. apply a bounded annotation label/link patch to an existing page-minted anchor.

Graph and annotation patches apply immediately after trusted validation. Each produces a visible revision and a trusted inverse. Human-only Undo/Redo is the soft review mechanism. Explanation cards remain proposals that may be kept or discarded independently. The original PDF bytes are immutable and no annotated-PDF export exists.

### Release outcome

The public redesign is release-ready only when:

- the PDF is the dominant middle surface and no persistent visible transcript remains;
- multiple pages render as one continuous vertical paper and support direct text or visual-region anchoring;
- every admitted page belongs to an automatic structural map coverage state;
- the map uses multiple typed nodes and directed typed edges with visible authority;
- paper-grounded semantic entities require valid spatial anchors;
- the supported WebMCP client autonomously invokes read, navigation, mutation, and explanation callbacks;
- an agent can add, update, relate, and tombstone graph items;
- Undo and Redo reproduce exact prior/post semantic graph digests;
- graph node/edge selection navigates to PDF annotations and annotation selection focuses graph context;
- the evidence trail records callbacks, graph revisions, inverses, Undo/Redo, and explanation authority without overclaiming;
- keyboard and screen-reader routes cover the complete primary flow;
- the same implementation works across unrelated PDFs without paper-aware branches; and
- the live/repository/demo claims state browser-local persistence, no PDF export, no cross-paper UI, and no scientific-verification guarantee.

### PRD epic mapping

| PRD epic | Primary components |
| --- | --- |
| Epic 1: Start with the real paper | upload gate, PDF session, progressive indexer |
| Epic 2: Keep the PDF in the middle | workspace shell, multi-page PDF.js viewer, responsive rails |
| Epic 3: Mark the exact source | text layer, anchor builder, region selector, overlay, annotation list |
| Epic 4: Automatic whole-paper map | document index, outline/heading seed, coverage ledger |
| Epic 5: Understand/navigate graph | Graphology store, Sigma projection, accessible outline, focus controller |
| Epic 6: Useful WebMCP tools | registration adapter, bounded readers, navigation, mutation and stage contracts |
| Epic 7: Agent evolves map safely | graph command reducer, validation, optimistic apply/rollback, revision conflicts |
| Epic 8: Undo/Redo | trusted inverse patches, command history, compensating evidence events |
| Epic 9: Graph-aware mentor | explanation validator and left-rail review UI |
| Epic 10: Evidence trail | append-only event ledger and technical disclosure |
| Epic 11: Restore/future-ready IDs | PDF-digest local snapshot, schema migrations, same-paper guard |
| Epic 12: Accessibility | semantic regions, annotation list, graph outline, focus/status/reflow rules |

## Architecture Principles

1. **The PDF is immutable input.** UI overlays, graph records, explanations, and provenance live outside PDF bytes.
2. **Spatial anchors are page-minted.** The agent may reference an issued anchor but never authors coordinates, digests, timestamps, or document identity.
3. **Structural mapping is automatic; semantic mapping is honest.** PaperPilot automatically covers every page using outline/headings/fallback page groups. The browser mentor adds semantic concepts through bounded source reads.
4. **Graphology is the in-memory topology engine.** PaperPilot contracts and revision records remain persistence/provenance authority.
5. **Sigma is a projection.** Canvas layout attributes are never semantic graph data or evidence.
6. **Agent mutations are real and reversible.** A valid patch applies immediately, records an inverse, and exposes human Undo/Redo.
7. **No silent rebasing.** Mutations require the revision/digest the agent read; stale writes fail atomically.
8. **Grounding is structural.** Paper-backed nodes/edges cannot exist without compatible active-paper anchors.
9. **Background remains background.** Prerequisite knowledge can exist without a paper source only under `mentor_background` authority.
10. **Callbacks are observable facts, not reasoning proof.** Registration, read, navigation, stage, mutation, Undo, and Redo remain distinct events.
11. **The public slice is truthfully browser-local.** Server durability enters only in the authenticated port.
12. **Cross-paper readiness is not cross-paper functionality.** IDs are collision-resistant and document-scoped; current commands reject foreign-paper data.

## Stack

### Public vertical slice

| Layer | Choice | Version policy | Responsibility |
| --- | --- | --- | --- |
| Language | TypeScript | repository compiler | Closed contracts, reducers, adapters, UI composition |
| PDF runtime | `pdfjs-dist` | exact `6.3.289` | PDF parsing, multi-page canvas/text layers, outline, viewport transforms |
| Graph model | `graphology` | exact `0.26.0` | Directed multigraph topology and safe graph operations |
| Graph renderer | `sigma` | exact `3.0.3` | Interactive canvas rendering of a derived graph projection |
| Optional layout | `graphology-layout-forceatlas2` | exact `0.10.1`, only if the client spike stays responsive | Stable graph layout; run off the interaction path/worker where practical |
| Hashing | Web Crypto | browser platform | PDF, anchor, graph, explanation, and event digests |
| Persistence | `localStorage` | versioned bounded snapshot | Explicitly browser-local prototype recovery keyed by PDF SHA-256 |
| Packaging | reproducible npm browser bundle | exact lockfile | Same-origin PDF.js worker and pinned graph dependencies for GitHub Pages |
| WebMCP | `document.modelContext.registerTool` | named-client tested | Bounded site tools and callback lifecycle |

The exact direct dependency versions above were verified against the package registry on 2026-08-30. Runtime floating CDN imports are removed from the target build. The PDF.js module and worker must be the same exact version and ship from the same release output.

### Authenticated service port

The later port reuses the existing Next.js 16.3.x, React 19, Better Auth, Prisma 7.10, Supabase PostgreSQL/private Storage, Vercel Workflow, and Vercel Sandbox architecture. Graphology remains client/in-process topology; Supabase records are durable authority.

### `highkite/pdfAnnotate` / `annotpdf` decision

Audited upstream: `highkite/pdfAnnotate` commit `b5e5bc2a4947d604610d15d78f47289074a0f2b7`, npm package `annotpdf@1.0.15`, MIT.

- The project writes annotation objects into PDF bytes and explicitly is not a viewer/renderer.
- The user has explicitly excluded annotated-PDF export.
- Therefore `annotpdf` has no runtime or build-time role in this release: do not install, import, vendor, copy, or call it.
- PaperPilot retains PDF-compatible rectangle and quad-point semantics in its owned anchor schema so a future export adapter can translate without changing provenance.
- An ADR records the evaluation and future conditions: owned attributed fork, reproducible lock, worker isolation, Unicode fixes, output validation, signed/encrypted-PDF policy, and explicit human initiation.

This decision satisfies the desired in-window annotation experience with PDF.js plus a PaperPilot overlay while avoiding a false claim that a byte writer supplies interaction, accessibility, or arbitrary-PDF rendering.

## Logical Architecture

```text
                         WEBMCP-CAPABLE BROWSER
┌────────────────────────────────────────────────────────────────────────────┐
│ PaperPilot /webmcp                                                         │
│                                                                            │
│  Mentor rail          Central paper                       Graph | Evidence │
│  ┌─────────────┐      ┌────────────────────────────┐      ┌──────────────┐ │
│  │ Explanation │◄────►│ PDF.js canvas              │◄────►│ Sigma graph  │ │
│  │ Source chips│      │ continuous page stack      │      │ DOM outline  │ │
│  │ Graph links │      │ text + annotation layers   │      │ event trail  │ │
│  └─────────────┘      │ region interaction layer   │      │ Undo / Redo │ │
│                        └──────────────┬─────────────┘      └──────┬───────┘ │
│                                       │ trusted anchors                  │   │
│                              ┌────────▼────────────────────────────────┐  │
│                              │ PaperPilot domain state                 │  │
│                              │ - document index / coverage             │  │
│                              │ - immutable source anchors              │  │
│                              │ - annotations                           │  │
│                              │ - Graphology MultiDirectedGraph         │  │
│                              │ - revision + inverse history            │  │
│                              │ - explanation proposals                 │  │
│                              │ - append-only evidence events           │  │
│                              └──────────────┬──────────────────────────┘  │
│                                             │ trusted adapter refs         │
│  WebMCP tools: read_focus · read_graph · focus_source                    │
│                stage_explain · apply_graph · apply_annotation            │
└─────────────────────────────────────────────┼──────────────────────────────┘
                                              │
                                              ▼
                                  Browser research mentor
```

### Visual and logical layout

Wide-screen CSS areas:

```css
grid-template-columns: minmax(17rem, 0.72fr) minmax(38rem, 2fr) minmax(20rem, 0.9fr);
grid-template-areas: "mentor paper rail";
```

Normative behavior:

- The paper is first in DOM order, visually placed in the middle with CSS grid.
- The paper receives at least 50% and targets 55–60% of workspace width; its internal scrollport presents one continuous vertical document.
- The mentor is visually left; Graph/Evidence share the right rail.
- Loaded-state marketing/hero content collapses so the page owns the viewport.
- At narrow widths/200% zoom, the paper remains first and rails become ordinary tabs/drawers.
- Skip links target Paper, Mentor, Knowledge graph, and Evidence.

## File Structure

The public source becomes modular and reproducibly bundled. Generated assets are not hand-edited.

```text
PaperPilot/
├─ package.json                                      [M]
│  Add exact Graphology/Sigma/layout and browser-bundle scripts.
├─ package-lock.json                                 [M]
├─ webmcp/                                           [A]
│  ├─ index.html
│  │  Source template for the anonymous page.
│  ├─ main.ts
│  │  Composition/bootstrap and the declared WebMCP registration entrypoint.
│  ├─ styles.css
│  │  Paper-dominant layout, layers, graph/evidence rail, reflow, focus.
│  ├─ contracts.ts
│  │  Closed versioned document, anchor, annotation, graph, command, tool schemas.
│  ├─ pdf/
│  │  ├─ reader.ts
│  │  │  PDF.js lifecycle, continuous multi-page rendering, text layers, outline, virtual page cache.
│  │  ├─ document-index.ts
│  │  │  Progressive page/text/heading index and coverage ledger.
│  │  ├─ anchors.ts
│  │  │  Range geometry, PDF-space conversion, region anchors, digest binding.
│  │  ├─ annotation-overlay.ts
│  │  │  Render/focus marks from canonical geometry; no source authority.
│  │  └─ region-controller.ts
│  │     Pointer/numeric region mode and cancellation.
│  ├─ graph/
│  │  ├─ graph-store.ts
│  │  │  Graphology MultiDirectedGraph and canonical import/export projection.
│  │  ├─ structural-map.ts
│  │  │  Outline/heading/page-group seed and coverage state.
│  │  ├─ graph-commands.ts
│  │  │  Atomic validation, forward/inverse patch reducer, revision/digest logic.
│  │  ├─ graph-view.ts
│  │  │  Sigma projection, filters, focus, and layout preferences.
│  │  └─ graph-outline.ts
│  │     Accessible node/edge list with equivalent actions.
│  ├─ mentor/
│  │  ├─ explanation-contract.ts
│  │  │  Graph-aware seven-section validation.
│  │  └─ mentor-panel.ts
│  │     Review UI, authority labels, source and graph links.
│  ├─ webmcp/
│  │  ├─ tool-contracts.ts
│  │  │  Closed schemas and bounded results.
│  │  └─ register-tools.ts
│  │     Feature detection, registration lifecycle, trusted refs, callbacks.
│  ├─ provenance/
│  │  ├─ event-ledger.ts
│  │  │  Append-only observed action records.
│  │  └─ evidence-panel.ts
│  │     Simple trail and technical details.
│  ├─ persistence/
│  │  └─ browser-snapshot.ts
│  │     Bounded schema migration and digest-keyed localStorage.
│  └─ tests/
│     Contract/reducer/geometry/index/fallback fixtures.
├─ scripts/
│  └─ build-webmcp.mjs                               [A]
│     Reproducible bundle/copy/worker build into public/webmcp.
├─ public/webmcp/                                    [generated/release output]
│  ├─ index.html
│  └─ assets/*
├─ .github/workflows/pages.yml                       [M]
│  Run npm ci + build:webmcp, then upload public/.
├─ scripts/check-devpost-readiness.mjs               [M]
│  Gate spatial Reader, graph tools, mutation, Undo/Redo, a11y, and no export.
├─ devpost-requirements.json                         [M]
├─ README.md                                         [M]
└─ docs/
   ├─ ADR-PDF-ANNOTATION-RUNTIME.md                  [A]
   ├─ DEVPOST-JUDGE-GUIDE.md                         [M]
   ├─ DEVPOST-COMPLIANCE.md                          [M]
   ├─ DEMO-VIDEO-PLAN.md                             [M]
   └─ hackathon-build/*                              [M]
```

Later authenticated port:

```text
src/components/paper-mentor/
├─ annotated-pdf-reader.tsx
├─ pdf-annotation-overlay.tsx
├─ knowledge-graph-panel.tsx
├─ knowledge-graph-outline.tsx
├─ mentor-review-panel.tsx
└─ graph-evidence-trail.tsx

src/lib/paper-mentor/
├─ contracts.ts
├─ graph-store.ts
├─ graph-commands.ts
├─ source-anchors.ts
└─ webmcp-adapter.ts

src/server/paper-mentor/
├─ graph-service.ts
├─ annotation-service.ts
├─ explanation-service.ts
└─ provenance-service.ts
```

## Canonical Public Data Contracts

Every schema is closed (`additionalProperties: false` at WebMCP boundaries), versioned, size-bounded, and rendered with text nodes rather than raw HTML.

### Document session and page index

```ts
type Sha256 = string; // lowercase 64-character hex

type PaperSessionV1 = {
  schemaVersion: 1;
  paperRef: string;              // page-minted opaque key
  documentSha256: Sha256;
  documentRevision: 1;
  filename: string;              // display only, never identity
  byteLength: number;
  pageCount: number;
  status: "loading" | "ready" | "partial" | "failed";
  createdAt: string;
};

type PageIndexEntryV1 = {
  pageIndex: number;             // zero-based internally
  pageLabel: string;
  rotation: 0 | 90 | 180 | 270;
  widthPdfPoints: number;
  heightPdfPoints: number;
  textCapability: "exact_candidate" | "visual_only" | "failed";
  textItems: Array<{
    itemRef: string;
    text: string;
    transform: number[];
    width: number;
    height: number;
  }>;
  textDigest?: Sha256;
  outlineRefs: string[];
  mappingState: "pending" | "structural" | "semantic" | "limited" | "failed";
};

type MapCoverageV1 = {
  pageCount: number;
  indexedPages: number;
  structuralPages: number;
  semanticPages: number;
  limitedPages: number;
  failedPages: number;
  status: "building" | "structural_partial" | "structural_ready" | "semantic_partial" | "semantic_ready" | "failed";
};
```

Public-slice release limits are frozen at 25 MiB and 200 pages per PDF. It does not allocate every page canvas at once. The scroll stack retains deterministic page placeholders so document height and page order remain stable, while page metadata/text indexes are processed in bounded idle batches and expensive canvases/text layers are mounted for the active page plus a bounded neighboring window. Pages outside that window keep lightweight geometry placeholders and remount when they approach the viewport. Structural fallback groups contain at most ten contiguous pages.

Map status is computed, not asserted by the agent:

- `structural_ready` requires `failedPages === 0` and `structuralPages + limitedPages === pageCount`;
- `structural_partial` requires at least one navigable structural/limited page and at least one failed page;
- `failed` requires zero navigable structural/limited pages;
- `semantic_partial` and `semantic_ready` may only refine a structurally ready map, never hide structural or failed counts.

### Spatial source anchor

```ts
type PdfPoint = { x: number; y: number };
type PdfQuad = [PdfPoint, PdfPoint, PdfPoint, PdfPoint];
type NormalizedRect = { x: number; y: number; width: number; height: number };

type PaperAnchorV1 = {
  schemaVersion: 1;
  anchorId: string;
  paperRef: string;
  documentSha256: Sha256;
  documentRevision: 1;
  pageIndex: number;
  pageLabel: string;
  rotation: 0 | 90 | 180 | 270;
  coordinateSpace: "pdf-crop-box";
  sourceKind: "exact_text" | "visual_region" | "whole_page" | "whole_figure" | "equation";
  pdfQuads: PdfQuad[];
  normalizedBounds: NormalizedRect[];
  quote?: {
    exact: string;
    prefix: string;
    suffix: string;
    sha256: Sha256;
    utf8Bytes: number;
  };
  textItemRefs: string[];
  regionDigest?: Sha256;
  authority: "exact_document_text" | "client_rendered_pdf";
  anchorDigest: Sha256;
  createdBy: "human" | "system";
  createdAt: string;
};
```

Required anchor invariants:

- IDs, times, document binding, geometry, quote, and digests are minted by trusted page code.
- The anchor belongs to exactly one page in the public release. Cross-page selection is rejected with recovery copy.
- `pdfQuads` preserves each line/column rectangle; no single box may include unrelated text.
- Coordinates are canonical PDF CropBox coordinates. Viewport/display rectangles are derived.
- Exact quote, displayed quote, quote digest, and quads derive from one frozen Range snapshot.
- Accepted selection is at most 1,200 Unicode scalar values and 8 KiB UTF-8, whichever is reached first. Oversized selection is rejected before freeze; no tool result slices it later.
- An anchor becomes immutable once exposed to WebMCP or linked to a graph entity.
- Document replacement cancels/invalidates all active handles from the prior digest.
- A visual anchor may be created with no text layer and cannot inherit exact-text authority.

### Annotation

```ts
type AnnotationV1 = {
  schemaVersion: 1;
  annotationId: string;
  paperRef: string;
  anchorId: string;
  kind: "highlight" | "question" | "concept" | "note" | "region";
  label: string;
  body?: string;
  graphNodeKeys: string[];
  graphEdgeKeys: string[];
  status: "active" | "tombstoned";
  authority: "reader" | "agent" | "system";
  entityRevision: number;
  createdAt: string;
  updatedAt: string;
};
```

- Human selection creates an active source annotation directly.
- `apply_annotation` may label, classify, link, unlink, or tombstone only an existing issued anchor/annotation.
- It cannot change geometry, document binding, anchor digest, or human-authored body without an explicit human UI edit.
- Every agent annotation mutation uses the same reversible command engine as graph changes.

### Knowledge graph

Graphology instance:

```ts
const graph = new MultiDirectedGraph({ allowSelfLoops: false });
```

Stable semantic types:

```ts
type GraphNodeKind =
  | "paper" | "section" | "main_idea" | "concept" | "term"
  | "method" | "result" | "prerequisite" | "figure" | "equation";

type GraphEdgeKind =
  | "contains" | "defines" | "depends_on" | "uses" | "enables"
  | "supports" | "contrasts_with" | "produces" | "evidenced_by" | "appears_in";

type GraphAuthority =
  | "document_structure"
  | "paper_grounded"
  | "mentor_background"
  | "reader_authored";

type PageCoverageRefV1 = {
  startPageIndex: number;
  endPageIndex: number;
  primaryAnchorId: string;
};

type PaperGraphNodeV1 = {
  key: string;
  paperRef?: string;             // omitted in workspace-scoped records; trusted workspace supplies identity
  kind: GraphNodeKind;
  label: string;
  summary: string;
  authority: GraphAuthority;
  sourceAnchorIds: string[];
  structuralCoverage?: PageCoverageRefV1[];
  structuralBasis?: "paper_root" | "pdf_outline" | "heading_heuristic" | "page_fallback";
  structuralConfidence?: "document_declared" | "system_inferred" | "coverage_fallback";
  optionalCanonicalConceptKey?: string;
  salience: number;              // 0..1 presentation hint, not truth
  origin: "system" | "automatic_map" | "agent" | "reader";
  status: "active" | "tombstoned";
  entityRevision: number;
  createdAt?: string;
  updatedAt?: string;
};

type PaperGraphEdgeV1 = {
  key: string;
  paperRef?: string;             // when present, must match the trusted workspace
  sourceKey: string;
  targetKey: string;
  kind: GraphEdgeKind;
  claim?: string;
  authority: GraphAuthority;
  sourceAnchorIds: string[];
  origin: "system" | "automatic_map" | "agent" | "reader";
  status: "active" | "tombstoned";
  entityRevision: number;
  createdAt?: string;
  updatedAt?: string;
};
```

Required graph invariants:

- Explicit immutable string keys; never use labels, page numbers, object coercion, or insertion order as identity.
- All active edges have active endpoints in the same current `paperRef`.
- Multiple directed edges between the same endpoints are allowed only with distinct explicit edge keys.
- Self-loops are rejected.
- Paper-grounded nodes/edges require at least one current compatible anchor.
- `document_structure` nodes/edges derive only from outline/heading/page coverage and remain labeled structural.
- Every `document_structure` node has one or more nonoverlapping, current-paper `structuralCoverage` ranges. Trusted page code mints a `whole_page` anchor for each range's first page as `primaryAnchorId`; the coverage ledger, not the agent, establishes the remaining page range.
- The automatic map covers every navigable admitted page exactly once at its leaf structural layer. `focus_source` uses the primary anchor and exposes the full covered range; failed pages receive explicit failure placeholders but do not count as navigable coverage.
- `mentor_background` entities may have no paper anchor but remain textually distinct.
- `optionalCanonicalConceptKey` enables later reconciliation but has no automatic merge semantics now.
- Cross-paper endpoints/anchors are rejected at every public tool and reducer boundary.
- Tombstoned entities remain in revision/evidence history but are omitted from the active projection.
- `x`, `y`, `size`, `color`, `hidden`, hover, selection, camera, and animation state are renderer/view preferences and excluded from semantic records/digests.

### Graph revision and command history

```ts
type GraphEndpointRefV1 =
  | { refType: "issued_key"; key: string }
  | { refType: "client_ref"; clientRef: string };

type AddGraphNodeCommandV1 = {
  kind: GraphNodeKind;
  label: string;
  summary: string;
  authority: Exclude<GraphAuthority, "document_structure">;
  sourceAnchorIds: string[];
  optionalCanonicalConceptKey?: string;
  salience: number;
};

type AddGraphEdgeCommandV1 = {
  source: GraphEndpointRefV1;
  target: GraphEndpointRefV1;
  kind: GraphEdgeKind;
  claim?: string;
  authority: Exclude<GraphAuthority, "document_structure">;
  sourceAnchorIds: string[];
};

type GraphCommandOperationV1 =
  | { op: "add_node"; clientRef: string; node: AddGraphNodeCommandV1 }
  | { op: "update_node"; nodeKey: string; expectedEntityRevision: number; set: { label?: string; summary?: string; kind?: GraphNodeKind; authority?: Exclude<GraphAuthority, "document_structure">; sourceAnchorIds?: string[]; optionalCanonicalConceptKey?: string; salience?: number } }
  | { op: "tombstone_node"; nodeKey: string; expectedEntityRevision: number }
  | { op: "restore_node"; nodeKey: string; expectedEntityRevision: number }
  | { op: "add_edge"; clientRef: string; edge: AddGraphEdgeCommandV1 }
  | { op: "update_edge"; edgeKey: string; expectedEntityRevision: number; set: { kind?: GraphEdgeKind; claim?: string; authority?: Exclude<GraphAuthority, "document_structure">; sourceAnchorIds?: string[] } }
  | { op: "tombstone_edge"; edgeKey: string; expectedEntityRevision: number }
  | { op: "restore_edge"; edgeKey: string; expectedEntityRevision: number };

type AnnotationCommandOperationV1 =
  | { op: "create_annotation"; anchorId: string; expectedAnchorDigest: Sha256; annotationKind: AnnotationV1["kind"]; label: string; graphNodeKeys: string[]; graphEdgeKeys: string[] }
  | { op: "update_annotation"; annotationId: string; expectedEntityRevision: number; set: { label?: string; graphNodeKeys?: string[]; graphEdgeKeys?: string[] } }
  | { op: "tombstone_annotation"; annotationId: string; expectedEntityRevision: number }
  | { op: "restore_annotation"; annotationId: string; expectedEntityRevision: number };

// Trusted history patches are produced by the reducer, never accepted from a model.
// Each closed operation requires both endpoints; null means the entity is absent.
// Records include exact lifecycle metadata but never renderer attributes.
type WorkspacePatchOperationV1 =
  | { op: "put_node"; key: string; before: PaperGraphNodeV1 | null; after: PaperGraphNodeV1 | null }
  | { op: "put_edge"; key: string; before: PaperGraphEdgeV1 | null; after: PaperGraphEdgeV1 | null }
  | { op: "put_annotation"; key: string; before: AnnotationV1 | null; after: AnnotationV1 | null }
  | { op: "put_anchor"; key: string; before: PaperAnchorV1 | null; after: PaperAnchorV1 | null };

type WorkspaceRevisionV1 = {
  schemaVersion: 1;
  revisionId: string;
  paperRef: string;
  operationId: string;
  idempotencyKey: string;
  commandDigest: Sha256;
  actor: "agent" | "human";
  transport: "webmcp" | "direct_ui";
  toolName?: "paperpilot.apply_graph" | "paperpilot.apply_annotation";
  reason: string;
  fromRevision: number;
  toRevision: number;
  beforeWorkspaceDigest: Sha256;
  afterWorkspaceDigest: Sha256;
  beforeGraphDigest: Sha256;
  afterGraphDigest: Sha256;
  beforeAnnotationDigest: Sha256;
  afterAnnotationDigest: Sha256;
  beforeFocusAnchorId: string;
  afterFocusAnchorId: string;
  forwardPatch: WorkspacePatchOperationV1[];
  inversePatch: WorkspacePatchOperationV1[];
  affectedKeys: string[];
  sourceAnchorIds: string[];
  kind: "graph" | "annotation" | "reader_annotation_graph" | "reader_annotation_removal" | "undo" | "redo";
  relatedRevisionId?: string;
  reviewState: "not_applicable" | "unreviewed";
  createdAt: string;
};
```

The semantic workspace digest is SHA-256 over canonical JSON with lexicographically sorted node, edge, annotation, anchor-link, and attribute keys. It includes stable identity, semantic fields, grounding, authority, and active/tombstoned status. It excludes `entityRevision`, `createdAt`, `updatedAt`, workspace revision numbers, revision IDs, review state, provenance timestamps, Sigma coordinates/camera state, selection, hover, animation, and other UI metadata. The graph and annotation sub-digests use the same projections over their respective records. Therefore Undo and Redo create new history revisions while reproducing the original semantic before/after digests exactly. Immutable source-anchor records have their own digest validation; graph/annotation source links, rather than a duplicate raw-anchor registry, participate in the workspace semantic digest.

The item-7 working-tree implementation uses `workspace-patch.mjs` for closed patch validation, deterministic diff/inversion, exact before-record conflict checks, and application to independent Graphology/Map collections. `contracts.mjs` owns the sole `runWorkspaceTransaction` boundary and the shared `appendWorkspaceRevision` finalizer for agent graph edits, agent annotation edits, reader annotation creation, and reader annotation removal. Live `state.revisions` is an append-only patch ledger; `history` and `redoHistory` hold original patch revisions, not full before/after workspace snapshots. Revision records and their patches are deeply frozen. Temporary transaction clones remain an implementation detail for isolation and rollback; they are not retained as Undo history.

`put_anchor` is a trusted extension for atomic reader selection creation. Undo removes the newly minted anchor together with its annotation, node, and provenance edge; the original anchor remains in the retained revision and Redo reinstalls the exact immutable record. It is not an anchor-edit command: a patch cannot replace an existing anchor with different geometry or identity, structural anchors are protected, and the model has no anchor-minting or raw-patch input. Existing issued anchors remain deeply immutable through ordinary edits, patch replay, and browser restore.

Model commands never supply `paperRef`, `origin`, newly minted durable IDs, timestamps, status, revision-history records, or raw endpoint strings. The adapter injects current-paper authority and resolves the explicit `issued_key`/`client_ref` endpoint union. `idempotencyKey` is a caller-visible 8–64-character token. Repeating the same key with the same canonical command digest replays its original result without applying again; reusing it with different content fails with `idempotency_conflict`. A recovery-invalidated receipt retains `{ commandDigest, result: null }` as a reserved-key tombstone: the same command returns `idempotency_replay_unavailable`, not a new mutation or fabricated success. The reader/agent must reread current state and use a new key for a new intent.

Command algorithm:

1. Parse a closed, bounded command.
2. Check an existing idempotency key before stale-base validation. For a new command, require `baseWorkspaceRevision`, `baseWorkspaceDigest`, and the relevant graph/annotation sub-digest to match; recompute actual pre-edit digests before finalization so cached fields cannot legitimize an untracked semantic change.
3. Clone/import the canonical graph into a temporary `MultiDirectedGraph`.
4. Resolve model `clientRef` values to page-minted stable keys.
5. Validate all operations, entity revisions, endpoints, grounding, authority, limits, and same-paper scope against the clone.
6. Apply every validated operation to the clone or fail with no live state change. Tombstoning a node changes all active incident edges in the same batch while leaving already-tombstoned edges untouched. Explicit `restore_node` restores only the node; restoring an edge separately still requires active endpoints.
7. Compute normalized trusted forward/inverse patches from the complete before/after records. Replay the forward patch on an independent clone to validate references, immutable structure, and the intended result before committing.
8. Canonically export and digest the workspace clone using the defined semantic projections and lexicographic ordering; retain lifecycle metadata exactly in patches even though it is excluded from semantic digests.
9. Stage the complete result, patch revision, history/redo changes, replay receipt, and events in the same transaction. Validate the bounded success receipt before swapping live state and awaiting required projection integration.
10. Mark agent revisions `unreviewed`; publish optional activity observers only after the mandatory projection succeeds, then attempt the optional browser snapshot. An observer exception does not turn an actually committed edit into a rejection.
11. If mandatory history/event/replay work or projection integration fails, restore semantic collections, digests, revision ledger, both stacks, replay cache, and event state together. Emit a sanitized `graph_rolled_back` event when possible and report `rolled_back`; do not retain a success revision or replay receipt for the failed command. Validation/conflict failures before commit remain no-ops. A `localStorage` quota/write failure after a successful in-memory commit does not roll back valid live state; it reports **Not saved in this browser**, emits no false persistence event, and keeps live/revision state internally equivalent.

Undo and Redo:

- Undo applies the stored inverse as a new human revision with `kind: "undo"` and `relatedRevisionId`; it never deletes the original revision or event. Unlike explicit `restore_node`, it restores exactly the node and incident-edge records changed by the original patch.
- Redo reapplies the original forward patch as a new human revision with `kind: "redo"` and the same original `relatedRevisionId`.
- Both validate the live ledger head, current recomputed semantic digests, exact before records, inverse pairing, and expected after digests. They use the same atomic transaction boundary as ordinary edits.
- New divergent mutation after Undo clears only the redo stack, retains the append-only ledger, and emits `redo_branch_cleared`.
- An invalidated inverse/forward patch fails atomically with a clear message.
- The live ledger is capped at 200 entries, including compensating Undo/Redo revisions. New edits and Redo reserve enough capacity to Undo every remaining applied revision. At the limit, reject additional work with `history_limit_exceeded`; do not compact or silently drop history. This limit is separate from the bounded recent event list and the 4 MiB browser-storage budget.
- Buttons and `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`, `Ctrl+Y` are supported outside editable fields.
- Undo/Redo are never WebMCP tools.

### Provenance event

```ts
type ProvenanceEventV1 = {
  schemaVersion: 1;
  eventId: string;
  eventType:
    | "pdf_loaded" | "page_indexed" | "structural_map_created"
    | "anchor_created" | "annotation_changed"
    | "tools_registered" | "registration_failed"
    | "focus_read" | "graph_read" | "source_focused"
    | "explanation_staged" | "graph_applied" | "graph_rolled_back"
    | "undo_applied" | "redo_applied"
    | "explanation_saved" | "explanation_discarded";
  authority: "page_observed" | "client_asserted" | "agent_callback" | "human";
  actor: "system" | "agent" | "human";
  transport: "direct_ui" | "webmcp" | "browser_local";
  observedAt: string;
  paperRef: string;
  documentSha256: Sha256;
  toolName?: string;
  callbackReceiptId?: string;
  anchorIds: string[];
  graphRevisionId?: string;
  explanationId?: string;
  beforeDigest?: Sha256;
  afterDigest?: Sha256;
  parentEventId?: string;
  detailCode?: string;
};
```

Events are append-only. Undo does not delete the mutation it reverses. Registration never creates a tool-call event. No event contains whole-page transcript text, raw PDF bytes, hidden reasoning, credentials, storage paths, or browser history.

### Browser snapshot

The item-7 source implementation writes a version-3 envelope. This documents the working-tree architecture, not a claim that the release checklist or deployed bundle has passed. `browser-snapshot.mjs` owns the exact closed payload below; its current-state projection is serialized once, while every history entry contains canonical patches rather than full before/after snapshots.

```ts
type BrowserWorkspaceStateV3 = {
  anchors: Array<[string, PaperAnchorV1]>;
  annotations: Array<[string, AnnotationV1]>;
  graph: ReturnType<MultiDirectedGraph["export"]>;
  workspaceRevision: number;
  workspaceDigest: Sha256;
  graphDigest: Sha256;
  annotationDigest: Sha256;
  focusAnchorId: string;
};

type StoredMutationReceiptV1 = {
  schemaVersion: 1;
  status: "applied_reversible";
  replayed: false;
  callbackReceiptId: string;
  operationId: string;
  idempotencyKey: string;
  revisionId: string;
  fromRevision: number;
  toRevision: number;
  beforeWorkspaceDigest: Sha256;
  afterWorkspaceDigest: Sha256;
  affected: { created: string[]; updated: string[]; tombstoned: string[]; restored: string[] };
  inverseRetained: true;
  undoAvailable: true;
  message: string;
} & (
  | { beforeGraphDigest: Sha256; afterGraphDigest: Sha256 }
  | { beforeAnnotationDigest: Sha256; afterAnnotationDigest: Sha256 }
);

type BrowserPaperSnapshotV3 = {
  schemaVersion: 3;
  payloadChecksum: Sha256;
  payload: {
    schemaVersion: 3;
    kind: "paperpilot_browser_workspace";
    savedAt: string;
    paperIdentity: { paperRef: string; documentSha256: Sha256; pageCount: number };
    workspace: {
      current: BrowserWorkspaceStateV3;
      history: WorkspaceRevisionV1[];
      redoHistory: WorkspaceRevisionV1[];
      revisions: WorkspaceRevisionV1[];
    };
    requestResults: Array<[string, { commandDigest: Sha256; result: StoredMutationReceiptV1 | null }]>;
    events: ProvenanceEventV1[];
    savedExplanations: MentorExplanationV1[];
    presentation: { annotationOrder: string[] };
  };
};
```

- New saves use `paperpilot:webmcp:v3:<documentSha256>` and the closed `{ schemaVersion: 3, payloadChecksum, payload }` envelope. The current Graphology export may retain presentation coordinates, but patches and semantic digests exclude them; annotation order is also presentation-only.
- Load version 3 first. Only when that key is absent may the loader inspect `paperpilot:webmcp:v2:<documentSha256>`. A corrupt or incompatible version-3 copy is rejected without falling back to an older save.
- Version-2 migration validates the original checksum, current state, every retained before/after snapshot, Undo/Redo chain coherence, same-paper anchors, regenerated structural baseline, and cached receipts before deriving patches. It migrates the retained Undo/Redo steps in memory, preserves the original version-2 bytes, and writes only a separate version-3 copy on a subsequent save. Version 2 did not retain a complete patch ledger or original command reasons: migration reports that limitation and starts the new append-only ledger empty rather than inventing historical revisions.
- Preserve older version-1 candidate-only copies without hydration, deletion, or overwrite. If no version-3 or version-2 copy exists, show the explicit preserved-but-not-migrated notice; an explicit new save creates a separate version-3 copy.
- Bound the envelope to 4 MiB, patch revisions/history/redo to 200 entries each, replay keys to 200, and persisted recent events to 500. Reject oversized history rather than slicing or compacting it. The live reducer's reserved Undo-capacity rule still governs new edits; an optional save failure never changes the current graph.
- Before hydration, validate closed schemas, bounds, checksum, anchor digests, same-paper identity, regenerated structural nodes/edges/primary anchors, complete patch inverses, stack/ledger consistency, and all reconstructed semantic digest endpoints. Cached non-null receipts must match the closed original tool-result schema and their retained revision's identity, command digest, before/after digests, and affected entities. A forged or mismatched receipt rejects restore; a legacy receipt whose original revision is no longer recoverable becomes a reserved-key tombstone rather than an executable receipt.
- Same filename/different digest never restores.
- A different filename with identical bytes does restore. Validate the original envelope first, then normalize the filename-derived paper-root display title to the freshly loaded title and recompute current/history/ledger digest endpoints. Existing events remain historical facts; stored titles cannot replace trusted structure or source geometry. Since old success receipts name the previous digest basis, title normalization replaces them with `{ commandDigest, result: null }` tombstones and shows a reread/new-command-key notice. The old key cannot silently apply again.
- Hydrated canonical anchors and patch revisions remain deeply frozen. Active read receipts and unsaved staged explanations never survive reload; tools require fresh reads.
- On storage quota failure, keep session state, show **Not saved in this browser**, and avoid a false persistence event.
- The snapshot excludes PDF bytes. Reupload is required to reopen the document.

## Automatic Whole-Paper Structural Map

The initial map must not require the user to prompt the browser agent.

### Pipeline

1. Compute PDF SHA-256 and open with PDF.js.
2. Create a paper root node and provisional `contains` coverage edges.
3. Read `getOutline()` and resolve destinations to page indices using public PDF.js APIs.
4. Progressively call `getTextContent()` for every page within published limits. Retain bounded item geometry/index data in memory; do not create a visible transcript.
5. Identify candidate headings using document outline first, then conservative heuristics such as relative font height, line isolation, numbering patterns, and repetition suppression.
6. Label heuristic headings `document_structure`; never describe them as author-confirmed main ideas.
7. Create section nodes for trustworthy ranges. For any uncovered page, create a page or page-group node; visual-only/failed pages remain explicit.
8. Establish the entire initial structural map as the protected system baseline at revision 1. Human Undo/Redo reverses later reader/agent changes through the shared item-7 patch ledger; it must not erase generated page coverage or manufacture an initial agent revision.
9. Set coverage to `structural_ready` only when every admitted page is navigably structural or limited and no page failed. Use `structural_partial` when some pages remain failed and `failed` when no page is navigable; never call an all-failed index ready.
10. Allow the agent to enrich semantic nodes through later anchored reads/mutations. Update `semanticPages` only when a source-grounded semantic entity covers that section/page.

### Structural seed rules

- One `paper` node always exists.
- Prefer PDF outline boundaries over inferred headings.
- Fallback groups are deterministic contiguous ranges of at most ten pages.
- Avoid a noisy one-node-per-line graph.
- Automatically suggested semantic candidates may be refined through reversible commands. Generated paper/section nodes and structural containment edges are page-owned and read-only to agent mutations; agents may add separately grounded ideas and relationships. Visual node placement remains presentation-only for both layers.
- Remapping cannot overwrite a reader-edited label in the authenticated port without matching its entity revision.
- “Whole-paper” refers to coverage of all admitted pages, not universal semantic understanding.

## PDF Reader And Annotation Implementation

### Continuous document model

- The scrollport owns one ordered page stack for the full admitted document; ordinary wheel, touch, keyboard, and scrollbar movement crosses page boundaries without a page replacement action.
- Every page has a stable page container and accessible label even when its expensive canvas/text layers are temporarily unmounted.
- `IntersectionObserver` or an equivalent deterministic viewport calculation selects the active page using the page with the largest visible area, with distance from the scrollport center as the tie-breaker.
- Direct page entry is a locator: it scrolls the target page into view and updates the active-page indicator. It does not destroy other page containers or change semantic focus.
- Graph, annotation, and WebMCP source navigation use the same scroll-to-page/anchor path and await the mounted target before reporting navigation complete.
- Zoom preserves the logical page/anchor destination, recomputes placeholder and mounted-page geometry, and restores the nearest semantic scroll position without collapsing to page 1.

### Per-page layers

Each rendered page has, from back to front:

1. PDF.js canvas layer (`aria-hidden="true"`).
2. PDF.js positioned selectable text layer.
3. PaperPilot SVG/DOM annotation overlay, default `pointer-events: none`.
4. Temporary region-interaction layer active only during drawing.

The viewer uses public PDF.js APIs only. Private members such as `_pages` are prohibited.

### Text anchor construction

1. Listen for a user-completed selection inside one active page text-layer container.
2. Reject empty/cross-page/over-limit selection with accessible recovery text.
3. Clone the Range before the selection changes.
4. Capture `Range.getClientRects()` and filter empty/out-of-page rectangles.
5. Convert each rectangle corner from client coordinates to the page viewport and then to PDF points using the public viewport conversion API.
6. Preserve separate quads in reading/visual order.
7. Resolve intersected PDF.js text item references and obtain the exact selected string from the frozen Range.
8. Compute bounded prefix/suffix from adjacent indexed items without exposing a full page transcript.
9. Normalize canonical anchor JSON, compute quote/anchor digests, mint IDs/time, render overlay, and append `anchor_created`.

### Visual region construction

1. User activates region mode from an ordinary control.
2. Pointer drag or labeled numeric controls create the same normalized rectangle.
3. Clamp to the rendered page, require nonzero area, convert to PDF CropBox coordinates, and display a concise page/region summary.
4. For the public slice, compute a deterministic digest over the document/page/geometry/renderer recipe. Retained pixel-artifact custody is added in the authenticated port; do not claim byte-retained crop authority before that exists.
5. Cancel/Escape removes the temporary rectangle and restores initiating focus.
6. Confirm mints the immutable anchor and overlay.

### Overlay behavior

- Reproject canonical PDF-space quads/bounds whenever scale, rotation, or page viewport changes.
- Proposed/system/agent/human/tombstoned states use label/icon/pattern/line style as well as color.
- Interactive controls live in the annotation list/gutter markers so highlight paint does not block text selection.
- Selecting an annotation scrolls the page, draws a bounded focus treatment, updates graph focus, and announces page/source summary.
- Original PDF `ArrayBuffer`/`Uint8Array` is treated read-only and never passed to a writer.

## Graphology And Sigma Integration

This design deliberately follows Graphology's published [design choices](https://graphology.github.io/design-choices.html): keys are explicit rather than inferred from labels or objects; mixed/multi/directed behavior is selected deliberately; insertion order is never semantic identity; and renderer/layout attributes remain derived presentation data rather than graph truth. PaperPilot uses a directed multigraph because several typed claims may connect the same concepts in the same direction, while self-loops add no useful current-paper meaning and are rejected.

### Graphology responsibilities

- Maintain active plus tombstoned canonical topology.
- Validate explicit node/edge keys and multiedge operations.
- Compute degree/neighborhood data for bounded reads and UI summaries.
- Emit events used to update derived projections, never as the sole provenance record.
- Import/export only through PaperPilot canonical serializers.

### Sigma responsibilities

- Render active semantic nodes/edges only.
- Use derived labels, sizes, colors, shapes, and positions based on semantic attributes.
- Let the reader drag an active node and drop a linked annotation card onto the map. Pointer positions are converted from viewport to graph coordinates, clamped, and retained in a presentation-only layout map that is reapplied when the canonical Graphology instance is replaced.
- Keep drag/selection emphasis inside a Sigma `nodeReducer`; never write `highlighted`, selection, drag, or card-order fields into Graphology canonical attributes.
- Highlight affected revision entities, active source neighborhood, and focus.
- Support pointer exploration without being required for any task.
- Use deterministic initial seed positions; optional ForceAtlas2 settles without mutating semantic records.
- Respect reduced motion and stop layout work when hidden.

The item-6 presentation projection starts with up to 15 key nodes and offers an expanded view capped at 60 nodes and 120 directed edges. These are drawing limits, not semantic limits: visible/total counts stay explicit and the complete outline retains every node and relationship, including tombstoned audit records. Deterministic grouped positions, source-page ordering, full-detail labels, an origin-color legend, and a selection ring replace continuous force-layout motion. Selecting a previously hidden source reveals and frames it; unrelated edits retain the camera and surviving node positions. Source navigation is generation-guarded so an older asynchronous render cannot override a newer reader selection. Node origin colors do not change when a node is selected.

### Accessible graph outline

The DOM outline is a first-class alternate representation:

- searchable/filterable list grouped by main ideas, concepts, methods/results, prerequisites, and structure;
- node type, label, summary, authority, origin, source count, revision state, and tombstone state;
- incoming/outgoing relations with direction and evidence count;
- actions: focus source, inspect relations, rename/edit when human UI supports it, and tombstone/restore;
- arrangement actions: select a node for four-direction keyboard nudging, and reorder annotation cards with focus-preserving earlier/later controls;
- update announcements after agent mutation, rollback, Undo, and Redo;
- stable focus restoration when an entity disappears from the active projection.

The right rail exposes Map, Annotations, and Evidence tabs with roving keyboard focus. Graph details expose the complete label, summary, authority, origin, all issued source choices, and directed incoming/outgoing relationships. Expanded entity disclosures and focused controls survive unrelated graph replacement; a disabled arrangement control falls back to the graph heading. Search filters use the same literal label/summary, node-kind, and authority rules as `paperpilot.read_graph`. Arrangement has no canonical provenance event, entity revision, or semantic digest of its own.

## WebMCP Tool Contracts

The initial suite contains six short stable tool names. Gate 0 tests exact named-client registration, schema/result budgets, repeated-call behavior, abort semantics, and autonomous use. If six independent tools prove unreliable, combine schemas without removing the six capabilities.

### Common boundary

- Register in the authenticated/top-level public Reader only after hydration.
- Use one `AbortController`; partial registration aborts/disposes all tools.
- Keep tool names stable while trusted refs update for the current paper/focus/graph.
- With no active PDF, return a local structured `no_active_paper` result and create no false callback event.
- Validate unknown keys, strings, arrays, IDs, counts, and result bytes.
- Paper text, annotation labels, graph labels, and citations are untrusted content, never instructions.
- Use `textContent`/safe DOM construction for all returned strings.
- Tool results never contain PDF bytes, localStorage inventory, another paper, another tab, credentials, hidden prompts, or private reasoning.
- Exact release ceilings: 32 KiB canonical UTF-8 JSON input, 48 KiB UTF-8 serialized result, 50 operations per mutation batch, 600 active/tombstoned graph nodes, 1,200 graph edges, 800 annotations, 200 workspace revisions, 500 provenance events, 100 nodes/200 edges/40 anchor summaries per `read_graph` result, and a 4 MiB browser snapshot. The 48 KiB result ceiling preserves 8,255 bytes of headroom below the 57,407-byte result delivered intact by the named client during the 2026-08-30 contract spike. Strings use field-specific limits and no free-text field exceeds 4,096 Unicode scalar values. Closed parsing rejects unknown keys rather than trimming them.
- Every tool has a closed discriminated result union containing `schemaVersion`, `status`, and a structured safe error code. Gate 0 freezes the compiled JSON Schemas with `additionalProperties: false` at every object level and verifies the byte/count ceilings in the target client.

### `paperpilot.read_focus`

Purpose: return the active page-minted source anchor and a bounded related graph slice.

Input:

```json
{ "type": "object", "properties": {}, "additionalProperties": false }
```

Output:

```ts
type ReadFocusResultV1 =
  | { schemaVersion: 1; status: "no_active_focus"; paperRef: string }
  | {
      schemaVersion: 1;
      status: "ready";
      callbackReceiptId: string;
      paper: { paperRef: string; filename: string; documentSha256: Sha256; pageCount: number };
      focus: {
        anchorId: string;
        anchorDigest: Sha256;
        pageIndex: number;
        pageLabel: string;
        sourceKind: PaperAnchorV1["sourceKind"];
        authority: PaperAnchorV1["authority"];
        normalizedBounds: NormalizedRect[];
        exactText?: string;
        prefix?: string;
        suffix?: string;
        visualEvidence?: {
          mode: "client_visible_region" | "locator_only";
          visibleRegionId: string;
          captionText?: string;
          pixelUseVerified: boolean;
        };
      };
      graph: {
        workspaceRevision: number;
        workspaceDigest: Sha256;
        graphDigest: Sha256;
        relatedNodeKeys: string[];
        relatedEdgeKeys: string[];
      };
      responseRules: {
        audience: "undergraduate";
        separatePaperAndMentorKnowledge: true;
        citeAnchorIds: true;
      };
    };
```

The accepted exact quote is returned completely; the UI and callback share one limit. No `.slice()` truncation after freeze is allowed. A visual anchor exposes a stable, semantically named visible PDF region plus geometry/caption metadata, not image bytes. `client_visible_region` and any pixel-use claim are allowed only after the named-client controlled region A/B spike proves the client actually distinguishes visible pixels; otherwise the evidence mode is `locator_only` and the product must not claim visual understanding.

### `paperpilot.read_graph`

Input:

```ts
type ReadGraphInputV1 = {
  mode: "overview" | "focus" | "node" | "search";
  nodeKey?: string;
  query?: string;
  nodeKinds?: GraphNodeKind[];
  authorities?: GraphAuthority[];
  radius?: 0 | 1 | 2;
  includeTombstoned?: boolean;
  limit?: number;
};
```

Rules:

- `nodeKey` must be an issued key in the current graph.
- `search` requires a bounded plain-text `query`, performs deterministic Unicode-normalized case-insensitive matching over node labels and summaries only, and may apply bounded node-kind/authority filters. It never interprets graph labels as instructions or query syntax.
- `overview` returns paper root, visible main ideas/sections, coverage, and a bounded relation set.
- `focus` returns the active annotation neighborhood.
- `node` returns a bounded radius around one issued node.
- Server/page caps the result and sets `truncated: true` plus guidance; it never claims completeness after truncation.

Closed output is `no_active_paper`, `invalid_request`, `not_found`, or `ready`. `ready` includes current workspace revision/digest, graph and annotation sub-digests, coverage ledger, bounded canonical semantic attributes, source-anchor summaries, `truncated`, continuation guidance, and a callback receipt. Layout fields are omitted. No result exceeds 100 nodes, 200 edges, 40 anchor summaries, or the frozen 48 KiB serialized UTF-8 ceiling.

### `paperpilot.focus_source`

Input:

```ts
type FocusSourceInputV1 =
  | { target: "anchor"; anchorId: string }
  | { target: "node"; nodeKey: string }
  | { target: "edge"; edgeKey: string }
  | { target: "section"; nodeKey: string };
```

Behavior:

- Resolve only current-paper issued entities.
- Choose the primary source deterministically and expose alternatives.
- Move the central PDF, apply a temporary visible focus mark, synchronize graph/annotation selection, and announce the page/source.
- Record `source_focused` only after navigation completes.
- Return `focused`, the target, anchor/page, alternative count, and callback receipt.
- Closed result statuses are `focused`, `not_found`, `not_navigable`, `stale`, and `navigation_failed`; errors contain safe codes and no foreign-paper existence detail.
- This is UI navigation, not a semantic or PDF mutation.

### `paperpilot.stage_explain`

Model input:

```ts
type MentorExplanationV1 = {
  schemaVersion: 1;
  audience: "undergraduate";
  graphRevision: number;
  graphDigest: Sha256;
  sections: {
    quickTake: ClaimBlockV1[];
    paperFit: ClaimBlockV1[];
    prerequisites: ClaimBlockV1[];
    howItWorks: ClaimBlockV1[];
    paperEvidence: ClaimBlockV1[];
    relatedIdeas: ClaimBlockV1[];
    limitations: ClaimBlockV1[];
  };
  sourceCoverage: Array<{ anchorId: string; status: "used" | "insufficient"; explanation: string }>;
  graphCoverage: Array<{ entityKey: string; role: "explained" | "related" | "questioned" }>;
  externalCitations: ExternalCitationV1[];
};

type ExternalCitationV1 = {
  citationId: string;
  url: string;
  title: string;
  authors?: string[];
  year?: number;
  declaredBy: "agent";
  verification: "not_verified_by_paperpilot";
};

type ClaimBlockV1 = {
  text: string;
  authority:
    | "document_evidence" | "rendered_document_view"
    | "mentor_interpretation" | "mentor_background"
    | "external_source" | "uncertain";
  anchorIds: string[];
  graphEntityKeys: string[];
  citationIds: string[];
};
```

Validation:

- all seven sections present and bounded;
- every issued active anchor covered once or explicitly insufficient;
- document evidence requires exact-text anchors;
- rendered-view observation requires visual anchors;
- mentor background cannot cite a paper anchor as its authority;
- external-source blocks cite one or more declared citation IDs, never inherit paper-anchor authority, use only sanitized `https:` links, and remain visibly **Not verified by PaperPilot**; the public slice does not fetch or verify them;
- graph keys must exist in the graph revision read by the response;
- raw HTML/unknown keys reject the complete response;
- successful output says **Explanation ready. Nothing was saved.**

Explanation Save/Discard remains human UI behavior. It is separate from graph revisions.

### `paperpilot.apply_graph`

Input:

```ts
type ApplyGraphInputV1 = {
  schemaVersion: 1;
  idempotencyKey: string;
  baseWorkspaceRevision: number;
  baseWorkspaceDigest: Sha256;
  baseGraphDigest: Sha256;
  reason: string;
  operations: GraphCommandOperationV1[];
};
```

Trusted adapter supplies current `paperRef`, durable operation ID, callback receipt ID, actor/transport, origin, durable IDs, timestamps, and canonical command digest. The caller supplies the bounded `idempotencyKey` so an identical retry can replay. The model uses `clientRef` only to connect new entities within one atomic command; it never mints durable keys.

Output:

```ts
type ApplyGraphResultV1 = {
  schemaVersion: 1;
  status: "applied_reversible" | "conflict" | "rolled_back";
  callbackReceiptId: string;
  operationId: string;
  revisionId?: string;
  fromRevision: number;
  toRevision?: number;
  beforeWorkspaceDigest: Sha256;
  afterWorkspaceDigest?: Sha256;
  beforeGraphDigest: Sha256;
  afterGraphDigest?: Sha256;
  affected: { created: string[]; updated: string[]; tombstoned: string[]; restored: string[] };
  undoAvailable: boolean;
  message: string;
  currentRevision?: number;
};
```

Rules:

- one atomic bounded batch;
- stale workspace revision/digest or graph sub-digest conflicts with no mutation;
- every existing entity update requires expected entity revision;
- paper-grounded node/edge requires valid issued anchor IDs;
- tombstoning a node includes incident edges and exact inverse state;
- successful agent revision is immediately visible and marked `unreviewed`;
- result never says verified/approved/saved by the reader;
- no hard purge, cross-paper endpoint, layout change, PDF change, Undo, or Redo operation.

### `paperpilot.apply_annotation`

Input:

```ts
type ApplyAnnotationInputV1 = {
  schemaVersion: 1;
  idempotencyKey: string;
  baseWorkspaceRevision: number;
  baseWorkspaceDigest: Sha256;
  baseAnnotationDigest: Sha256;
  reason: string;
  operations: AnnotationCommandOperationV1[];
};
```

Rules:

- anchor must have been minted by current page code;
- no raw coordinates or document identity in model input;
- cannot alter anchor geometry/digest or overwrite a human body;
- link keys must be current-paper graph entities;
- an agent cannot supply or overwrite a human-authored annotation body;
- the closed result uses the same receipt/digest shape as `ApplyGraphResultV1`, additionally returning `beforeAnnotationDigest`/`afterAnnotationDigest`;
- a validated bounded batch applies immediately through the shared workspace history and returns an `applied_reversible` receipt;
- human Undo/Redo controls govern reversal.

### Deliberately absent tools

Never register:

- `save`, `accept`, `approve`, `verify`, or `mark_true`;
- `undo` or `redo`;
- hard purge/history deletion;
- annotated-PDF export or original-PDF replacement;
- arbitrary raw-coordinate annotation;
- cross-paper navigation/mutation;
- browser/storage inventory or external-network fetch.

## Core Data Flows

### 1. Upload → readable paper → structural map

```text
file input
  -> basic type/size check
  -> browser SHA-256
  -> PDF.js load and page-count/encryption validation
  -> PaperSession + paper root
  -> first-page render
  -> progressive outline/text/page index
  -> structural map system revision
  -> coverage ready/partial/failed
  -> versioned browser snapshot
```

Failure after first-page render preserves reading and reports the exact indexing/map limitation.

### 2. PDF selection → anchor → annotation

```text
user Range or region
  -> trusted page/geometry validation
  -> quote/region/source digest
  -> immutable PaperAnchor
  -> active Annotation
  -> overlay + annotation list
  -> anchor_created event
  -> current WebMCP focus
```

Changing the selection creates a new anchor. It never mutates a source already used by a callback/revision.

### 3. Agent explanation and graph enrichment

```text
user prompt in browser mentor
  -> read_focus callback
  -> read_graph callback
  -> stage_explain callback
  -> apply_graph callback
  -> validate on graph clone + compute inverse
  -> swap semantic graph / update Sigma + outline
  -> highlight affected entities + show Undo
  -> append callbacks/revision events
  -> snapshot
```

Order may differ. Each tool result and UI event truthfully reflects only its own callback. A graph patch does not validate an explanation, and a staged explanation does not imply a graph patch applied.

### 4. Graph → PDF navigation

```text
node/edge selection or focus_source callback
  -> validate current issued graph entity
  -> choose primary compatible anchor
  -> render/navigate page if needed
  -> scroll PDF region into view
  -> focus annotation + graph entity
  -> announce page/source
  -> source_focused event
```

### 5. Undo and Redo

```text
human Undo
  -> verify ledger/stack heads and recomputed current digests
  -> validate exact inverse records and topology on clone
  -> apply inverse as new human revision with relatedRevisionId
  -> update graph/annotation projections
  -> retain original patch revision and mutation event
  -> commit ledger/stacks/event atomically, then optional v3 save

human Redo
  -> verify non-diverged redo branch
  -> validate original forward patch on clone
  -> apply as new human revision with relatedRevisionId
  -> commit ledger/stacks/event atomically, then optional v3 save
```

### 6. Browser-local restore

```text
reupload PDF
  -> recompute digest
  -> load matching v3, or inspect v2 only if v3 is absent
  -> closed parse + checksum + bounds + patch/receipt/chain/invariant validation
  -> migrate validated v2 retained history without inventing a historical ledger
  -> normalize trusted display title and invalidate old-basis replay receipts if needed
  -> rebuild canonical Graphology graph
  -> derive Sigma/outline/overlay
  -> show Saved in this browser
```

The file must be reuploaded because PDF bytes are not persisted in snapshot JSON.

## Explanation And Evidence UI

### Mentor rail

- Active question/source summary.
- Quick take open by default.
- Six further semantic sections as actual headings/disclosures.
- Every paper claim has an anchor chip; every related idea has a graph chip.
- Anchor chip triggers the same trusted source focus behavior.
- Graph chip selects the same graph entity in Sigma and outline.
- Mentor text is immutable in a staged explanation; a separate human takeaway may be editable.
- Explanation Save/Discard remains human-only and does not determine whether graph revisions stay applied.

### Right rail

Tabs:

1. **Knowledge graph** — Sigma + controls + accessible outline toggle/detail.
2. **Evidence trail** — simple event sequence and expandable technical details.

Persistent rail header:

- coverage status;
- graph revision;
- **Undo** and **Redo**;
- last change summary and **Review changes**.

### Evidence truth language

Allowed:

- “PaperPilot observed `paperpilot.apply_graph` and applied revision 7.”
- “Undo revision 8 restored semantic graph digest ….”
- “This node is grounded in two source anchors from the uploaded PDF.”
- “This prerequisite is mentor background, not a claim that the paper states it.”

Forbidden:

- “The graph is verified/true.”
- “The agent understood the whole paper” when only structural or partial semantic coverage exists.
- “Tool registration proves the agent used the tool.”
- “The digest proves scientific correctness.”
- “PaperPilot modified/exported the PDF.”
- “Cross-paper knowledge is supported” before that feature exists.

## Accessibility Contract

### Semantic order and landmarks

DOM order:

1. Paper region;
2. Mentor region;
3. Knowledge graph region;
4. Evidence region.

CSS may place Mentor visually left. Each region has a heading and skip link.

### PDF and annotations

- Canvas is hidden from assistive technology; the positioned PDF text layer is the textual page representation.
- No duplicate full-page transcript exists visually or as a hidden duplicate.
- The page region announces page label, page count, text capability, zoom, and active annotation.
- Annotation list exposes source kind, page, quote/description, authority, origin, state, and graph links.
- Annotation cards expose a dedicated pointer drag grip plus **Move earlier** and **Move later** controls. Reordering changes only a module-owned presentation array; dropping a card on the map can place its current linked node but cannot edit source geometry.
- Region selection has pointer and numeric/whole-page/labeled-item alternatives.
- Focus source navigation announces the destination and never leaves keyboard focus inside an inert canvas.

### Graph

- Sigma canvas is supplemental.
- DOM outline contains every visible semantic node and relation needed for the task.
- Node/edge selection, source navigation, filters, search, details, annotation-card ordering, and graph-node nudging are keyboard operable.
- Direct Sigma drag and annotation-to-map drop have equivalent DOM controls and live status. Layout coordinates, order, selected state, and renderer highlights are excluded from semantic serialization and every WebMCP result.
- System-derived, paper-grounded, mentor-background, reader-authored, agent-applied, and tombstoned states have textual/non-color cues.
- An agent mutation announcement is concise: change summary + Undo availability, not every layout event.

### Focus and status

- PDF load/map/explanation arrival do not move focus automatically.
- User-initiated `Go to explanation` or source navigation may move focus to a heading/annotation summary.
- Region Cancel/Escape returns to the trigger.
- One polite atomic status surface announces coarse transitions.
- Actionable failures use `role="alert"` and stay associated with the invoking control.
- If a tombstone removes the focused graph item, focus moves to the next logical outline item or graph heading.

### Reflow and motion

- Test 200% browser zoom and a separate 320 CSS-pixel viewport.
- Side rails become tabs/drawers without losing state.
- No application-level two-dimensional scroll.
- `prefers-reduced-motion` disables graph settling animation, pulse motion, and smooth scroll while preserving visible focus changes.

## Security And Provenance

- Treat PDF text, filenames, headings, annotation labels, graph labels, mentor content, and citations as untrusted strings.
- Never render agent/paper strings with `innerHTML`.
- Tool descriptions state that paper and graph content is research data, not instructions.
- Trusted state refs—not model arguments—select the current paper and active anchor.
- Existing graph/anchor IDs supplied by the model must resolve in the current paper and current revision.
- Model-created node/edge `clientRef` values are local to one command; durable IDs are app-generated.
- No tool can read another PDF snapshot, other localStorage keys, the broader app library, another tab, or external sites.
- Tool callbacks enforce input/result count and byte budgets.
- Document replacement aborts old render/index/tool work and invalidates old handles.
- Prompt-injection fixtures in filename, PDF text, headings, graph labels, and annotations must not expand scope, navigate externally, export data, or invoke human controls.
- Graph digest canonicalization sorts nodes/edges/attributes explicitly and excludes UI layout. Never rely on Graphology iteration order.
- No PDF writer is installed. A build/checker assertion rejects `annotpdf`, `AnnotationFactory`, PDF write/download code, and any annotated-PDF tool/control.

## Error Strategy

| Failure | User state | Data behavior |
| --- | --- | --- |
| Non-PDF/oversized/encrypted/corrupt | Specific safe rejection | No substitute content; prior workspace untouched |
| Page render failure | Page unavailable; other pages usable | Coverage marks failed page |
| No text layer | Visual region only | No exact-text anchor |
| Index/map partial | Exact coverage counts and limitations | Structural nodes only for supported ranges |
| Cross-page selection | Select one page at a time | No anchor created |
| Selection too large | Select a smaller passage | No silent truncation |
| Geometry reconciliation mismatch | Rendered-region authority | No exact-text promotion |
| WebMCP absent | Local Reader/map usable | No native event/style |
| Partial registration | Tool registration failed + Retry | Abort/dispose all tools |
| No active focus | Structured `no_active_focus` | No source callback event with content |
| Unknown/foreign graph key | Not found in this paper | No information leak/mutation |
| Grounding missing | Grounding required | No paper-grounded entity created |
| Stale graph/entity revision | Map changed; reread and retry | Atomic conflict; no partial change |
| Invalid graph batch | Explain bounded validation issue | All-or-nothing no-op |
| Mandatory reducer/history/projection failure | Change rolled back | Transient transaction state restores semantics, ledgers, both stacks, replay cache, and events together; no retained success |
| Optional browser-snapshot quota/write failure | **Not saved in this browser** | Valid live revision remains; no false persistence event; byte-identical PDF reupload will not restore that unsaved revision |
| Explanation invalid | Mentor response could not be used | Graph remains independent; no partial explanation |
| Agent mutation after explanation | Distinct revision event | Never imply one transaction unless it was one |
| Undo invalidated | Cannot undo this change now | No partial inverse |
| Redo invalidated by new edit | Redo unavailable after newer change | Clear redo branch safely |
| Revision ledger at capacity | Browser workspace history is full | Reject new work without compaction; preserve reserved Undo capacity |
| Historical replay invalidated during recovery | Reread the workspace and use a new command key | Reserved-key tombstone prevents both duplicate application and a false success receipt |
| Missing source on restore | Source incomplete | Preserve graph/explanation for audit |
| Sigma/render failure | Graph visualization unavailable | Accessible outline stays functional |
| Corrupt local snapshot | Could not restore browser state | PDF opens with fresh map; no false restore event |

## Authenticated Service Port

After the public slice passes, port the same contracts to the live service.

### Durable models

Recommended normalized records:

- `PaperSourceAnchor`
- `PaperAnnotation`
- `PaperConceptGraph`
- `PaperConceptNode`
- `PaperConceptEdge`
- `PaperConceptGrounding`
- `PaperGraphRevision`
- `PaperMentorExplanation`
- `PaperMentorActivityEvent`

Required durable invariants:

- tenant-qualified keys and actor privacy;
- document generation/digest binding;
- exact anchors reconcile to admitted extraction records;
- visual anchors bind retained render artifacts before byte-custody claims;
- paper-grounded entities require compatible source records;
- revision command/inverse append atomically with graph snapshot increment;
- stale revision conflict and permanent idempotency;
- logical tombstone, no agent hard purge;
- Undo/Redo are human commands stored as compensating revisions;
- Supabase is the only database authority and no local fallback exists.

### API direction

```text
GET  /papers/:paperId/graph
POST /papers/:paperId/graph/revisions
POST /papers/:paperId/graph/revisions/:revisionId/undo
POST /papers/:paperId/graph/revisions/:revisionId/redo
GET  /papers/:paperId/anchors/:anchorId
POST /papers/:paperId/annotations/revisions
POST /papers/:paperId/mentor/explanations
GET  /papers/:paperId/activity
```

The browser adapter can swap local command/persistence services for HTTP services without changing model-facing tool schemas. The server injects actor, paper, operation IDs, timestamps, and database revision authority.

## Verification Plan

### Contract and unit tests

- closed parsing and unknown-key rejection for every tool/result/snapshot;
- SHA-256, ID, string, array, and byte/count limits;
- Graphology type/key/multiedge/self-loop rules;
- grounding and authority compatibility;
- same-paper enforcement and foreign ID rejection;
- canonical graph digest stability independent of insertion and layout order;
- apply → Undo → Redo semantic digest equivalence;
- node tombstone includes/restores incident edges;
- stale graph/entity revision and duplicate callback/idempotency behavior;
- divergent history clears Redo;
- persistence failure rollback;
- explanation source/graph coverage and authority validation;
- no Save/Undo/Redo/export/hard-purge tool definitions;
- no `annotpdf`/`AnnotationFactory` import.

### PDF geometry/index tests

- single-line, multiline, multicolumn, ligature, and mathematical selections;
- same-page multiple text spans and cross-page rejection;
- rotated pages and non-default CropBox/MediaBox;
- zoom, fit-width, resize, DPR, and rerender alignment;
- page 2+ selection;
- region selection on image-only pages;
- outline present/absent and heading heuristic uncertainty;
- short, medium, figure-heavy, and weak-text PDFs;
- progressive index cancellation and page failures;
- no persistent transcript markup.

### Browser tests

- loaded workspace grid and paper-dominant center;
- no transcript textarea/panel/text;
- continuous cross-page scroll, active-page calculation, page-locator scrolling, zoom, and fit-width;
- direct text highlight and region annotation;
- structural map covers every page with honest states;
- Sigma graph and equivalent DOM outline;
- direct node drag, annotation-card-to-map drop, card reorder, keyboard nudge/reorder equivalents, and focus restoration;
- invariant revision/digest/source geometry plus a successful `read_graph` and semantic WebMCP mutation after presentation rearrangement;
- node → source and annotation → graph navigation;
- controlled WebMCP adapter read/graph/focus/stage/apply flows;
- agent graph add/update/tombstone;
- Undo/Redo and evidence entries;
- invalid/stale/rollback behavior;
- same filename/different digest local restore;
- WebMCP unavailable/partial registration;
- keyboard-only, 200%, 320px, and reduced-motion scenarios.

### Manual supported-client tests

Record exact client/app/browser/model/OS/public URL/commit/time, then run:

1. registration of the final tool suite;
2. `read_focus` on a spatial text anchor;
3. `read_graph` on the automatic map;
4. `focus_source` from a graph node;
5. `stage_explain` with source and graph links;
6. `apply_graph` add/update/tombstone on a previously unseen PDF;
7. human Undo and Redo with matching graph digests/events;
8. `apply_annotation` on an issued anchor;
9. figure/region explanation and graph grounding;
10. stale revision, invalid grounding, and read-without-stage failures;
11. WebMCP-unavailable/registration failure without native styling;
12. prompt-injection PDF/filename/graph-label test with no scope expansion.

Tool registration proves only availability. Each claim requires the matching callback receipt and visible application effect.

### Accessibility manual proof

- Keyboard-only complete flow.
- NVDA on Windows: paper controls, annotation list, graph outline, source navigation, mutation announcement, Undo/Redo, explanation, evidence.
- 200% zoom and 320 CSS-pixel reflow.
- Reduced motion.
- Exact announcement/focus outcomes after PDF load, map ready, anchor created, agent mutation, rollback, Undo, Redo, source focus, explanation ready, and errors.

### Cross-PDF matrix

| PDF class | Required proof |
| --- | --- |
| Born-digital A | multi-page spatial text, structural map, WebMCP graph/explain/mutation, Undo/Redo |
| Unrelated born-digital B | same flow with no code/config change and independent state |
| Figure-rich | visual region, accessible description, grounded graph node, source reopen |
| Weak-text/scanned | page/region anchors and honest structural/limited coverage |
| Unsupported/encrypted/corrupt | explicit rejection and no substituted content |

### Required commands after implementation

```text
npm ci
npm run build:webmcp
npm run test:webmcp
npm run lint
npm run typecheck
npm test
npm run build
npm run devpost:check
```

The public release must also be loaded from the deployed HTTPS URL in a clean context. Automated adapter tests do not replace real named-client callback proof.

## Deployment Strategy

### Public vertical slice

- GitHub Pages remains the first release path because the URL already works anonymously.
- Workflow runs `npm ci`, `npm run build:webmcp`, automated WebMCP tests, and uploads `public/`.
- Bundle Graphology/Sigma/PDF.js from the lockfile; use a same-origin PDF.js worker.
- No environment secret or backend endpoint enters the bundle.
- Preserve the existing live proof document as historical; create a new redesign proof record tied to the new commit/client tuple.

### Authenticated service

- Vercel hosts Next.js Functions/WebMCP page.
- Supabase provides PostgreSQL/private Storage only.
- Workflow/Sandbox handles bounded PDF admission asynchronously.
- Browser transfers PDF/artifact bytes through exact short-lived object capabilities.
- This path is built after the public interaction is proven and cannot block the first graph/annotation demo.

## Demo And Submission Flow

1. Open the anonymous public URL.
2. Upload a previously unseen multi-page paper.
3. Show the actual PDF as a continuous paper in the center and the automatic whole-paper structural map on the right—no transcript or page carousel.
4. Highlight a difficult sentence on the page.
5. Ask the browser mentor to explain it and add it to the map.
6. Show real `read_focus`, `read_graph`, `stage_explain`, and `apply_graph` callbacks.
7. Read the mentor explanation and show its paper/graph links.
8. Select the new graph node and jump back to the exact PDF annotation.
9. Ask the agent to remove or change the node; show the visible reversible revision.
10. Click Undo, then Redo, and open the evidence trail with before/after digests.
11. Select a figure/region and show the same anchored interaction/accessibility model.
12. Close on the boundaries: browser-local prototype, immutable original PDF, no PDF export, no cross-paper UI, no claim of scientific verification.

### Submission claim after all gates pass

> PaperPilot keeps the real paper at the center of an agentic WebMCP workspace. It automatically maps the paper's structure, lets readers anchor questions directly to text and figures, and gives the browser mentor typed tools to read, navigate, explain, and evolve a source-grounded knowledge graph. Agent graph edits apply immediately but remain fully visible and reversible with human Undo/Redo. Every concept can lead back to its page evidence; callback and revision receipts show what happened without claiming hidden reasoning or scientific truth.

## Build Handoff

Build in this order:

1. freeze tool/contracts/dependency decisions;
2. create reproducible modular public bundle;
3. center the multi-page PDF and remove the transcript;
4. implement spatial anchors/overlay and accessible annotation list;
5. index the whole paper and create the structural map;
6. add Graphology/Sigma and graph ↔ PDF navigation;
7. add the atomic workspace reducer, graph/annotation inverses, and human Undo/Redo;
8. integrate/register the richer WebMCP read/navigation/stage/mutation tools against that reducer;
9. integrate mentor explanations and graph-aware evidence;
10. complete accessibility/cross-PDF/public proof;
11. port proven contracts to the authenticated service later.

No infrastructure or integration task should displace the public graph/annotation/WebMCP proof unless it directly blocks that flow.
