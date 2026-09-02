# Human release review — Verification Pause 3

Status: **Awaiting human observations. No acceptance flag is changed by this sheet.**

Review the [public PaperPilot reader](https://patrickjcraig.github.io/PaperPilot/webmcp/?release=9dd6bd5), runtime source `9dd6bd561b3fc628907e797442a252b5a8012379`, fingerprint `a0d5f6636b0eace96e04011526450f0942a6a797ee5d8fafda9faf2bbf8b7167`. The release query refreshes the entry URL; it is not an immutable deployment pin. Current technical evidence is in [the public release refresh](PUBLIC-RELEASE-REFRESH-2026-09-02.md). The [673726c release proof](PUBLIC-RELEASE-PROOF-2026-09-02.md) and setup receipts below remain historical, not evidence newly collected for this toolbar release.

The owner accepted the invitation to begin this review with “next.” That is not a statement that any screen-reader, browser-zoom, or second-machine check passed.

## Ready-to-try visual and keyboard check

Use the preserved Attention **recording workspace** (tab 24 during setup), not the older review workspace (tab 21). Tab numbers are session-local; identify the correct workspace by these recorded labels:

- Reader-authored concept and annotation: **Why scale attention scores?**, page 4.
- Agent concept: **Scaling the attention dot products**, linked to that page-4 source.
- Agent question: **Mentor question: how could large attention scores affect softmax?**, page 4.
- Latest recorded edit, revision 9: reader-authored **Figure 1 — whole-page context**, a described whole-page region and linked figure node on page 3.

The recording workspace has a staged mentor note and is unsaved. Do not reload, save over, clear, or close the preserved recording tab or the owner's older tabs/saved copies just to begin the review; reopening a URL does not recreate unsaved agent work. The [recording evidence](DEMO-RECORDING-2026-09-02.md) identifies this session. Its page-4 quote ends at “dot product”, before the final letter and formula; assess the actual retained fragment, not a repaired or extended quotation.

1. In the right rail, open **Review changes** and inspect the newest batch before using **Undo**, then **Redo**. Their accessible names are **Human Undo** and **Human Redo**. In the recorded revision-9 state, one Undo reverses **Figure 1 — whole-page context**: its page-3 region annotation and linked figure node should disappear, then return after Redo. The earlier page-4 reader highlight, agent concept, and question should remain. One Undo does **not** reverse the question at this history head. If new work has changed the head, follow the actual newest batch rather than this recorded expectation.
2. In **Annotations**, find **Mentor question: how could large attention scores affect softmax?** and activate **Go to source**. The viewer should return to its marked page-4 fragment. In **Map**, **Why scale attention scores?** and **Scaling the attention dot products** should lead to that same source. After Redo, the **Figure 1 — whole-page context** source should reopen page 3 as a whole-page locator, not a tight figure crop.
3. Repeat using Tab/Shift+Tab and Enter where possible. Report any missing focus ring, unreachable control, unexpected page, or focus trap. A pointer-only success does not establish keyboard or screen-reader acceptance.

Human observation: _pending_

## Full acceptance record

Record the actual date, browser/build, OS, screen reader/version, and tested release. Write **not tested** when a client or device is unavailable. Never copy historical version strings into a new observation.

- Reviewer/date: _pending_
- Browser/build and OS: _pending_
- Screen reader/version: _pending_
- Observed release URL/source: _pending_
- Result for each check: _pass / failed with reproduction / not tested_

### 1. Paper and source selection

With NVDA on Windows, use **Skip to paper**, the annotation toolbar above the PDF box, the **Jump to page** control, PDF zoom and **Fit width**. Confirm that page announcements match the displayed page, reading order is usable, and the canvas does not trap navigation.

Use **Use whole page**, then Escape. Focus should return to that exact initiating control. Open it again and confirm with Enter; focus should reach **Screen-reader description of this region**. In a dedicated disposable QA workspace, submit once with the required description empty to check associated error feedback, then supply a meaningful description and **Idea label** and activate **Add region to the graph**. Failed validation must create no annotation. Successful creation must remain reader-authored, not pixel-verified.

Result and actual announcement/focus behavior: _pending_

### 2. Graph, annotations, changes and evidence

Use **Skip to knowledge graph**, **Complete graph outline**, and **Summary, sources & relationships**. Read type, authority, source count, summary, and directed relationships. Follow an issued page-source action. The **Map / Annotations / Evidence** tabs support Left/Right/Home/End; the same sources must be usable without Sigma's canvas.

In disposable QA state, try **Arrange this node** and one **Move selected graph node …** control. Placement must not move the paper source. Inspect the newest batch in **Review changes** before exercising **Human Undo** and **Human Redo**, then inspect **Evidence**. Confirm useful, restrained announcements and stable focus; the original mutation must remain in the trail after reversal. For the untouched recording workspace, the latest reversible edit is the page-3 region and linked figure node described above, not the older question.

Result and actual announcement/focus behavior: _pending_

### 3. Mentor and safe recovery

On a tab with a staged explanation, activate **Go to explanation**. Read **Quick take**, **Evidence in the paper**, and **Limits and uncertainty**, including authority labels and source/graph links. Explanation arrival should not take keyboard focus automatically.

Save/reload testing is optional on the preserved public workspace: do not overwrite its earlier saved copy to complete this check. Use a separate browser/profile or disposable QA PDF if testing **Save mentor note**, **Save in this browser / Save changes**, and byte-identical reupload. Use **Clear saved copies → Cancel clear** to test the persistent warning and focus return. Do not confirm Clear as part of this walkthrough. Unsaved drafts are not promised to survive reload.

Result and actual announcement/focus behavior: _pending_

### 4. Actual browser zoom, contrast and motion

Set the browser's own zoom to **200%**, not PaperPilot's **Zoom PDF in** control. Repeat the page locator, annotation form, graph tabs/outline, mentor and source actions. Required controls must remain available without application-level two-dimensional scrolling; panning inside an intentionally zoomed PDF is a separate behavior.

Also inspect Windows forced-colors/high-contrast and reduced-motion preferences. Focus, authority and change states must remain distinguishable without color alone; nonessential animation should stop. Existing 320/640 CSS-pixel automation is not evidence of actual browser zoom or a human contrast/motion review. If a different browser lacks native WebMCP, evaluate its manual Reader separately; do not count it as native-agent proof.

Result, actual zoom and preferences used: _pending_

### 5. Another-machine access

Open the public URL on another physical machine without relying on the owner's login. Load the demo paper and check the continuous viewer, map and source navigation. This checks anonymous access, not synchronization: the first machine's unsaved or browser-local notes are not expected to appear. Record native WebMCP availability separately.

Device/browser, access result and any limitation: _pending_

## Current automated evidence — 9dd6bd5

The [public release refresh](PUBLIC-RELEASE-REFRESH-2026-09-02.md) binds the current artifact to the Attention recording, fresh GW150914 and weak-text runs, and unsupported-input rejection. The [recording proof](DEMO-RECORDING-2026-09-02.md) describes the preserved Attention workspace and its 13 successful native callbacks. These are agent-operated observations, not human keyboard, screen-reader, zoom, or another-machine acceptance. This worksheet adds no new browser observation or checker result.

The [narrated demo MP4](../demo/PaperPilot-WebMCP-demo.mp4) and [captions](../demo/PaperPilot-WebMCP-demo.srt) have been produced. Human review of the actual video, public YouTube publication/verification, and the participant's personal form answers remain pending.

## Historical setup evidence — 673726c

The observations below were collected on the **older 673726c review workspace** (tab 21 during setup), before the toolbar move. That workspace had the question **Why divide the attention score by the square root of the key dimension?**; it is not the current recording question. These receipts and counts are retained unchanged as historical automated evidence, not current-release observations or human acceptance:

- Fresh native focus read `callback:96443d58-e3f3-4398-b68b-5c8807a6d3be` reported Attention, 15 pages, exact text on page 4, workspace revision 9.
- Keyboard activation of Right Arrow from **Map** selected and focused **Annotations 11**.
- Enter on the question card's **Go to source** moved focus to the named PDF anchor on page 4. The visible viewer independently reported **continuous page 4 of 15**.
- Follow-up native read `callback:fcd2d8a6-347f-489a-8c4a-8502ad609ed0` retained anchor `anchor:auto:idea:p4:1ozmjs2` and all starting workspace/graph/annotation digests and revision. No annotation or graph edit was made during setup.
- Browser warning/error diagnostics were empty. No Save, Clear, reload or PDF-byte operation was used.
- At that historical setup, `node scripts/check-devpost-readiness.mjs --phase technical` passed **63/63**; four human-review and five submission controls were open. This is not a fresh checker result for `9dd6bd5`.

During that historical setup, the normal npm wrapper encountered a host **ENOSPC** error: C reported zero free bytes, while E had about 560 GB free. Running the same checker directly bypassed npm's C-drive log/cache write. Nothing was deleted or relocated, no global npm setting was changed, and no database was started or written. Those disk figures and the workaround describe that earlier observation, not a new environment check.

## Completion rule

Only recorded actual outcomes may change `accessibilityPrimaryFlowVerified`, `graphAccessibilityVerified`, `browser200PercentZoomVerified`, or `liveUrlAnotherMachineVerified` in `devpost-requirements.json`. All human fields in this worksheet remain pending; a partial visual check cannot close the full accessibility gate. Checklist items 10 and 11 remain unchecked until their acceptance dependencies pass. The local narrated video is recorded, but its human review, YouTube publication, personal answers, submission handoff, and explicit action-time submission/freeze confirmation remain open.
