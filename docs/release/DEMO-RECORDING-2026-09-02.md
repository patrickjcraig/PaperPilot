# PaperPilot public demo recording — September 2, 2026

## Release and scope

This records an **agent-operated demonstration**, not human accessibility acceptance or a Devpost submission. All footage came from one fresh, unsaved public Attention v7 workspace. Existing tabs and previously saved browser copies were preserved. No PDF bytes, local/remote database, account setting, or submission form was modified.

- Public reader: https://patrickjcraig.github.io/PaperPilot/webmcp/?release=9dd6bd5
- Source: `9dd6bd561b3fc628907e797442a252b5a8012379`
- Runtime fingerprint: `a0d5f6636b0eace96e04011526450f0942a6a797ee5d8fafda9faf2bbf8b7167`
- Successful [Pages run 33647998514](https://github.com/patrickjcraig/PaperPilot/actions/runs/33647998514), deployed at 15:22:18 UTC.
- Client: OpenAI Codex In-app Browser on Windows. Exact client/model build strings were not exposed.
- PDF SHA-256: `bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697`, 15 pages.
- Source session: approximately 15:25–15:29 UTC; 447 actual browser screenshots across eight scenes. The runtime returned JPEG images at its native 1265 × 712 resolution, despite the initial capture filenames ending in `.png`.

The release query is a cache qualifier, **not an immutable hosting pin**. The loaded public script URLs were checked against the fingerprint above before capture. The broader cross-PDF matrix at source `673726c` remains historical evidence; it has not been relabeled as a new complete matrix for this toolbar-only release.

## Requested reader layout

The existing annotation form now appears directly above `#paper-stage`, inside the central paper panel. **Highlight text**, **Mark a region**, **Use whole page**, **Cancel selection**, the idea label/type, and conditional region description retain their existing IDs, semantics and handlers. The desktop grid is compact and reflows to one column on narrow screens. The frontend-design skill informed this restrained rearrangement, not a visual redesign or a transcript return.

Verification on this change: 655 WebMCP tests plus four packaging tests (**659 combined**), the WebMCP TypeScript gate, focused ESLint, package generation and whitespace checks passed. Local browser checks confirmed form-before-PDF order, 320-CSS-pixel reflow without horizontal overflow, and Escape returning focus to **Mark a region**. A native source read succeeded. The no-local-database guard remained frozen. The root service's full test suite and Next build were not rerun for this small UI change.

## What actually happened in the recording

1. Opened the explicit demo button and rendered the actual Attention paper. The structural map reported 15/15 navigable pages; automatic semantic suggestions remained partial and unreviewed.
2. Used real page scrolling and navigation. A pointer selection on page 4 created **Why scale attention scores?** as a reader-authored concept and annotation at revision 2.
3. The exact committed fragment was `To counteract this effect, we scale the dot product`. It ends before the final letter and formula. The agent's concept summary and explanation explicitly disclosed this incomplete boundary; they did not silently repair the source or claim the selection established the denominator.
4. The agent searched that issued reader node, created **Scaling the attention dot products** and a source-backed `evidenced_by` edge, then added a separate mentor-question annotation. Graph and annotation mutations returned `applied_reversible` at revisions 3 and 4.
5. Native source navigation returned to the same page-4 anchor. Fresh bounded reads preceded the seven-section, authority-labeled explanation, which returned `staged` and remained unsaved. The visible mentor source button also returned to the paper.
6. Two visible UI Undo actions restored all three revision-2 semantic digests; two Redo actions restored all three revision-4 digests. The original reader annotation survived and the audit history advanced to revision 8.
7. Created **Figure 1 — whole-page context** on page 3 through **Use whole page**, Enter confirmation and a nonvisual description. This was explicitly a whole-page locator, not a tight figure crop or a complete diagram description. Native `read_focus` reported `visual_region`, `locator_only`, and `pixelUseVerified: false` at revision 9.
8. Showed Evidence, returned through the agent node to page 4, and ended in Annotations. Browser warning/error diagnostics were empty. No Save, Clear, Discard, PDF export or original-document write occurred.

The capture contains real UI operations and actual page callbacks. Two locator-name changes required refreshing the accessible snapshot before continuing; these were browser-automation targeting retries, not failed WebMCP mutations or fabricated success. The application's cursor visualizes observed callback effects, not hidden model reasoning. UI events labeled “Human” mean the reader-side control path; here that path was operated by the demonstration agent, not a human acceptance tester.

## Native callback receipts

All six tool types were observed in **13 successful native calls**, in this order:

| Tool | Result | Callback receipt suffix |
| --- | --- | --- |
| `read_focus` | `ready`, reader baseline | `a61ddca7-dd08-4d74-9c96-ed8d0a0f04b0` |
| `read_graph` | `ready`, literal reader-node search | `54204b1f-d710-4594-9144-6cc32505ec76` |
| `apply_graph` | `applied_reversible`, 2 → 3 | `bd435004-c4d2-4f34-b25b-89ee9600eb94` |
| `read_focus` | `ready` | `fb99e8ef-6200-47f6-9b17-1b1e41a34eda` |
| `apply_annotation` | `applied_reversible`, 3 → 4 | `51c1ce72-3f3a-426f-b1b9-dfc87e3ec490` |
| `focus_source` | `focused`, page 4 | `c3f420dd-41b4-4f6b-8a70-d17687ecd514` |
| `read_focus` | `ready` | `17d0a880-28cd-4de9-bea5-86c68b280c6f` |
| `read_graph` | `ready`, bounded neighborhood | `eb62c4e8-5419-4377-978d-ec06a91b81e4` |
| `stage_explain` | `staged` | `2ec9b546-4886-481c-9370-414b95356fba` |
| `read_focus` | `ready`, exact Undo baseline | `0f3e16c1-b055-46f0-b7ac-727a74ef2a50` |
| `read_focus` | `ready`, exact Redo state | `8fc66041-7633-427e-b94a-894e622f02a0` |
| `read_focus` | `ready`, locator-only page 3 | `0cb67a66-0b59-448c-87c6-6687f19e7a90` |
| `focus_source` | `focused`, final page-4 return | `3e395317-2d82-45f3-b4ba-a7b0a3c1c3af` |

Each suffix is prefixed by `callback:` in the actual receipt. The source anchor was `anchor:reader:c85ef18e-1f73-4d4f-a345-c2fb17d9f815`; its digest was `c18c759754ec739558933a0fa2894b0ac6d4066112255b4b463d654c9bc24340`. The new agent concept was `node:agent:1b2d5120-48f4-4df5-b114-eed53b302fb0`.

| Digest | Reader baseline / after two Undo | Agent changes / after two Redo |
| --- | --- | --- |
| Workspace | `0ec570c01e4e48e738bf0b0bc8175974927d42e892653287959008288c449fad` | `7fd9306292b5c51543719c73178d594f80e8de65f7b27a3d07b8e53cdda469c5` |
| Graph | `9fa0c1dce13db34889e7376a05448a0102a195f110e50be2b8a47a731b435389` | `2ce2cbd6a303f167623ad80da11b84512754939048ed18d81b7c09be517f14bf` |
| Annotations | `d5c26d1dcf81d23e98d8a8e16251b158ea29ac98bd5017b1ad0119b95fd8a1e6` | `7c6c5202480a5292f7f5710f516ceb01c7f03c9a2eb4c1748cefe141cb119aa4` |

## Media production and publication boundary

The assembler uses only captured frames in chronological order. It compresses each scene's timing when necessary and otherwise holds its last actual frame. All eight narration clips use the generic **Microsoft Zira Desktop** synthetic voice, not a cloned voice. Speech is not truncated. Phrase captions accompany the narration, and a permanent footer states **Edited live capture · timing compressed · synthetic narration**. The planned output is 150 seconds with native image pixels, a one-pixel right pad required by H.264 chroma alignment, and a separate 100-pixel caption footer; no paper pixels are cropped or redrawn.

The portable encoder was obtained from the [Windows build linked by FFmpeg](https://ffmpeg.org/download.html) at [Gyan's release builds](https://www.gyan.dev/ffmpeg/builds/). Its archive SHA-256, checked before extraction/execution, was `fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9`. Tools, capture frames and temporary audio remain in ignored workspace-local `tmp/` on E:, not on the full C: drive. No software was installed globally.

The [finished MP4](../demo/PaperPilot-WebMCP-demo.mp4) is **150.000 seconds**, **6,132,064 bytes**, **1266 × 812**, **24 fps**, H.264 `yuv420p` with limited-range color and AAC 48 kHz mono audio. The [separate SRT](../demo/PaperPilot-WebMCP-demo.srt), [sanitized verification record](../demo/recording-verification.json), and [scene timeline](../demo/timeline.json) accompany it. The video SHA-256 is `49501c8cc61a692272823cdeb46df621717f444fdccbd72f01c6eac70c302a05`; the SRT SHA-256 is `246975f175631df4cd534b75cf40ebd2069d5457224a49c2e2e759521c439df2`. Full decode-to-null passed. Representative frames were inspected for actual source/UI content, readable captions and the disclosure. Captions use approximate phrase timing, not forced-aligned word timing. Nine assembler regressions and focused lint passed. No end-to-end human listening/accessibility review is claimed.

The initial encode retained JPEG full-range pixel-format metadata; verification rejected that output. The final encode explicitly converts color range at unchanged dimensions for conventional H.264 playback, and passed stream verification. Original screenshots were preserved throughout.

The current technical checker remains **62/63**, exit 1: `release_packaged_source_mismatch` and `release_runtime_source_changed` identify the historical `673726c` cross-PDF proof versus the new toolbar runtime. Do not replace that proof's hashes without fresh corresponding evidence. This new Attention demonstration does not by itself renew the GW150914/weak-text/invalid-input matrix.

A public YouTube URL, participant-owned official form answers, final human accessibility/access checks, the broader current-release proof refresh, and explicit action-time Devpost confirmation remain pending. Both available browsers were signed out of YouTube; a Chrome sign-in tab was left for the participant. The authenticated Devpost project `1399992` was still an empty pre-draft with `submitted_at: null`; recording and preparation do not change that status.
