# Devpost compliance requirements

This document is a fail-closed release gate for PaperPilot's entry in [The WebMCP Challenge](https://webmcp.devpost.com/). A row is complete only when its evidence can be reproduced by a judge. The public page now runs the six-tool graph/annotation reader; the August 30 two-tool record remains historical evidence only.

The canonical machine-readable requirements are in [`devpost-requirements.json`](../devpost-requirements.json). Run `npm run devpost:check -- --phase technical` for the public artifact and reproduced technical evidence, and `npm run devpost:check` for the complete submission gate. The full gate remains red while human accessibility/access review, video, handoff, submission and freeze evidence are incomplete. A technical pass does not waive those requirements or certify accessibility. A failing check is an honest readiness signal and must not be bypassed by weakening the checker.

## Current technical checkpoint

The reproduced source is `673726c0f00756bdbfa57a4c1c72ab3d61062d4a`, runtime fingerprint `d66782d3e9a1d6c723f93374b3d622268801a489337245218f17cace2c1b7ace`, deployed by [Pages run 33640830540](https://github.com/patrickjcraig/PaperPilot/actions/runs/33640830540). The fresh public Attention/GW150914/weak-text/unsupported-input matrix passed. This checkpoint fixes source navigation after Undo/Redo and first/last-word reads with empty surrounding quote context. Current automated verification totals **1,371 passing tests**: 701 root, 652 WebMCP, four packaging and 14 readiness tests. The [release proof index](release/PUBLIC-RELEASE-PROOF-2026-09-02.md) consolidates exact artifact/origin/date evidence. The earlier [hardening record at `274c739`](release/RECOVERY-ACCESSIBILITY-HARDENING-2026-09-02.md) retains its original test counts and public receipts; those are historical evidence for that source, not relabeled as the follow-up artifact.

The tested client is Codex desktop In-app Browser on Windows, 2026-09-02. Its browser/model build strings were not surfaced and are not invented; exact versions in the historical August 30 record are not carried forward. Human screen-reader, literal 200% browser zoom, forced-colors/reduced-motion inspection and another-machine review remain pending. The current matrix repeats previously used PDFs through the same arbitrary-PDF pipeline; it does not claim newly unseen papers. Earlier/local tests retain their actual origin and release.

## Event boundary

- Event: The WebMCP Challenge
- Submission deadline: 2026-09-03 20:00 UTC (2026-09-03 13:00 PT)
- Judging ends: 2026-09-22 00:00 UTC (2026-09-21 17:00 PT)
- Official event page: <https://webmcp.devpost.com/>
- Official rules: <https://webmcp.devpost.com/rules>
- Project status: **Existing app with new WebMCP work.** Never describe the entire pre-existing PaperPilot service as challenge-window work.

## Required controls

| ID | Requirement | Repository/release evidence | Current state |
| --- | --- | --- | --- |
| DVP-01 | Entrant registration and official-rule acknowledgment are complete. | Local guided workflow state; entrant identity remains private. | Complete |
| DVP-02 | A working live URL is available to judges. | Manifest URL, judge guide, and clean anonymous check. | Fresh public source/fingerprint and matrix verified at `673726c`; another-machine human inspection remains pending |
| DVP-03 | The redesigned Reader registers and actually receives WebMCP callbacks for bounded spatial-focus read, bounded graph read, graph/PDF navigation, graph-aware explanation staging, reversible graph mutation, and reversible annotation mutation. Registration alone is insufficient. | [Current public receipts](release/public-release-proof.json) and [release index](release/PUBLIC-RELEASE-PROOF-2026-09-02.md). | Technical proof recorded: all six native capabilities invoked on both public Attention and GW150914 with visible source/edit effects; final video remains separate |
| DVP-04 | A public supported repository exposes source and setup instructions. | Repository URL and anonymous verification. | Complete for current repository; recheck final commit |
| DVP-05 | A root open-source license is visible and machine-detectable. | Root `LICENSE`, manifest SPDX `MIT`, repository-home check. | Complete; recheck final commit |
| DVP-06 | A clean checkout can install, build, test, and serve the judged artifact. | Lockfile, `webmcp:pages:build`/`webmcp:pages:serve`, CI and [release index](release/PUBLIC-RELEASE-PROOF-2026-09-02.md). | Public artifact CI uses a clean checkout and pinned installation; root regression results are separately recorded, and the item-11 index records the final reproducibility run |
| DVP-07 | The submission honestly explains the literacy problem, centered PDF/no transcript, spatial annotations, automatic whole-paper structural map, graph-aware mentor, graph ↔ paper navigation, reversible agent mutation, human Undo/Redo, accessibility, provenance boundaries, and no PDF export. | Submission, Scope/PRD/Spec, judge guide, video, release proof. | Repository narrative and technical proof reconciled; final video/submission wording and human acceptance remain open |
| DVP-08 | A public YouTube demo is under three minutes and includes explanatory audio. | Video URL and measured duration/audio verification. | Open |
| DVP-09 | Every claimed WebMCP client/version is named and actually tested against the released candidate. | Manifest client tuples and dated client recordings. | Six-tool Codex In-app Browser/Windows run recorded on 2026-09-02; unavailable browser/model build strings are not claimed, and historical versions stay historical |
| DVP-10 | New work after 2026-08-25 is distinct from the pre-existing app. | [`HACKATHON-CHANGELOG.md`](HACKATHON-CHANGELOG.md), dated public commits and versioned release records. | Existing-app boundary retained; redesigned source checkpoints through `673726c` are recorded, not attributed to the pre-existing service |
| DVP-11 | Third-party services/libraries and AI assistance are disclosed accurately. | README, submission answers, lockfile, licenses/attribution. | Partial |
| DVP-12 | Judges can use the released slice without hidden setup; credentials, if any, are delivered only through Devpost's private field. | Judge guide and clean access check. | Public six-tool reader needs no account, database or model-server secret; another-machine inspection remains pending |
| DVP-13 | An immutable release record and post-deadline freeze protect the judged artifact. | Release commit/tag, deployment binding, freeze checklist. | Source/fingerprint/Pages binding recorded; final freeze remains open |
| DVP-14 | The Devpost entry is submitted, not left as a draft. | Human final-site confirmation. | Open |
| DVP-15 | Previously unseen admitted PDFs work without paper-specific logic; unsupported inputs fail explicitly with no substituted content. | [Release matrix](release/PUBLIC-RELEASE-PROOF-2026-09-02.md), generated PDF fixtures and versioned local/public records. | Fresh public Attention 15/15, GW150914 16/16, weak-text 4/4 with three limited pages, and non-PDF rejection/retry passed through the shared pipeline; these are known fixtures, not a new unseen-paper evaluation |
| DVP-16 | Spatial exact text, page regions, whole figures, and figure regions are first-class page-bound sources. Exact versus rendered-view authority and actual visual evidence mode are visible. | [Spatial-anchor proof](release/SPATIAL-ANCHOR-ACCEPTANCE-2026-08-31.md), [mentor region proof](release/MENTOR-PROVENANCE-ACCEPTANCE-2026-09-02.md) and current geometry tests. | Technical text/page/region interaction and source reopening recorded; whole figures use reader-selected regions, `locator_only`, not automatic detection or verified pixel use |
| DVP-17 | Activity language never exceeds observed facts: registration, focus read, graph read, source focus, explanation stage, graph/annotation apply/reject, human Undo, human Redo, Save, and Discard appear only after their events. | [Integration proof](release/WEBMCP-INTEGRATION-ACCEPTANCE-2026-09-02.md), [mentor proof](release/MENTOR-PROVENANCE-ACCEPTANCE-2026-09-02.md) and hardening receipts/tests. | Technical callback/revision/decision evidence recorded; failed or cancelled callbacks do not create false success, and registration is not invocation |
| DVP-18 | The primary flow is keyboard/screen-reader operable, including PDF controls, annotation list, accessible graph outline, mentor, mutation notices, Undo/Redo, source navigation, evidence, and explanation decisions. | Dated keyboard/NVDA/client-version walkthrough. | Open for human acceptance: native keyboard/reflow and automated focus/name checks passed; actual screen-reader, literal 200% zoom and forced-colors/reduced-motion inspection remain pending |
| DVP-19 | Every non-WebMCP path persistently says **Local review—WebMCP was not invoked** and never counts as native proof. | Released fallback behavior and saved-state checks, [integration proof](release/WEBMCP-INTEGRATION-ACCEPTANCE-2026-09-02.md). | Local Reader-only use does not fabricate native calls or a mentor reply; no alternate locally generated mentor-review path ships. Any such future review path must carry the exact label |
| DVP-20 | Every admitted paper receives honest whole-paper structural coverage. Semantic meaning remains separately labeled, every navigable structural node has a source range, and Graphology/Sigma has an equivalent accessible outline. | [Structural-map proof](release/STRUCTURAL-MAP-ACCEPTANCE-2026-09-01.md), [graph interaction proof](release/GRAPH-INTERACTION-ACCEPTANCE-2026-09-01.md) and current tests. | Technical coverage, source anchors and outline equivalence recorded; structural readiness does not certify semantic completeness or human accessibility acceptance |
| DVP-21 | Agent graph and annotation batches validate atomically against workspace revision/digests, retain trusted inverses, use reversible tombstones, and support human-only Undo/Redo. Divergent edits invalidate Redo. | [Reducer proof](release/WORKSPACE-REDUCER-ACCEPTANCE-2026-09-01.md), current public receipts and regression tests. | Technical proof recorded: source-bound graph/annotation edits and exact Undo/Redo digest round-trips, with stale/replay/branch/rollback tests |
| DVP-22 | The actual PDF is the dominant middle surface, no persistent visible transcript exists, original PDF bytes remain immutable, and no PDF writer or annotated-PDF export ships. | Layout/geometry checks, safe packaging and [current hardening proof](release/RECOVERY-ACCESSIBILITY-HARDENING-2026-09-02.md). | Technical layout/no-transcript/no-export checks passed; separate human accessibility inspection remains open |
| DVP-23 | Current reads, navigation, graph mutations, and annotation mutations reject foreign-paper keys/anchors before disclosure or state change. | [Integration proof](release/WEBMCP-INTEGRATION-ACCEPTANCE-2026-09-02.md), current hardening retry/isolation record and adversarial tests. | Technical rejection proof recorded with actual foreign issued anchors and unchanged workspace state; cross-paper graph UI is not offered |

## Hard release gates

PaperPilot is not submission-ready until all of the following are true:

1. `npm run devpost:check` exits successfully without ignored failures.
2. Clean-install tests, lint, typecheck, and production build pass from the exact release commit, including `typecheck:webmcp`, both `test:webmcp:contracts` and `test:webmcp:pages`, and `webmcp:pages:build` for the actual public artifact.
3. The final tool/capability suite registers and is autonomously called in a recorded supported client for focus read, graph read, source navigation, explanation, graph mutation, and annotation mutation.
4. Two unrelated previously unseen born-digital PDFs render centrally across multiple pages with no transcript and honest automatic structural maps; no paper-specific code/config changes occur between them.
5. Text, page, figure, and figure-region actions create immutable PDF-space anchors and visible/accessibly described overlays that reopen the same source.
6. Graphology canonical data, Sigma projection, and accessible DOM outline expose the same typed/authority-labeled graph; graph → PDF and annotation → graph navigation are correct.
7. A real agent adds/updates/connects/tombstones grounded graph content and changes an issued annotation through revision/digest-checked atomic commands with trusted inverses.
8. Human Undo and Redo reproduce the expected semantic workspace digests, retain the original events, and are absent from the agent tool list; a divergent edit clears Redo.
9. Evidence distinguishes automatic structure, source anchors, rendered-view evidence mode, paper grounding, mentor background, external citations, observed callbacks, revision/inverse, Undo/Redo, and explanation Save/Discard without claiming hidden reasoning or scientific truth. Current figures/regions remain `locator_only` with `pixelUseVerified: false`; reader descriptions and mentor interpretations are not pixel proof.
10. No PDF writer/export path exists; original bytes are unchanged; foreign-paper references fail closed without information disclosure or mutation.
11. A weak-text/partial or unsupported PDF displays exact limitations and never receives fabricated text, semantic completeness, or substituted content.
12. The complete primary journey passes keyboard-only, screen-reader, 200% zoom, 320 CSS-pixel reflow, contrast/non-color, and reduced-motion checks.
13. The public URL works anonymously on another machine, the repository/license/setup are visible, and the deployed bytes bind to the immutable release commit.
14. The public video is under three minutes, includes explanatory audio, and shows the live product and observed WebMCP activity rather than only slides or mocks.
15. The new-work disclosure, third-party/AI disclosures, release proof, demo, judge guide, and manifest all describe the same reproduced scope.
16. A human confirms final Devpost submission and freezes the judged artifacts through the end of judging.

## Privacy boundary

Do not commit entrant residence, submitter classification, passwords, API tokens, judge-only credentials, private PDFs, or private Devpost fields. `devpost-requirements.json` records only the names of private submission fields. Sanitized receipts contain no source document text beyond intentionally demonstrated public material.

The public reader writes no local database or server record. Explicit human Save may write a bounded, exact-PDF-SHA-qualified v3 browser snapshot without PDF bytes; this is not authenticated durability or cross-device synchronization. Ordinary load/migration/Save preserves legacy copies. Only a separately confirmed current-paper Clear removes known saved versions, never the active workspace or an unrelated paper.

## Evidence cadence

After each material challenge change:

1. Append a dated entry to [`HACKATHON-CHANGELOG.md`](HACKATHON-CHANGELOG.md).
2. Run focused tests and preserve red results honestly.
3. Run `npm run devpost:check`; never weaken a gate to obtain green.
4. Commit in the PaperPilot-local public repository with a capability-specific message.
5. Change a manual manifest flag only after recording URL, commit, date, exact client/assistive technology versions, and reproducible evidence.

## Release-freeze checklist

- Record final commit/tag, deployed HTTPS URL, and anonymous access time.
- Run the unrelated born-digital, figure-rich, weak/partial, and unsupported PDF matrix with no code/config changes.
- Record centered multi-page/no-transcript behavior and total structural coverage states.
- Record spatial text/region anchors, graph/outline equivalence, graph ↔ source navigation, and the actual figure evidence mode.
- Record every required WebMCP callback, including rejected stale/foreign/invalid requests.
- Record agent graph/annotation revisions, trusted inverses, tombstones, human Undo/Redo, and divergent-Redo behavior.
- Verify the original PDF digest is unchanged and no PDF writer/export UI, endpoint, command, or tool ships.
- Complete keyboard/NVDA, 200%, 320px, contrast, and reduced-motion walkthroughs.
- Verify **Local review—WebMCP was not invoked** persists everywhere applicable and is excluded from native proof.
- Scan sanitized evidence for credentials, cookies, private paper text, storage paths, hidden prompts, and hidden reasoning.
- Confirm public repository, MIT license, setup, video, disclosures, and Devpost submitted state without an owner session.
- Freeze deployment and repository through 2026-09-22 00:00 UTC unless official rules explicitly permit a change.
