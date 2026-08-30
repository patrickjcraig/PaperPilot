# Devpost compliance requirements

This document is a release gate for PaperPilot's entry in [The WebMCP Challenge](https://webmcp.devpost.com/). It is not promotional copy. A row is complete only when its evidence can be reproduced by a judge or reviewer.

The canonical machine-readable requirements are in [`devpost-requirements.json`](../devpost-requirements.json). Run `npm run devpost:check` from the PaperPilot repository root for the current automated verdict. A failing check is an honest readiness signal and must not be bypassed by weakening the checker.

## Event boundary

- Event: The WebMCP Challenge
- Submission deadline: 2026-09-03 20:00 UTC (2026-09-03 13:00 PT)
- Judging ends: 2026-09-22 00:00 UTC (2026-09-21 17:00 PT)
- Official event page: <https://webmcp.devpost.com/>
- Official rules: <https://webmcp.devpost.com/rules>
- Project status: **Existing app with new WebMCP work.** Never describe the entire pre-existing PaperPilot service as work created during the submission window.

## Required controls

| ID | Requirement | Repository evidence | Current state |
| --- | --- | --- | --- |
| DVP-01 | The entrant is registered and has acknowledged the official rules. | Local Devpost workflow state; keep entrant identity out of the public repository. | Complete |
| DVP-02 | A working live URL is available to judges. | `publicArtifacts.liveUrl`, judge guide, and an incognito access check. | Open |
| DVP-03 | The judged Reader uses actual WebMCP tools registered with `document.modelContext.registerTool` to read one frozen, bounded paper source or visible same-paper source set and stage one structured mentor explanation for private human review. Registration alone is insufficient. | Released Reader integration, actual source-read and explanation-stage callback evidence, visible activity trail, supported-client verification, and the recorded demo. | Partial: earlier contract and adapter work exist; canonical Reader integration and released callback evidence remain open |
| DVP-04 | A public GitHub, GitLab, or Bitbucket repository exposes the source and setup instructions. | `publicArtifacts.repositoryUrl` plus an incognito verification. | Complete: the public repository and raw README both returned HTTP 200 without GitHub credentials on 2026-08-29 |
| DVP-05 | An open-source license is detectable at the repository root. | Root `LICENSE`, an SPDX identifier in the manifest, and repository-home verification. | Blocked: the owner must choose the license because licensing is a rights grant |
| DVP-06 | A clean checkout can install and run the project. | README commands, committed lockfile, and a clean-checkout smoke test. | Partial |
| DVP-07 | The submission explains the scientific-literacy problem, admitted-PDF workflow, text-and-figure interaction, WebMCP read/stage cycle, accessibility work, evidence boundaries, and post-2026-08-25 new work honestly. | Devpost draft, judge guide, dated change disclosure, canonical Scope/PRD, and recorded product evidence. | Partial |
| DVP-08 | A public YouTube demo is under three minutes and has explanatory audio. | `publicArtifacts.demoVideoUrl` and manual duration/audio verification. | Open |
| DVP-09 | The supported WebMCP clients are named and actually tested. | `judgeExperience.testedClients`, `submissionAnswers.webMcpClients`, and dated test notes. | Open |
| DVP-10 | New work after 2026-08-25 is distinguishable from the existing application. | [`HACKATHON-CHANGELOG.md`](HACKATHON-CHANGELOG.md) and public dated commits. | Partial: the dated disclosure is bound to the initial public import; subsequent material work must receive dedicated public commits |
| DVP-11 | Third-party services and AI assistance are disclosed accurately. | README, submission answers, and applicable terms/attribution. | Partial |
| DVP-12 | Judges can use the app without hidden setup; any credentials are delivered only through Devpost's private field. | Judge guide plus incognito or judge-credential verification. | Open |
| DVP-13 | A post-deadline release freeze protects the judged artifact through the judging period. | Immutable release tag, recorded deployment commit, and freeze checklist. | Open |
| DVP-14 | The Devpost entry is fully submitted, not left as a draft. | Final submission review and manifest checkbox. | Open |
| DVP-15 | The release supports previously unseen, user-uploaded scientific PDFs that meet published admission limits without paper-specific logic and rejects unsupported inputs with an explicit reason and no substituted content. | Verification matrix covering a born-digital paper, a different figure-rich paper, a weak-text or scanned paper, and at least one rejected PDF; record that no code or configuration changed between papers. | Open |
| DVP-16 | Exact text and visual content are equal first-class mentor surfaces. The judged release completes exact-text, whole-figure, rectangular-region, and bounded same-paper synthesis flows and labels OCR/vision wording as **Derived from page image**. | Released-flow records for all declared selection kinds, accessible descriptions, retained visual context/crops, and frozen synthesis source sets. | Open |
| DVP-17 | User-visible WebMCP activity never overclaims what PaperPilot observed. **Tools ready**, **Selection read through WebMCP**, and **Explanation received through WebMCP** appear only after their corresponding observable events. | Activity recording, read-without-stage verification, registration-failure verification, and claims audit. | Open |
| DVP-18 | The primary judged flow is keyboard operable and has a documented screen-reader path, including nonvisual page/figure options, stable focus, announcements, and non-color authority distinctions. | Keyboard-only walkthrough and dated screen-reader/client/version walkthrough against the released deployment. | Open |
| DVP-19 | Every non-WebMCP review path displays **Local review—WebMCP was not invoked** in status, response, evidence trail, and any saved note and never counts as native WebMCP proof. | Released fallback screenshots/recording and verification of the persistent label. | Open |

