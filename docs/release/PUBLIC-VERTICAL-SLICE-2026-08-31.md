# PaperPilot Public Vertical Slice — 2026-08-31

## Release

- **Live URL:** https://patrickjcraig.github.io/PaperPilot/webmcp/
- **Repository:** https://github.com/patrickjcraig/PaperPilot
- **Release commit:** `0fc61fe8e23666161eabf84143fb87c8d28f653c`
- **Feature commit:** `09d4a038017b73406d278b11e361a1f5f7e7992c`
- **Provenance-restore fix:** `a90e79e4889c0a18e0c6457304b27cd9a9b52439`
- **GitHub Pages run:** https://github.com/patrickjcraig/PaperPilot/actions/runs/33369046611
- **Client tuple:** Codex In-app Browser (client version not surfaced), Windows, public GitHub Pages origin, 2026-08-31.

## Shipped reader journey

1. A reader opens the public page and explicitly chooses the **Attention Is All You Need** demo or a local born-digital PDF.
2. The browser fingerprints the exact bytes, renders one continuous PDF.js paper in the dominant center column, and keeps the PDF bytes out of browser storage and the deployment artifact.
3. PaperPilot indexes all pages and creates an explicitly unreviewed, page-grounded critical-idea map in Graphology, rendered through Sigma and a keyboard-accessible outline.
4. Six document-scoped WebMCP tools let a browser agent read the active source, read/search the graph, focus issued evidence, stage an explanation, and apply reversible graph or annotation commands.
5. An agent change remains linked to an exact paper anchor and produces visible audit events. Only the human UI can Undo, Redo, save or discard an explanation, or opt into browser-local recovery.
6. A seven-part undergraduate mentor note separates paper evidence from mentor synthesis and can be saved with a separately labeled reader takeaway.
7. An explicit browser-local save stores only the exact paper identity, canonical graph/annotation state, bounded history/audit events, presentation layout, and saved mentor notes. It never stores the PDF or rewrites/exports it.

## Public agent proof

The live page registered all six tools and a real browser agent invoked every capability:

- `paperpilot.read_focus` returned exact page-owned text and anchor digest (`callback:20f0ee61-3ebd-4bc2-99ac-3ac42d12bbe3` for the final page-4 source).
- `paperpilot.read_graph` returned the bounded current graph and semantic digests (`callback:b41c1d5a-1666-4b33-87f8-5c084d4a2ee3`).
- `paperpilot.focus_source` navigated to the issued Scaled Dot-Product Attention source on page 4 (`callback:6e1e2aed-eea7-426b-8ce0-3c572bfe7dcf`).
- `paperpilot.apply_graph` corrected the concept node to cite that exact source and advanced revision 3→4 reversibly (`callback:b8fabb29-67d4-467b-b148-cff9f3b098ee`).
- `paperpilot.apply_annotation` superseded the initial question with an in-app question on the correct source and advanced revision 4→5 reversibly (`callback:cacc5f24-6f7c-4274-a993-f26ffd795a27`).
- `paperpilot.stage_explain` first rejected an incompatible visual-evidence claim, then staged the source-grounded seven-part explanation with `visualEvidenceMode: not_applicable` (`callback:e46b4591-8a81-4f6b-8f05-102945633eb2`).

The saved public workspace was reopened from the exact paper fingerprint. It restored the graph node **Scaling attention scores keeps softmax gradients useful**, the annotation **Mentor question — why does scaling by √dₖ keep gradients useful?**, the saved mentor note and reader takeaway, prior WebMCP event history, and the reversible workspace. Human Undo advanced revision 5→6; Human Redo advanced 6→7 and reproduced the saved semantic digest. Browser diagnostics were empty.

## Verification

- `npm run lint -- --quiet` — pass.
- `npm run typecheck` — pass.
- `npm test` — **701/701** pass.
- `npm run test:webmcp:contracts` — **79/79** pass, including ten browser-snapshot tests.
- `npm run test:webmcp:pages` — **1/1** pass.
- `npm run build` — production Next.js build pass.
- `npm run webmcp:pages:build` — pass; **212 files**, **0 PDFs**.
- `git diff --check` — pass for the release changes.
- Final GitHub Pages deployment `33369046611` — success in 37 seconds.
- Final live reload — 6/6 tools, 15/15 pages, 10 critical candidates, revision 7 restored, saved explanation restored, graph and annotation restored, prior WebMCP event types visible, zero warning/error logs.

## Honest first-release limits

- Automatic semantic candidates are extractive orientation aids, not scientific verification.
- This proof is fully exercised with one public demo paper; broad two-paper, rotated-page, 200% zoom, figure-region, and screen-reader walkthrough coverage remains open in the formal checklist.
- Arbitrary born-digital PDFs are accepted, but OCR for scanned PDFs is not included.
- Recovery is private to the current browser and exact PDF fingerprint. Authenticated Supabase persistence, Zotero, crawling, collaboration, and cross-paper graphs remain later serverless work.
- A same-day modular follow-up closed checklist item 2: `app.mjs` remains the browser composition root, while mentor review, activity/provenance, callback observation, and accessible graph/annotation projections are strict JSDoc-typed, browser-independent modules. The Pages packager now proves two byte-identical clean outputs and rejects PDFs, source maps, and credential-shaped artifacts.
