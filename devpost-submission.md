# Title

PaperPilot

### ⏳ Not submitted yet

Nothing has been sent to Devpost by this drafting step. This is a local submission draft, not a published project description or a submission receipt. The authenticated event check found an existing **Untitled** pre-draft for The WebMCP Challenge (`webmcp`, event `31011`, project `1399992`) with no description or video and `submitted_at: null`. No form has been changed here.

The current public application is usable, with the annotation toolbar now above the PDF in deployed source `9dd6bd5`. The [public YouTube demo](https://youtu.be/EDpbN35rDfQ) is available, alongside the [150-second source MP4](docs/demo/PaperPilot-WebMCP-demo.mp4), [captions](docs/demo/PaperPilot-WebMCP-demo.srt) and [media verification](docs/demo/recording-verification.json). Public visibility and under-three-minute duration were checked in the browser, and the participant confirmed clear narration on the upload; see the [YouTube verification](docs/release/YOUTUBE-VERIFICATION-2026-09-02.md). The [current-release cross-PDF proof](docs/release/PUBLIC-RELEASE-REFRESH-2026-09-02.md) passes technical readiness 63/63. The participant's four personal form answers have been collected; private entrant/residence values are held outside tracked files. The owner approved a disclosed hackathon-only deferral of four unfinished human QA checks, which remain false. The [release-freeze plan](docs/release/HACKATHON-FREEZE-PLAN-2026-09-02.md) is prepared. Final exact-entry confirmation remains open; no external form write has occurred. The separate [publication-only writeup](docs/release/DEVPOST-PUBLIC-WRITEUP-2026-09-02.md), not this preparation worksheet, is intended for the public description.

## One-line Summary

A WebMCP research mentor that turns questions on a real scientific paper into source-linked explanations and ideas you can inspect, organize, and undo.

## Problem

Your first hard paper can feel like arriving halfway through a conversation. The authors assume you already know the vocabulary, the mathematics, and how to read their figures. A summary may tell you what the paper is about without teaching you the particular sentence that stopped you.

Copying a passage into a separate chat also loses something important: its location. Which equation, paragraph, or figure supports the explanation? Which part came from the authors, and which part is helpful background supplied by the model?

PaperPilot is built for that moment of confusion. Its primary reader is someone at roughly undergraduate level with basic prior knowledge, curiosity, and a difficult paper in front of them.

## Solution

PaperPilot keeps the actual PDF at the center of the workspace. The reader highlights text where it appears on the page, or marks a described visual region. That action creates a source annotation and a linked, reader-authored idea in the paper map.

A compatible browser agent then acts as a research mentor through WebMCP. It can inspect the selected source, search the current graph, add a grounded concept and relationship, place a separate question annotation, and bring the reader back to the exact source. Its explanation appears beside the paper in seven predictable sections, from a quick take to prerequisites, mechanisms, evidence, related ideas, and limitations.

The agent's graph and annotation edits are real application changes, not a diagram embedded in a chat response. They appear immediately, carry attribution and evidence links, and can be reversed with the reader's Undo and Redo controls. Mentor notes have a separate human Save/Discard decision.

## Why This Matters

PaperPilot aims to make difficult reading more teachable without asking readers to trust an unexplained answer. The graph connects ideas; the source link brings those ideas back to the paper; the authority label distinguishes paper text from interpretation and background.

This is a strong fit for WebMCP because the page already knows things the agent should not invent: the active document, the exact selected words, page geometry, issued source IDs, and the current graph revision. PaperPilot exposes those facts and a small set of useful actions through structured tools. The agent contributes explanation and organization; the application enforces the source and mutation boundaries; the reader controls the question and can reverse an unwanted edit.

Provenance is not a hallucination guarantee. A valid source link proves which material an idea points to, not that the interpretation is scientifically correct. PaperPilot makes that distinction inspectable instead of hiding it behind a confident answer.

## How We Used AI

The browser agent is the in-product mentor. Public rehearsals and the current recording session used native WebMCP callbacks to read a source and graph, create an idea and relation, add an in-app question, navigate to the source, and stage a claim-labeled explanation. The recording session observed 13 callbacks covering all six tool types. There is no server-side explanation model hidden behind the public demo.

Explanation claims distinguish exact document text, mentor interpretation, and mentor background. Agent-declared external citations remain unverified. Figure and page-region results currently provide locators and reader-supplied descriptions, not verified pixel observations: the returned mode is `locator_only`, with `pixelUseVerified: false`.

Automatic structural mapping and extractive idea suggestions are orientation aids. Structural coverage counts pages; it does not claim complete semantic understanding. Suggested ideas remain explicitly unreviewed. Selecting, arranging, or discussing an idea does not verify its scientific correctness.

## How We Used Codex

Codex supported the build from guided scope, PRD, and technical specification through implementation, tests, independent code reviews, and live browser verification. Parallel agents worked on bounded areas such as graph contracts, persistence, accessibility, and release checks while preserving shared source boundaries.

The most useful loop was to turn a real failure into a reproducible test and then verify the repaired behavior in the browser. For example, public testing found that source navigation after Undo/Redo could report the requested page while the PDF settled on an older focus. Actual application/core regressions captured the mismatch; the fix was deployed and replayed on the weak-text fixture. Separate tests caught empty optional context at first/last-word selection boundaries without changing the exact source text.

The [build journal](docs/hackathon-build/build-notes.md) records these decisions and checks. In the participant's own reflection, this was their first experience with WebMCP and MCPs generally. They learned a lot about creating agent-centric applications and the fundamentals of WebMCP, and see it as a powerful way to interface with LLMs. They expect that learning to be useful in their career. The corresponding personal answers are **Significant** learning and **Yes** for career-useful AI value; these are self-reported learning outcomes, not technical acceptance results.

## Key Features

- **Read in place:** continuous real-PDF scrolling, page navigation, zoom, and PDF-aligned markup, with no persistent duplicate transcript.
- **Start with the reader:** a text highlight or described region creates a trusted source and reader-authored graph item before the agent adds its own work.
- **Build an inspectable map:** canonical workspace records and the reducer govern state; Graphology supplies graph topology, while Sigma and a complete accessible DOM outline provide views. Moving a node or card changes presentation, not its source evidence.
- **Teach with provenance:** seven mentor sections carry claim-level source, graph, authority, and uncertainty information.
- **Reverse agent edits:** bounded atomic graph/annotation revisions include inverse patches; human-only Undo/Redo restores semantic state while retaining the audit history.
- **Keep custody clear:** the public slice runs in the browser. Optional saved recovery is tied to the exact PDF digest; the original PDF is neither rewritten nor exported.

The six registered capabilities are:

| Tool | What it enables |
| --- | --- |
| `paperpilot.read_focus` | Read the active, page-issued source and bounded context. |
| `paperpilot.read_graph` | Inspect or search a bounded part of the current graph and its revision. |
| `paperpilot.focus_source` | Navigate to an issued source in the active paper. |
| `paperpilot.stage_explain` | Stage a validated, graph-aware mentor explanation for human review. |
| `paperpilot.apply_graph` | Apply a bounded, source/authority-checked graph revision. |
| `paperpilot.apply_annotation` | Add or edit permitted annotations over already issued anchors, without supplying PDF coordinates. |

No WebMCP tool can save a mentor note, accept its correctness, call human Undo/Redo, export a PDF, or operate on another paper's sources.

## Architecture

The judged application is the anonymous static `/webmcp/` reader, deployed over HTTPS on GitHub Pages. It does not require an account, API key, database, or local server to try.

PDF.js renders the selected document and its text layer. Page-owned code binds selections to immutable document identity and spatial anchors. Canonical workspace records and the reversible reducer own state; Graphology supplies topology, and Sigma and the DOM outline are derived views. A strict command layer validates bounded inputs, current revisions, grounding, and idempotency before committing a reversible change. Document-scoped WebMCP registration connects that layer to the browser agent.

Opt-in browser recovery uses a bounded version-3 snapshot keyed by PDF SHA-256. It stores workspace records and human-saved notes, never PDF bytes. Reopening the same bytes in the same browser can restore the saved workspace; a matching filename with different bytes cannot. The public slice writes no local or remote database and is not cross-device storage.

The repository also contains an older authenticated Next.js service and discovery/import foundations. They are not the judged public deployment. A later serverless Vercel/Supabase port, Zotero/crawler acquisition, cross-paper graphs, OCR, and vector retrieval are future work, not features claimed by this submission. See the [existing/new-work disclosure](docs/HACKATHON-CHANGELOG.md).

## Testing Instructions

1. Open the [public PaperPilot reader](https://patrickjcraig.github.io/PaperPilot/webmcp/) in a WebMCP-capable browser/agent environment. No login is required. **Open the live demo** loads the official *Attention Is All You Need* arXiv v7 PDF only after activation. Alternatively, choose your own supported PDF; published limits are 25 MiB and 200 pages.
2. For the rehearsed walkthrough, use **Jump to page** to go to page 4. Choose **Highlight text** and select the short prose “To counteract this effect, we scale the dot products”. Inspect the preview before committing; do not accidentally include unrelated text around the stacked equation.
3. Enter **Why scale attention scores?** as the idea label, choose a Concept, and use **Add highlight to the graph** in the toolbar above the PDF. Inspect the new reader annotation and source-linked node. The reader's work is the starting point, not an agent-fabricated source.
4. Ask the browser agent: “Use PaperPilot's tools to read my selected source and current graph. Add one source-grounded concept linked to my reader node and one separate question annotation, return to that source, then reread the current context and stage the seven-section explanation. Use issued IDs and current revisions; label background knowledge, keep the explanation unsaved, and do not claim verified pixels.”
5. Inspect Map, Annotations, the mentor, and Evidence. Follow the graph or annotation **Go to source** action back to the highlight. Registration alone is not the proof: the evidence trail should show actual callbacks and applied revisions.
6. Use the human **Undo** and **Redo** buttons to compare the agent's changes. If the agent used one graph batch and one annotation batch, two Undo actions reverse those two edits without removing the earlier reader annotation; two Redo actions restore them. Use **Review changes** to inspect the actual batches rather than assuming a fixed count.
7. Optional figure path: go to page 3, use **Mark a region** or **Use whole page**, provide an honest screen-reader description, choose Figure, and add it to the graph. Whole-page context is not a tight figure crop. Inspect the locator-only limitation rather than interpreting the callback as visual verification.

If WebMCP is unavailable, the local PDF, map, annotations, and human controls remain usable, but native-agent success must not be claimed. No saving or clearing an existing browser copy is needed for this walkthrough. The [judge guide](docs/DEVPOST-JUDGE-GUIDE.md) contains the fuller test path and local reproduction commands.

## Public Demo Link

[Open PaperPilot](https://patrickjcraig.github.io/PaperPilot/webmcp/)

Use this canonical URL in the form. The current toolbar-above-PDF release is source `9dd6bd561b3fc628907e797442a252b5a8012379`, served with fingerprint `a0d5f6636b0eace96e04011526450f0942a6a797ee5d8fafda9faf2bbf8b7167` after [successful Pages run 33647998514](https://github.com/patrickjcraig/PaperPilot/actions/runs/33647998514). The [current recording evidence](docs/release/DEMO-RECORDING-2026-09-02.md) documents its real public Attention run.

The [current cross-PDF release proof](docs/release/PUBLIC-RELEASE-REFRESH-2026-09-02.md) combines that same-release Attention recording with fresh public GW150914, weak-text and invalid-input checks at `9dd6bd5`. Its 36 successful receipts cover both research papers and the limited-text fixture; the earlier [673726c proof](docs/release/PUBLIC-RELEASE-PROOF-2026-09-02.md) remains archived rather than relabeled. The video and public release are matched by the recording verification. An anonymous HTTP recheck on September 2 returned the same asset fingerprint; GitHub again reported a public MIT repository.

## Public Repository Link

[PaperPilot on GitHub](https://github.com/patrickjcraig/PaperPilot) — public repository with an [MIT license](https://github.com/patrickjcraig/PaperPilot/blob/main/LICENSE).

The MIT license covers PaperPilot's code, not the scientific papers selected by readers. The generated public package excludes paper PDF bytes and credentials. The primary demo source is `spikes/webmcp-contract/`; `scripts/package-webmcp-pages.mjs` produces the repository-prefix-safe Pages artifact.

## Demo Video

**Public YouTube URL: [PaperPilot WebMCP demo](https://youtu.be/EDpbN35rDfQ).** Studio reports Public visibility; the signed-out watch page loads the video and shows a 2:30 duration. Studio displays 2:31; both are below three minutes. The participant explicitly confirmed that the upload's narration plays clearly with sound. These observations are recorded in the [YouTube verification](docs/release/YOUTUBE-VERIFICATION-2026-09-02.md).

The [finished source MP4](docs/demo/PaperPilot-WebMCP-demo.mp4) is **150.000 seconds**, **6,132,064 bytes**, H.264/yuv420p at 24 fps with AAC 48 kHz mono audio. It contains 447 real screenshots from the same public Attention run, synthetic Zira narration, burned-in phrase captions and a [separate SRT](docs/demo/PaperPilot-WebMCP-demo.srt). The footer discloses edited timing and synthetic narration throughout. Native picture pixels were not cropped or resized; a caption footer and required one-pixel right pad produce 1266 × 812 output. Full decode-to-null and media-stream checks passed, and representative frames were inspected. [Verification metadata](docs/demo/recording-verification.json) binds the source media hashes to the source release, not to YouTube's transcoded bytes.

The [263-word narration](docs/DEMO-NARRATION.md) and [video plan](docs/DEMO-VIDEO-PLAN.md) target a 2:30 edited walkthrough. The current capture includes 13 actual native callbacks across all six tools, reader-originated annotation, agent graph/annotation work, source return, two human-UI Undo actions and two Redo actions with all three semantic digests restored, and whole-page-3 figure context reported as `locator_only` with `pixelUseVerified: false`.

The captured reader selection ends at “dot product”, cutting the paper's word “products” before its final letter. The mentor explicitly discloses that incomplete selection; the edit must not silently replace it with the cleaner phrase used in the earlier rehearsal. This is a useful illustration of checking source boundaries, not proof of a complete equation or figure interpretation. The controls were operated by the agent for recording, not accepted by a human accessibility reviewer.

The supplied upload preserves the captured application's visible layout and disclosure footer. Browser inspection verifies public access and duration; the participant's separate listening confirmation verifies clear explanatory audio. Burned-in captions are visible, but the watch player reports that a separate selectable caption track is unavailable. The existing SRT remains available in the repository. The [current recording evidence](docs/release/DEMO-RECORDING-2026-09-02.md) and older rehearsal are deliberately distinct records.

The earlier [public demo rehearsal](docs/release/DEMO-REHEARSAL-2026-09-02.md) contains its own receipts and source-return/digest checks at `673726c`. It is agent-operated rehearsal evidence, not the current video capture or human accessibility acceptance.

## Screenshot Shot List

1. **The whole reading desk:** centered PDF with the mentor, map, and above-PDF annotation toolbar visible. Use an actual frame from the current `9dd6bd5` recording for the final submission. The existing [Attention release screenshot](docs/release/evidence/public-attention-2026-09-02.png) remains evidence for the older `673726c` layout.
2. **Reader-created source:** the exact selected prose, clear idea label, and linked reader annotation/node. Capture after the user action and before agent edits.
3. **Agent action plus evidence:** the new concept/relation, separate question annotation, and observed callback/revision detail; keep source authority readable.
4. **The same pipeline on another paper:** existing [GW150914 screenshot](docs/release/evidence/public-gw150914-2026-09-02.png), labeled as an unrelated, previously rehearsed QA input at `673726c`, not a new current-release run or an unseen paper.
5. **Honest limitations:** existing [weak-text screenshot](docs/release/evidence/public-weak-text-2026-09-02.png) at `673726c`, showing a navigable page with limited text and locator-only source context. The current recording separately shows whole-page-3 Attention context, not that weak-text fixture.

These are a shot plan and identified existing evidence assets, not a claim that final Devpost images have been uploaded.

## Submission Readiness Notes

- The current `9dd6bd5` public recording observed all six tool types in 13 native callbacks on rehearsed Attention, plus exact three-digest restoration through two Undo/two Redo actions and the locator-only whole-page figure path. It is retained as same-release evidence, not presented as a newly repeated recording.
- The [current cross-PDF refresh](docs/release/PUBLIC-RELEASE-REFRESH-2026-09-02.md) adds 15 successful GW150914 callbacks covering all six tools and eight weak-text callbacks. It verifies exact graph/annotation Undo/Redo digests, visible source reopening, limited-text fallback, and safe foreign-source/non-PDF rejection. Attention and GW are rehearsed inputs through the shared arbitrary-PDF pipeline, not newly discovered papers. The earlier `673726c` evidence remains historical.
- The current focused verification passed **659 tests: 655 WebMCP tests plus four packaging tests**, with a clean TypeScript check. The full application suite was not rerun for this toolbar/recording update. The older release record reports 1,371 passing tests and 63/63 technical readiness controls; those dated results are not reattributed to `9dd6bd5`. Its full readiness check remained red on human-review and submission controls.
- Current technical readiness is **63/63** (checker exit 0), with machine-readable proof bound to `9dd6bd5` / `a0d5…` and 36 unique successful callback receipts. The evidence-validator tests pass **14/14**. This closes the source-mismatch gap using actual current-release runs; no checker or runtime rule was weakened. The supplied public YouTube link, observed under-three-minute duration and participant-confirmed explanatory audio close the three video controls. The exact release-freeze procedure is now prepared. Four human-review controls remain unverified under the owner's scoped deferral; final Devpost verification remains open.
- The participant reports manual testing in **Microsoft Edge** and explicitly says no screen reader was used. Browser version, OS, individual pass/fail results, literal 200% zoom and second-machine details were not supplied; they are not inferred. Screen-reader acceptance is unverified. The [human-review record](docs/release/HUMAN-RELEASE-REVIEW-2026-09-02.md) retains the report separately from automated controls and native WebMCP evidence. No human acceptance flag is changed by this report.
- The participant supplied all four personal answers in conversation. Entrant type and residence are retained only in ignored local form-preparation data; residence is not copied into the public repository. Learning is **Significant** and career-useful AI value is **Yes**. These answers do not attest to accessibility, video review, or release readiness. The AI-tool disclosure names observed OpenAI Codex use without inventing extra tools or model identifiers.
- Public YouTube access, duration and explanatory audio are verified as described above. The owner approved deferring the unfinished human application checks with explicit public limitations. **Final action still required:** review the complete final text/fields and confirm the real Devpost write and submission. This does not invent missing acceptance observations, mark checklist item 12 complete, or move the project into a submitted state.
- The current official field set does not request a Codex session ID; none is collected or invented here.

## Known Limitations

The public slice is a single-paper, browser-local prototype. Text extraction and reading order vary across PDFs; weak-text pages can remain useful as described regions without invented transcription. Structural coverage does not establish semantic completeness, and an agent-created graph is not scientific verification.

Figures and equations can be located, described by the reader, and discussed with clearly labeled mentor interpretation, but current WebMCP region receipts do not verify that the agent observed pixels. There is no OCR service, cross-paper synthesis, account synchronization, server-side mentor model, or annotated-PDF export in the judged slice.

Native tool behavior was recorded in the OpenAI Codex In-app Browser on Windows. Exact client build strings were unavailable. The participant separately reports manual testing in Microsoft Edge without a screen reader; this is not proof of native WebMCP execution in Edge. Chrome is an intended compatible environment under the event requirements, not a tested-client result supplied by the current proof. Human primary/graph accessibility acceptance, literal 200% zoom and second-machine checks remain unverified and are explicitly deferred for this hackathon entry. This is not general accessibility certification or production-release signoff.

## Prepared Official Form Fields

This map uses the official field IDs and choices reported by the authenticated event check. It is a draft for review, not a submitted form. Core project title/description/video content above is separate from these custom questions.

| Field ID | Official field | Draft answer / status |
| --- | --- | --- |
| `28249` | SubmitterType — `Individual`, `Team of Individuals`, or `Organization` | **Confirmed by participant; value held outside tracked files for the official form.** |
| `28250` | Countries | **Confirmed by participant; value held outside tracked files for the official form.** |
| `28251` | Organization, optional | **Not applicable to the confirmed entrant type; leave blank.** |
| `28252` | AppStatus — `New` or `Existing` | **Existing.** PaperPilot predates this challenge; the new work is disclosed below. |
| `28253` | Explanation of changes to an existing app | Use the draft paragraph immediately below this table. |
| `28254` | Live application URL | `https://patrickjcraig.github.io/PaperPilot/webmcp/` |
| `28255` | Testing instructions, optional | Use the Testing Instructions section above; no account or credentials are required. |
| `28256` | Repository URL | `https://github.com/patrickjcraig/PaperPilot` — public, MIT. |
| `28257` | Tested clients | OpenAI Codex In-app Browser WebMCP on Windows, recorded September 2, 2026, including the current `9dd6bd5` public Attention run. Exact build strings were not exposed. Do not add Chrome without actual testing. |
| `28258` | AI tools used | OpenAI Codex for guided planning, implementation, tests, independent reviews, and browser verification, including the WebMCP browser-agent mentor. No additional AI tool or exact model identifier is asserted. |
| `28259` | Learning — `None`, `Moderate`, or `Significant` | **Significant.** The participant described learning a lot about agent-centric applications and WebMCP fundamentals. |
| `28260` | Career-useful AI value — `Yes` or `No` | **Yes.** The participant expects this first experience with WebMCP/MCPs to be useful in their career. |

**Draft existing-app change explanation (`28253`):**

PaperPilot already had research-discovery, project/import, and authenticated-service foundations. For The WebMCP Challenge, the work was refocused into an anonymous, paper-first learning workspace: a continuous real PDF, reader-originated spatial annotations, an automatic structural map, a Graphology/Sigma knowledge graph with a DOM outline, and six native WebMCP tools for source/graph reading, search, navigation, explanation staging, and reversible graph/annotation edits. The challenge work also added claim-level mentor provenance, immutable source anchors, revision-guarded commands, human-only Undo/Redo, opt-in exact-PDF browser recovery, and cross-PDF release evidence. The older discovery, Zotero/crawler, and service foundations are not represented as new challenge work or as the deployed backend for this public slice. Dated implementation commits and limitations are linked in the repository's change disclosure and release proof.

**Before external submission:** confirm the reviewed publication-only writeup and form values for the actual Devpost update and submission. Until then, this file remains a preparation record, not a public project description or submission receipt.