## Hard release gates

PaperPilot is not submission-ready until all of the following are true:

1. `npm run devpost:check` exits successfully without ignored failures.
2. `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` pass from the intended release commit.
3. The public HTTPS Reader demonstrates real `document.modelContext.registerTool` registration and actual bounded source-read plus structured explanation-stage callbacks in at least one recorded supported client. Registration alone, a product fixture, or a local adapter test is insufficient.
4. A previously unseen admitted born-digital PDF completes upload, exact-text selection, native WebMCP read, valid explanation stage, review, save, refresh, and source reopen without paper-specific code or configuration.
5. A different figure-rich admitted PDF completes whole-figure and rectangular-region explanation with a screen-reader-friendly description, retained full visual context, selected crop, page, and caption when available.
6. A weak-text or scanned admitted PDF remains useful through rendered-region interaction, and every OCR/vision-derived wording is visibly labeled. Unsupported PDFs fail with a specific reason and never receive substituted content.
7. A visible, bounded source set from one paper completes selected-evidence synthesis without silently adding, omitting, or crossing papers.
8. The released activity trail distinguishes tool availability, observed source read, observed explanation stage, and human decision. It does not claim unobserved discovery, hidden reasoning, citation authority, or digest-based truth.
9. The primary release flow completes without pointer input and has a documented screen-reader walkthrough covering selection, nonvisual page/figure access, mentor status, explanation readiness, evidence, and save/discard.
10. Any non-WebMCP path displays **Local review—WebMCP was not invoked** throughout status, explanation, trail, and saved note. It may preserve review behavior but cannot count as WebMCP execution evidence.
11. The public repository opens in an incognito session, has a root open-source license, contains source and setup instructions, and can be built from a clean checkout.
12. The public YouTube demo is shorter than three minutes, includes explanatory audio, and shows the live product and WebMCP interaction in the opening section rather than only slides.
13. [`HACKATHON-CHANGELOG.md`](HACKATHON-CHANGELOG.md) names the pre-existing baseline and cites dated public commits for every material WebMCP addition submitted for judging.
14. Judge access is proven. Credentials, if unavoidable, are placed only in Devpost's private judge-instructions field and never committed.
15. The exact release commit and deployed URL are recorded, tagged, and frozen no later than the submission deadline. No product or repository changes are made during judging unless the official rules explicitly permit them.
16. A human confirms that the Devpost entry is submitted rather than saved as a draft.

## Privacy boundary

Do not commit entrant residence, submitter classification, passwords, API tokens, judge-only credentials, or private Devpost form data. `devpost-requirements.json` records only the names of private fields so their existence is not forgotten. The local `.devpost-hackathon-state.json` is ignored by Git.

## Evidence cadence

After each material hackathon change:

1. Add a dated entry to [`HACKATHON-CHANGELOG.md`](HACKATHON-CHANGELOG.md).
2. Run the focused tests for the changed surface.
3. Run `npm run devpost:check` and retain the failures as backlog items.
4. Commit the change in the PaperPilot-local public repository with a message that names the WebMCP capability demonstrated.
5. When a manual verification becomes true, record the tested URL, client/version, date, and evidence before changing the manifest flag.

## Release-freeze checklist

- Record the final Git commit SHA and create an immutable release tag.
- Deploy that exact commit and record the public HTTPS URL.
- Run the judge flow in a clean browser context and every declared WebMCP client.
- Run the canonical cross-PDF matrix on the deployed release: previously unseen born-digital paper, different figure-rich paper, weak-text or scanned paper, and unsupported PDF.
- Record exact-text, whole-figure, rectangular-region, same-paper synthesis, native source-read/stage, save/refresh, and source-reopen evidence.
- Complete and date the keyboard-only and screen-reader walkthroughs, including the tested assistive technology and client versions.
- Verify that **Local review—WebMCP was not invoked** persists in status, explanation, evidence trail, and saved note and is excluded from native WebMCP proof.
- Confirm the public repository, root license, setup instructions, and video without using an owner session.
- Save the final Devpost answers and confirm the entry is submitted.
- Freeze the deployment and repository through the end of judging on 2026-09-22 00:00 UTC.
