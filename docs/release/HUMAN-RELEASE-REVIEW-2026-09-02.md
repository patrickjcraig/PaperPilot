# Human release review — Verification Pause 3

Status: **Awaiting human observations. No acceptance flag is changed by this sheet.**

Review the [public PaperPilot reader](https://patrickjcraig.github.io/PaperPilot/webmcp/?release=673726c), runtime source `673726c0f00756bdbfa57a4c1c72ab3d61062d4a`. The release query refreshes the entry URL; it is not an immutable deployment pin. Current technical evidence and the full runtime fingerprint are in [the release proof](PUBLIC-RELEASE-PROOF-2026-09-02.md).

The owner accepted the invitation to begin this review with “next.” That is not a statement that any screen-reader, browser-zoom, or second-machine check passed.

## Ready-to-try visual and keyboard check

The current Attention review tab contains a draft mentor note, the graph node **Why scale attention scores?**, and the question annotation **Why divide the attention score by the square root of the key dimension?** at page 4. It is explicitly **Not saved · active tab only**. Do not reload or clear this tab just to begin the review; reopening a URL does not recreate its unsaved agent work.

1. In the right rail, use **Undo**, then **Redo**. Their accessible names are **Human Undo** and **Human Redo**. The question annotation should disappear and return. The automatic source highlight may remain: it is a different record, not a failed Undo. The graph idea is also a separate earlier revision.
2. In **Annotations**, find that question and activate **Go to source**. The viewer should return to the marked sentence on page 4. In **Map**, the **Why scale attention scores?** node should lead to the same source.
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

With NVDA on Windows, use **Skip to paper**, the **Jump to page** control, PDF zoom and **Fit width**. Confirm that page announcements match the displayed page, reading order is usable, and the canvas does not trap navigation.

Use **Use whole page**, then Escape. Focus should return to that exact initiating control. Open it again and confirm with Enter; focus should reach **Screen-reader description of this region**. In a dedicated disposable QA workspace, submit once with the required description empty to check associated error feedback, then supply a meaningful description and **Idea label** and activate **Add region to the graph**. Failed validation must create no annotation. Successful creation must remain reader-authored, not pixel-verified.

Result and actual announcement/focus behavior: _pending_

### 2. Graph, annotations, changes and evidence

Use **Skip to knowledge graph**, **Complete graph outline**, and **Summary, sources & relationships**. Read type, authority, source count, summary, and directed relationships. Follow an issued page-source action. The **Map / Annotations / Evidence** tabs support Left/Right/Home/End; the same sources must be usable without Sigma's canvas.

In disposable QA state, try **Arrange this node** and one **Move selected graph node …** control. Placement must not move the paper source. Exercise **Human Undo**, **Human Redo**, **Review changes**, and **Evidence**. Confirm useful, restrained announcements and stable focus; the original mutation must remain in the trail after reversal.

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

## Evidence collected by the agent during review setup

These are automated observations, not human acceptance:

- Fresh native focus read `callback:96443d58-e3f3-4398-b68b-5c8807a6d3be` reported Attention, 15 pages, exact text on page 4, workspace revision 9.
- Keyboard activation of Right Arrow from **Map** selected and focused **Annotations 11**.
- Enter on the question card's **Go to source** moved focus to the named PDF anchor on page 4. The visible viewer independently reported **continuous page 4 of 15**.
- Follow-up native read `callback:fcd2d8a6-347f-489a-8c4a-8502ad609ed0` retained anchor `anchor:auto:idea:p4:1ozmjs2` and all starting workspace/graph/annotation digests and revision. No annotation or graph edit was made during setup.
- Browser warning/error diagnostics were empty. No Save, Clear, reload or PDF-byte operation was used.
- `node scripts/check-devpost-readiness.mjs --phase technical` passed **63/63**. Four human-review and five submission controls remain open.

The normal npm wrapper encountered a host **ENOSPC** error: C reported zero free bytes, while E had about 560 GB free. Running the same checker directly bypassed npm's C-drive log/cache write. Nothing was deleted or relocated, no global npm setting was changed, and no database was started or written. This environment issue is separate from the passing public-app check.

## Completion rule

Only recorded actual outcomes may change `accessibilityPrimaryFlowVerified`, `graphAccessibilityVerified`, `browser200PercentZoomVerified`, or `liveUrlAnotherMachineVerified` in `devpost-requirements.json`. A partial visual check cannot close the full accessibility gate. Checklist items 10 and 11 remain unchecked until their acceptance dependencies pass; the narrated video and submission/freeze are still later work.
