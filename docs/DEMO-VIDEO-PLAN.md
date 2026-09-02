# PaperPilot demo video plan

Target length: **2 minutes 30 seconds**. Record the public HTTPS six-tool reader in a WebMCP-capable browser, not localhost. Keep the actual PDF dominant and legible; the graph, callback activity, and evidence should support the paper rather than replace it.

**Finished cut:** [Watch on YouTube](https://youtu.be/EDpbN35rDfQ), [download the 2:30 source MP4](demo/PaperPilot-WebMCP-demo.mp4), [SRT captions](demo/PaperPilot-WebMCP-demo.srt), [media verification](demo/recording-verification.json). It records public source `9dd6bd5` with the annotation form above the PDF, 447 real tab screenshots and 13 successful native callbacks. Synthetic narration and compressed timing are disclosed throughout. See the [actual recording evidence](release/DEMO-RECORDING-2026-09-02.md) for exact scope and limitations. The [current-release cross-PDF proof refresh](release/PUBLIC-RELEASE-REFRESH-2026-09-02.md) is complete and technical readiness passes 63/63. [YouTube access, duration and audio verification](release/YOUTUBE-VERIFICATION-2026-09-02.md) is complete. The owner approved a disclosed hackathon-only deferral of unfinished human checks, and the [freeze procedure](release/HACKATHON-FREEZE-PLAN-2026-09-02.md) is prepared; Devpost posting still requires final confirmation.

The earlier broader technical checkpoint was source `673726c0f00756bdbfa57a4c1c72ab3d61062d4a`, runtime fingerprint `d66782d3e9a1d6c723f93374b3d622268801a489337245218f17cace2c1b7ace`, deployed by [Pages run 33640830540](https://github.com/patrickjcraig/PaperPilot/actions/runs/33640830540). Its public interaction matrix passed, including source navigation after Undo/Redo; automated regressions also cover first/last-word reads with empty surrounding quote context. Open the [current public reader](https://patrickjcraig.github.io/PaperPilot/webmcp/?release=9dd6bd5); the query bypasses a stale page cache, but does not pin GitHub Pages to an immutable deployment.

All six native callbacks were observed on both public Attention (15 pages) and GW150914 (16 pages) at that earlier checkpoint, with exact-source graph/annotation edits, exact three-digest Undo/Redo round-trips, seven-claim explanations staged unsaved and source reopening. The four-page weak-text fixture kept three explicit limited-page warnings and passed annotation-to-node search/focus plus a visible page-3 return after Undo/Redo. Foreign-source rejection and non-PDF rejection followed by retry also passed; all three PDF runs had no browser warnings/errors. See the [historical release proof index](release/PUBLIC-RELEASE-PROOF-2026-09-02.md) for its receipts and screenshots. The [hardening record at `274c739`](release/RECOVERY-ACCESSIBILITY-HARDENING-2026-09-02.md) and old two-tool recording remain historical. These are known fixtures tested through the shared arbitrary-PDF pipeline, not newly unseen papers. Current evidence and remaining human/submission work are identified above.

## Narrative and shot list

Use the [263-word narration and single agent prompt](DEMO-NARRATION.md) for the recording take. The [September 2 reader-originated rehearsal](release/DEMO-REHEARSAL-2026-09-02.md) exercised this sequence on the public artifact: a real PDF text selection, all six fresh native tools, two agent edits, exact three-digest Undo/Redo, source return, and a separately described whole-page figure region. This was agent-operated UI rehearsal, not a captured video or human accessibility acceptance. The script below now follows that causal order.

| Time | Shot | Narration / proof |
| --- | --- | --- |
| 0:00–0:15 | Open the explicit live-demo button; keep the real paper centered, mentor left and graph/evidence right. | Introduce the first-time reader's question and source-linked learning map. |
| 0:15–0:33 | Show Attention v7, continuous pages, structural coverage and the complete graph outline. | Label it a rehearsed paper. Structural navigation is not complete semantic understanding. |
| 0:33–0:53 | Select the page-4 prose directly in the PDF, label it **Why scale attention scores?**, and choose **Add highlight to the graph**. | The reader creates the annotation and issued source before the agent edits. Select clean prose before the stacked formula; verify the preview before committing. |
| 0:53–1:15 | Run the browser-agent prompt with fresh focus/graph reads, a linked concept/relation, a separate question annotation, source navigation and explanation staging. | Show actual receipts for all six tools. `apply_annotation` belongs to this agent step, not the later reader-only figure action. Trim waiting, not the sequence of causes and effects. |
| 1:15–1:37 | Show the seven-part draft and authority labels; move away, then return through the new node to the exact source. | Distinguish paper evidence, interpretation, background and uncertainty. **Save mentor note** and **Discard draft** remain human choices; leave this take unsaved. |
| 1:37–1:55 | Use **Undo** twice, then **Redo** twice for the two agent batches. | The original reader annotation survives. Fresh native reads compare workspace, graph and annotation digests; the revision disclosure alone does not display all three. Follow the actual number of batches in the take. |
| 1:55–2:09.5 | Create a reader-described figure region, or use the rehearsed **Use whole page** alternative on page 3. | A whole-page source is not a tight crop or complete diagram description. Keep `locator_only` and `pixelUseVerified: false` explicit. |
| 2:09.5–2:30 | Open Evidence and close on the public URL and repository. | Provenance records what happened, not scientific truth. Browser-local prototype, original PDF unchanged, no PDF export; human accessibility review pending. The repository contains the MIT license; the final take does not navigate away to its file. |

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
