# PaperPilot public WebMCP source

This directory is the authored source of the public `/webmcp/` vertical slice.
The repository-local `.paperpilot-pages/` directory is generated output and is
never hand-edited. `npm run webmcp:pages:build` deletes only that generated
directory and reconstructs it from this source plus lockfile-pinned vendor
assets.

## Module boundaries

| Module | Authority |
| --- | --- |
| `contracts.mjs` | Canonical document, anchor, graph, annotation, command, revision, digest, Undo/Redo, and six-tool registration contracts. |
| `pdf-viewer.mjs` | PDF.js lifecycle, continuous pages, text indexes, viewport/PDF transforms, page-owned selection geometry, and overlay targets. |
| `paper-analysis.mjs` | Browser-independent whole-paper indexing and explicitly unreviewed critical-idea candidates. |
| `presentation-layout.mjs` | Presentation-only graph positions and annotation-card order; never semantic state. |
| `browser-snapshot.mjs` | Bounded, checksummed, exact-PDF browser recovery with PDF bytes excluded. |
| `mentor-review.mjs` | Typed seven-section mentor view model and human-only Save/Discard decisions. |
| `webmcp-observer.mjs` | Typed callback instrumentation and page-issued provenance targeting; no model-reasoning claim. |
| `activity-ledger.mjs` | Typed evidence-event creation, restore merge, bounds, and reader-facing formatting. |
| `accessibility-projection.mjs` | Typed Graphology/annotation facts shared by the accessible DOM outline and cards, with layout and geometry excluded. |
| `app.mjs` | Browser composition root: DOM wiring, PDF/graph renderer orchestration, and adapters between the pure modules. |

The strict JSDoc-typed seam modules are checked by `npm run typecheck:webmcp`.
All domain modules run in Node tests without a browser-global fixture. Browser
effects remain in the composition root and receive page-owned canonical facts;
untrusted WebMCP input never supplies paper identity or raw geometry.

## Reproduce the Pages artifact

```powershell
npm ci --ignore-scripts
npm run typecheck:webmcp
npm run test:webmcp:contracts
npm run test:webmcp:pages
npm run webmcp:pages:build
$env:PAPERPILOT_WEBMCP_SPIKE_PORT = "4182"
npm run webmcp:pages:serve
```

Open `http://127.0.0.1:4182/webmcp/`. Add `?fixture` only when intentionally
running the ignored, exact-byte local paper fixture; the packaged public path
always starts at browser-local paper intake.

The Pages test packages twice and compares path, byte length, and SHA-256 for
every output file. It also rejects PDFs, source maps, environment files,
private-key containers, and common credential shapes. The original two-tool
release is preserved separately as **prior release evidence** in
`docs/release/WEBMCP-LIVE-PROOF.md`.
