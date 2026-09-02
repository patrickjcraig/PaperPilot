# PaperPilot demo video plan

Target length: **2 minutes 30 seconds**. Record the public HTTPS six-tool reader in a WebMCP-capable browser, not localhost. Keep the actual PDF dominant and legible; the graph, callback activity, and evidence should support the paper rather than replace it.

This is a recording plan, not a completed video. The reproduced technical checkpoint is source `673726c0f00756bdbfa57a4c1c72ab3d61062d4a`, runtime fingerprint `d66782d3e9a1d6c723f93374b3d622268801a489337245218f17cace2c1b7ace`, deployed by [Pages run 33640830540](https://github.com/patrickjcraig/PaperPilot/actions/runs/33640830540). Its fresh public interaction matrix passed, including source navigation after Undo/Redo; automated regressions also cover first/last-word reads with empty surrounding quote context. Open the [public reader](https://patrickjcraig.github.io/PaperPilot/webmcp/?release=673726c); the query bypasses a stale page cache, but does not pin GitHub Pages to an immutable deployment.

All six native callbacks were observed on both public Attention (15 pages) and GW150914 (16 pages) at this checkpoint, with exact-source graph/annotation edits, exact three-digest Undo/Redo round-trips, seven-claim explanations staged unsaved and source reopening. The four-page weak-text fixture kept three explicit limited-page warnings and passed annotation-to-node search/focus plus a visible page-3 return after Undo/Redo. Foreign-source rejection and non-PDF rejection followed by retry also passed; all three PDF runs had no browser warnings/errors. See the [release proof index](release/PUBLIC-RELEASE-PROOF-2026-09-02.md) for the receipts and current screenshots. The [hardening record at `274c739`](release/RECOVERY-ACCESSIBILITY-HARDENING-2026-09-02.md) and old two-tool recording remain historical. These are known fixtures tested through the shared arbitrary-PDF pipeline, not newly unseen papers. Final recording, captions, public video URL, human accessibility/access review and submission remain pending.

## Narrative and shot list

| Time | Shot | Narration / proof |
| --- | --- | --- |
| 0:00–0:12 | Open on the research mentor left, real paper centered, and Graph/Evidence right. | “Scientific papers assume vocabulary and context that first-time readers have not built yet. PaperPilot lets you ask line by line without losing the evidence.” |
| 0:12–0:32 | Load the optional Attention demo or upload an admitted born-digital PDF. Show continuous pages and the automatic whole-paper structural map. | Name the paper and state the honest boundary: the map covers the paper's structure; it does not claim complete semantic understanding. Point out that there is no transcript pane. Do not call the rehearsed demo unseen. |
| 0:32–0:50 | Highlight a difficult sentence directly on the PDF. Show its spatial annotation and matching graph focus. | “This page-minted anchor—not an extracted side transcript—is the source the mentor can read.” |
| 0:50–1:15 | Ask the browser mentor to explain and map it. Show actual `read_focus`, `read_graph`, `stage_explain`, and `apply_graph` callback receipts. | Explain that registration is only availability; visible receipts prove the callbacks PaperPilot observed. |
| 1:15–1:35 | Read the graph-aware explanation and show the new grounded concept/main-idea node. Briefly show the human Save/Discard choice. | Separate exact paper support, mentor interpretation/background, external citations and uncertainty. Saving a note is a human decision, separate from reversible graph edits. |
| 1:35–1:50 | Select the new node and show `focus_source` return to the exact PDF annotation. Briefly reveal the accessible graph outline. | “Every grounded concept can take the reader back to the page evidence.” |
| 1:50–2:08 | Ask the agent to change or remove the node. Show the revision/tombstone, then click human-only **Undo** and **Redo**. | “The agent can maintain the map after trusted validation. The reader keeps the soft check and history.” |
| 2:08–2:20 | Select a figure region and show its page-bound annotation/graph linkage plus `apply_annotation` receipt. | State the current mode: `locator_only`, `pixelUseVerified: false`. A reader-provided description and mentor interpretation are not proof that the agent inspected the figure pixels. |
| 2:20–2:30 | Open Evidence. Show source anchor, callback, workspace revision, trusted inverse, Undo/Redo, public repo, and MIT license. | Close: “PaperPilot helps readers learn from the paper while keeping the original PDF immutable and the provenance inspectable.” |

## Recording checklist

- Record the public URL, immutable source commit, runtime fingerprint, Pages run, date and tested client. The current proof used Codex In-app Browser on Windows; unavailable browser/model build strings must not be invented. Verify the deployed fingerprint before recording if Pages has advanced.
- Use a scientific PDF through the shared parsing/anchoring pipeline, not paper-specific product logic. Attention is a recognizable rehearsed demo, not an unseen-paper test. Keep a second unrelated paper and a weak-text fixture in the separate release matrix; label each result's actual origin and date.
- Capture the browser's WebMCP/site-tools indicator and PaperPilot's matching receipts for `paperpilot.read_focus`, `paperpilot.read_graph`, `paperpilot.focus_source`, `paperpilot.stage_explain`, `paperpilot.apply_graph` and `paperpilot.apply_annotation`.
- Make the PDF text, spatial highlight, graph labels, mutation notice, and Undo/Redo state legible at final video resolution.
- Show the keyboard-operable graph outline independent of Sigma. Automated focus/name checks and native keyboard use are technical evidence, not completed human screen-reader acceptance. Actual screen-reader, literal 200% zoom, forced-colors/reduced-motion and another-machine inspection remain separate pending checks.
- Keep the PDF free of private or unpublished material.
- Include accurate captions and explanatory voice-over audio.
- State that automatic mapping is structural coverage, not proof the agent understood every page.
- State that graph/annotation mutation is atomic and reversible; Undo/Redo are human UI controls, not agent tools.
- State that the original PDF is not modified and PaperPilot exposes no annotated-PDF export.
- If recovery is shown, explicitly enable the opt-in browser copy: it is limited to 4 MiB, keyed by the PDF's SHA-256, and contains workspace records, not PDF bytes. Restoring requires the identical PDF bytes in the same browser storage; no account, local database or server persistence is used by this reader.
- Do not claim universal PDF support, perfect OCR/vision, scientific truth, citation verification, hidden model reasoning, or hallucination prevention.
- End with the live URL, public GitHub repository, MIT license, and the next later slice: porting proven contracts into the authenticated serverless Supabase/Vercel service.

Before capture, run `npm run devpost:check -- --phase technical` against the current release evidence. This technical gate is separate from `npm run devpost:check`, which must remain red until the human checks, video URL, handoff, submission review and freeze evidence are actually complete. Follow the [judge guide](DEVPOST-JUDGE-GUIDE.md) for the reproducible packaged-reader build commands and interaction sequence.

## Backup cut

If the browser agent is slow, keep continuous capture and trim only dead time. Do not replace native callbacks with a mock or splice callbacks from a different release/PDF. The current figure mode is locator-only: keep the page anchor, reader description and lack of verified pixel use visible. If the six-tool public release is unavailable, resolve that technical gate before recording; the historical two-tool baseline is not the current product. Reader-only use without WebMCP must not be edited to look like an observed agent run.
