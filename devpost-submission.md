# Title

PaperPilot

### ⏳ Not submitted yet

Nothing has been sent to Devpost by this drafting step. This is a local submission draft, not a published project description or a submission receipt. The authenticated event check found an existing **Untitled** pre-draft for The WebMCP Challenge (`webmcp`, event `31011`, project `1399992`) with no description or video and `submitted_at: null`. No form has been changed here.

The current public application is usable, with the annotation toolbar now above the PDF in deployed source `9dd6bd5`. The [150-second narrated/captioned demo](docs/demo/PaperPilot-WebMCP-demo.mp4) is recorded and encoded, with [captions](docs/demo/PaperPilot-WebMCP-demo.srt) and [media verification](docs/demo/recording-verification.json). The final YouTube URL, unanswered personal form fields, human accessibility/access review, current-release cross-PDF proof refresh, and action-time submission confirmation remain open.

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

The [build journal](docs/hackathon-build/build-notes.md) records these decisions and checks. This account describes documented project work; the participant's personal learning and career-interest answers still need their own confirmation.

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

The earlier [cross-PDF release proof](docs/release/PUBLIC-RELEASE-PROOF-2026-09-02.md) remains bound to source `673726c` and Pages run `33640830540`. It is historical evidence for that build, not a new GW150914 or weak-text replay on `9dd6bd5`. **TODO before posting:** review the completed video against the deployed toolbar release and confirm that the final public links still match the intended submission.

## Public Repository Link

