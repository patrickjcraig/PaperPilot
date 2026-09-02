# PaperPilot — demo narration and production notes

The [finished source demo](demo/PaperPilot-WebMCP-demo.mp4) runs **2:30**, with synthetic Microsoft Zira Desktop narration and [SRT captions](demo/PaperPilot-WebMCP-demo.srt). The [public YouTube upload](https://youtu.be/EDpbN35rDfQ) now has [verified access, duration and participant-confirmed audio](release/YOUTUBE-VERIFICATION-2026-09-02.md). The eight voice-over blocks below contain **263 spoken words**; directions, prompts and captions are not spoken. The real captured session was edited with timing compression disclosed throughout. This is not human application accessibility acceptance or an item-12 submission handoff.

The [public reader](https://patrickjcraig.github.io/PaperPilot/webmcp/?release=9dd6bd5) was captured in a WebMCP-capable browser at source `9dd6bd561b3fc628907e797442a252b5a8012379`, fingerprint `a0d5f6636b0eace96e04011526450f0942a6a797ee5d8fafda9faf2bbf8b7167`, after successful [Pages run 33647998514](https://github.com/patrickjcraig/PaperPilot/actions/runs/33647998514). The release query is not an immutable deployment pin. See the [recording evidence](release/DEMO-RECORDING-2026-09-02.md), [video plan](DEMO-VIDEO-PLAN.md), and [judge guide](DEVPOST-JUDGE-GUIDE.md). The broader cross-PDF proof at `673726c` remains historical and is not silently renewed by this recording. A [separate current-release refresh](release/PUBLIC-RELEASE-REFRESH-2026-09-02.md) subsequently verified GW150914, weak text and invalid input; those actions are not part of this video or its narration.

**Actual take:** 447 real tab screenshots, 13 successful native callbacks covering all six tools, exact Undo/Redo digests, and a locator-only whole-page region. The page-4 selection ended at “dot product,” before the final letter; the mentor disclosed this incomplete boundary. The footage uses the map canvas rather than an expanded complete outline, and source return is shown without the optional away-and-back detour. Picture directions below remain a reusable shot guide; the dated recording record is authoritative about what this take actually showed.

## 0:00–0:15 — The reading problem

**Picture:** Start with the live source gate and pointer over **Open the live demo**; click once. Keep the actual PDF dominant when it appears. The mentor sits left and the map/evidence rail right. Do not start with callback JSON filling the screen.

> Your first hard paper can feel like a wall of unfamiliar words. PaperPilot keeps the paper in view and turns your questions into a source-linked learning map.

## 0:15–0:33 — Real paper, honest map

**Picture:** Show the Attention title and continuous scroll across pages, then the structural coverage count and **Map**. Briefly show **Complete graph outline**; avoid presenting a dense canvas as complete semantic understanding. On-screen caption: **Rehearsed Attention v7 demo · shared PDF pipeline**.

> This is our rehearsed Attention Is All You Need demo, not an unseen-paper test. The real PDF scrolls continuously. Its automatic map covers document structure; it does not mean an agent understood every page.

## 0:33–0:53 — The reader creates the source

**Picture:** Use **Jump to page** to reach page 4. With **Highlight text** active, select the clean prose **To counteract this effect, we scale the dot products** directly on the PDF, stopping before the stacked formula. Verify the selection preview; a drag across the formula overran into following text during rehearsal and was corrected before committing. Enter **Why scale attention scores?** in **Idea label**, leave **Node type** as **Concept**, and click **Add highlight to the graph**. Show the visible highlight and its reader-authored annotation/node. Record this baseline before agent edits; do not substitute an automatically suggested candidate for the human selection.

> I highlight the passage I want explained, give it a question, and add that highlight to the graph. The annotation starts with me, on the paper. Its text and location become an immutable source.

## 0:53–1:15 — Real agent tools, visible effects

**Picture:** Submit the single prompt below to the browser agent. Capture native site-tool activity and PaperPilot's matching receipts as they actually arrive. The required calls are `paperpilot.read_focus`, `paperpilot.read_graph`, `paperpilot.apply_graph`, `paperpilot.apply_annotation`, `paperpilot.focus_source` and `paperpilot.stage_explain`. More than six calls is expected when the agent rereads after changes. Keep the PDF, new graph item and annotation visible; trim waiting time in the edit, not the causal sequence.

> Now the browser agent uses six bounded WebMCP tools to read my focus, inspect the graph, navigate sources, stage explanations, and edit graph ideas and annotations. These receipts show actual calls, not just registered tools.

## 1:15–1:37 — Explanation that returns to evidence

**Picture:** Use **Go to explanation**. Show **Quick take** and at least one paper-evidence/mentor-background authority label. Briefly show **Save mentor note** and **Discard draft**, but leave the draft unsaved. Use **Jump to page** to move away, then select the actual new agent node in the map/outline or its **Go to source** action. Show the PDF return to the original page-4 highlight. Use the labels and source issued in this run, not IDs copied from earlier proof.

> The agent adds a linked concept and question. Selecting the idea takes me back to the source. Its explanation separates the paper’s evidence from teaching examples, interpretation, and uncertainty. Save or discard remains my choice.

## 1:37–1:55 — Human Undo and Redo

**Picture:** With the agent stopped, press **Undo** twice to reverse its question annotation and graph batch; the original reader annotation remains. Press **Redo** twice to restore those two edits. Keep the changing items and revision notices visible; expand the corresponding **Revision** disclosures to show their workspace digest transitions. During rehearsal, compare all three baseline/final digests using fresh native `read_graph` receipts; the history disclosure itself displays only the workspace digest. If the actual agent made a different number of batches, follow the real history and adjust this cut; never imply two clicks reversed a different sequence.

> If an edit does not help, I press Undo. Redo brings it back. The graph and annotations change visibly, and their recorded digests return to the expected state without erasing history.

## 1:55–2:09.5 — Figures without invented vision

**Picture:** Navigate to a visible figure. Choose **Mark a region**, draw around it, and confirm with Enter; **Use whole page** is the honest alternative for a whole-page source. Fill **Idea label**, choose **Figure**, and enter a brief reader-written **Screen-reader description of this region** based only on what is visible. Click **Add region to the graph**. Show its region/node link with an on-screen caption: **locator_only · pixelUseVerified: false**. This new reader edit comes after the Undo/Redo demonstration.

> For figures, I can describe a page region and connect it to the map. This is locator-only evidence: it identifies where to look, not proof that the agent inspected the pixels.

## 2:09.5–2:30 — Provenance and limits

**Picture:** Open **Evidence**, showing the source, callback and revision trail. End on the public URL, [repository](https://github.com/patrickjcraig/PaperPilot) and [MIT license](../LICENSE). Keep a small caption visible: **Browser-local prototype · human accessibility review pending**. No Save/Clear or export action is needed for this recording.

> PaperPilot is browser-local, keeps original PDF bytes unchanged, and offers no PDF export. The evidence trail records what happened, not scientific truth. Human accessibility review is still pending. Read, question, connect, and return to the paper.

## Single browser-agent prompt — not voice-over

Send only after the reader-created highlight is active:

```text
Explain my highlighted question for an undergraduate reading their first hard paper. Use PaperPilot's six tools: read_focus and read_graph first; apply_graph to add one paper-grounded concept and a source-backed relation to my reader node; apply_annotation to add a separate agent question on the same issued anchor, preserving my note. Use focus_source on the new concept. Then reread current focus and graph and stage_explain with explanationVersion:2 and all seven sections, separating exact paper support, background and uncertainty. Use fresh issued IDs and digests. Do not save, undo, redo, export or claim pixel verification. Stop after staging and report the new labels.
```

## Recording safeguards

- Capture one continuous source session before editing. Trim loading, typing and agent dead time; preserve the actual order of the human selection, callbacks, applied edits and reversals. A 2:30 edit is not a promise of a 2:30 live agent run. Do not splice different PDFs, releases or callback histories together.
- Count only fresh native callbacks. **Replay callback trace** is a replay visualization, not another agent invocation. An animated cursor or registered tool list alone is not proof of execution. If a call fails or the expected source/edit is missing, stop this take and rehearse the correction; do not narrate a success that did not happen.
- Keep the draft and workspace unsaved for this disposable take. Do not clear an existing saved workspace to make a clean screen. Optional **Save in this browser** writes bounded, exact-PDF-qualified workspace records, not PDF bytes; it is not server durability or cross-device synchronization.
- Record the actual client/date/artifact, with no guessed model/browser build. Use only public paper content; hide unrelated tabs, credentials and private material. Add accurate captions and explanatory audio, and verify duration after export of the **video**, not the PDF.
- The known Attention rehearsal, implemented outline and region-description controls do not complete unseen-paper evaluation or human accessibility acceptance. Screen-reader, literal 200% zoom, forced-colors/reduced-motion and another-machine review remain open, as do the final video URL, submission handoff and item-12 completion.