[PaperPilot on GitHub](https://github.com/patrickjcraig/PaperPilot) — public repository with an [MIT license](https://github.com/patrickjcraig/PaperPilot/blob/main/LICENSE).

The MIT license covers PaperPilot's code, not the scientific papers selected by readers. The generated public package excludes paper PDF bytes and credentials. The primary demo source is `spikes/webmcp-contract/`; `scripts/package-webmcp-pages.mjs` produces the repository-prefix-safe Pages artifact.

## Demo Video

**TODO — public YouTube URL.** The [finished MP4](docs/demo/PaperPilot-WebMCP-demo.mp4) is **150.000 seconds**, **6,132,064 bytes**, H.264/yuv420p at 24 fps with AAC 48 kHz mono audio. It contains 447 real screenshots from the same public Attention run, synthetic Zira narration, burned-in phrase captions and a [separate SRT](docs/demo/PaperPilot-WebMCP-demo.srt). The footer discloses edited timing and synthetic narration throughout. Native picture pixels were not cropped or resized; a caption footer and required one-pixel right pad produce 1266 × 812 output. Full decode-to-null and media-stream checks passed, and representative frames were inspected. [Verification metadata](docs/demo/recording-verification.json) binds the media hashes to the source release. YouTube publication is waiting for the participant to sign in; a GitHub-hosted MP4 does not replace the event's required public YouTube link.

The [263-word narration](docs/DEMO-NARRATION.md) and [video plan](docs/DEMO-VIDEO-PLAN.md) target a 2:30 edited walkthrough. The current capture includes 13 actual native callbacks across all six tools, reader-originated annotation, agent graph/annotation work, source return, two human-UI Undo actions and two Redo actions with all three semantic digests restored, and whole-page-3 figure context reported as `locator_only` with `pixelUseVerified: false`.

The captured reader selection ends at “dot product”, cutting the paper's word “products” before its final letter. The mentor explicitly discloses that incomplete selection; the edit must not silently replace it with the cleaner phrase used in the earlier rehearsal. This is a useful illustration of checking source boundaries, not proof of a complete equation or figure interpretation. The controls were operated by the agent for recording, not accepted by a human accessibility reviewer.

Trim waiting time without presenting an unobserved action as completed. Review the actual encoded audio, legibility, captions, duration, and public access before supplying the URL. The [current recording evidence](docs/release/DEMO-RECORDING-2026-09-02.md) and older rehearsal are deliberately distinct records.

The earlier [public demo rehearsal](docs/release/DEMO-REHEARSAL-2026-09-02.md) contains its own receipts and source-return/digest checks at `673726c`. It is agent-operated rehearsal evidence, not the current video capture or human accessibility acceptance.

## Screenshot Shot List

1. **The whole reading desk:** centered PDF with the mentor, map, and above-PDF annotation toolbar visible. Use an actual frame from the current `9dd6bd5` recording for the final submission. The existing [Attention release screenshot](docs/release/evidence/public-attention-2026-09-02.png) remains evidence for the older `673726c` layout.
2. **Reader-created source:** the exact selected prose, clear idea label, and linked reader annotation/node. Capture after the user action and before agent edits.
3. **Agent action plus evidence:** the new concept/relation, separate question annotation, and observed callback/revision detail; keep source authority readable.
4. **The same pipeline on another paper:** existing [GW150914 screenshot](docs/release/evidence/public-gw150914-2026-09-02.png), labeled as an unrelated, previously rehearsed QA input at `673726c`, not a new current-release run or an unseen paper.
5. **Honest limitations:** existing [weak-text screenshot](docs/release/evidence/public-weak-text-2026-09-02.png) at `673726c`, showing a navigable page with limited text and locator-only source context. The current recording separately shows whole-page-3 Attention context, not that weak-text fixture.

These are a shot plan and identified existing evidence assets, not a claim that final Devpost images have been uploaded.

## Submission Readiness Notes

- The current `9dd6bd5` public recording observed all six tool types in 13 native callbacks on rehearsed Attention, plus exact three-digest restoration through two Undo/two Redo actions and the locator-only whole-page figure path. This is current Attention evidence, not a new cross-PDF matrix.
- The earlier `673726c` release records all six native tools on Attention and GW150914, independent PDF identities, exact graph/annotation Undo/Redo digests, a weak-text fallback, and safe foreign-source/non-PDF rejection. Attention and GW are rehearsed inputs through the shared arbitrary-PDF pipeline, not newly discovered papers.
- The current focused verification passed **659 tests: 655 WebMCP tests plus four packaging tests**, with a clean TypeScript check. The full application suite was not rerun for this toolbar/recording update. The older release record reports 1,371 passing tests and 63/63 technical readiness controls; those dated results are not reattributed to `9dd6bd5`. Its full readiness check remained red on human-review and submission controls.
- Current technical readiness is **62/63** (checker exit 1): the toolbar release is `9dd6bd5` / `a0d5…`, while the machine-readable cross-PDF proof remains bound to historical `673726c` / `d66782…`. The open codes are `release_runtime_source_changed` and `release_packaged_source_mismatch`. Current focused tests and the native Attention recording are valid evidence for `9dd6bd5`, but do not close that broader release-proof gap.
- Human review remains pending: actual screen-reader/keyboard acceptance, literal 200% browser zoom, forced-colors and reduced-motion inspection, and access from another physical machine. Automated controls and CSS reflow tests do not substitute for those observations.
- **TODO:** confirm the submitter/country/organization answers, additional AI tools, personal learning rating, and career answer. Do not infer them from the authenticated account name. Provide residence information directly to the official form rather than adding private personal details to the public repository.
- **TODO:** confirm successful encoding and review the actual video, complete YouTube sign-in/publication, provide its public URL, review the complete text/fields as the participant, and obtain explicit action-time submission confirmation. Preparation does not mark checklist item 12 complete or move the project into a submitted state.
- The current official field set does not request a Codex session ID; none is collected or invented here.

## Known Limitations

The public slice is a single-paper, browser-local prototype. Text extraction and reading order vary across PDFs; weak-text pages can remain useful as described regions without invented transcription. Structural coverage does not establish semantic completeness, and an agent-created graph is not scientific verification.

Figures and equations can be located, described by the reader, and discussed with clearly labeled mentor interpretation, but current WebMCP region receipts do not verify that the agent observed pixels. There is no OCR service, cross-paper synthesis, account synchronization, server-side mentor model, or annotated-PDF export in the judged slice.

Native tool behavior was recorded in the OpenAI Codex In-app Browser on Windows. Exact client build strings were unavailable. Chrome is an intended compatible environment under the event requirements, not a tested-client result supplied by the current proof. The final human accessibility and other-machine checks remain unfinished.

## TODO Official Form Fields

This map uses the official field IDs and choices reported by the authenticated event check. It is a draft for review, not a submitted form. Core project title/description/video content above is separate from these custom questions.

| Field ID | Official field | Draft answer / status |
| --- | --- | --- |
| `28249` | SubmitterType — `Individual`, `Team of Individuals`, or `Organization` | **TODO: participant confirms one exact choice.** |
| `28250` | Countries | **TODO: participant supplies the applicable country/countries privately for the official form.** |
| `28251` | Organization, optional | **TODO: confirm whether applicable; otherwise leave blank.** |
| `28252` | AppStatus — `New` or `Existing` | **Existing.** PaperPilot predates this challenge; the new work is disclosed below. |
| `28253` | Explanation of changes to an existing app | Use the draft paragraph immediately below this table. |
| `28254` | Live application URL | `https://patrickjcraig.github.io/PaperPilot/webmcp/` |
| `28255` | Testing instructions, optional | Use the Testing Instructions section above; no account or credentials are required. |
| `28256` | Repository URL | `https://github.com/patrickjcraig/PaperPilot` — public, MIT. |
| `28257` | Tested clients | OpenAI Codex In-app Browser WebMCP on Windows, recorded September 2, 2026, including the current `9dd6bd5` public Attention run. Exact build strings were not exposed. Do not add Chrome without actual testing. |
| `28258` | AI tools used | OpenAI Codex for guided planning, implementation, tests, independent reviews, and browser verification; a compatible WebMCP browser agent for the in-app mentor. **TODO: participant confirms any additional tools. No exact model identifier is asserted.** |
| `28259` | Learning — `None`, `Moderate`, or `Significant` | **TODO: participant's own answer.** |
| `28260` | Career interest — `Yes` or `No` | **TODO: participant's own answer.** |

**Draft existing-app change explanation (`28253`):**

PaperPilot already had research-discovery, project/import, and authenticated-service foundations. For The WebMCP Challenge, the work was refocused into an anonymous, paper-first learning workspace: a continuous real PDF, reader-originated spatial annotations, an automatic structural map, a Graphology/Sigma knowledge graph with a DOM outline, and six native WebMCP tools for source/graph reading, search, navigation, explanation staging, and reversible graph/annotation edits. The challenge work also added claim-level mentor provenance, immutable source anchors, revision-guarded commands, human-only Undo/Redo, opt-in exact-PDF browser recovery, and cross-PDF release evidence. The older discovery, Zotero/crawler, and service foundations are not represented as new challenge work or as the deployed backend for this public slice. Dated implementation commits and limitations are linked in the repository's change disclosure and release proof.

**Before external submission:** resolve every remaining TODO, review the final form and video as the participant, and confirm the actual posting action. Until then, this file remains a local draft.
