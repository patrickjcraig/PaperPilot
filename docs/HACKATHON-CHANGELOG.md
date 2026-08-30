# The WebMCP Challenge change disclosure

PaperPilot is an existing application. This log separates the pre-existing service from new work created for The WebMCP Challenge. The eligible build window begins 2026-08-25 19:00 UTC according to the event materials.

This file is a disclosure aid, not proof by itself. Filesystem timestamps are not reliable evidence of authorship or timing. Each submitted entry must ultimately cite a dated commit in a PaperPilot-local public Git repository.

## Pre-existing baseline

Before the WebMCP-focused challenge work, PaperPilot already included:

- a deterministic browser-local research demo and an authenticated PostgreSQL-backed service;
- literature discovery, projects, imports, collections, Reader, and PDF-grounded evidence workflows;
- metadata-oriented WebMCP proposal/review code that is separate from passage-level browser evidence;
- Zotero synchronization, governed single-PDF crawling, uploads, and collaboration foundations.

These capabilities may provide context for the demo, but they must not be represented as new WebMCP Challenge work.

## New challenge work

### 2026-08-29 — Scope reset to an accessible scientific-literacy WebMCP Reader

- Reprioritized the hackathon around a reader uploading a previously unseen admitted scientific PDF, selecting exact text or visual material, asking a browser research mentor for help through WebMCP, and inspecting a source → WebMCP → mentor → human evidence trail.
- Made text, equations, whole figures, figure regions, and bounded same-paper selected-evidence synthesis first-class requirements without paper-specific behavior.
- Required immutable staged mentor responses, a separate optional **My takeaway**, explicit save/discard authority, keyboard and screen-reader paths, and truthful local-review labeling.
- Deferred new crawler, Zotero, networking, collaboration, and scale expansion until the WebMCP loop is demonstrably complete.
- Added the canonical guided Scope and 30-story PRD; retained the earlier webpage-provenance scope only as a superseded architecture reference.
- Public commit: [`fe56264831f9d4fc55c83e95d593b26937d4cfd1`](https://github.com/patrickjcraig/PaperPilot/commit/fe56264831f9d4fc55c83e95d593b26937d4cfd1) (initial public import).

### 2026-08-29 — Strict capture contract and browser adapter

- Added a closed, versioned WebMCP passage-capture envelope with bounded text, canonical public HTTPS source identity, exact locators, domain-separated SHA-256 digests, and explicit authority labels.
- Added capability-detected browser registration for `paperpilot.describe_capture_contract` and `paperpilot.stage_web_evidence`.
- Added adversarial contract and adapter tests.
- Important limitation: this earlier webpage-evidence adapter is not the canonical scientific-mentor Reader integration, is not mounted by the application UI, and cannot satisfy the final PDF read/stage judge proof.
- Public commit: [`fe56264831f9d4fc55c83e95d593b26937d4cfd1`](https://github.com/patrickjcraig/PaperPilot/commit/fe56264831f9d4fc55c83e95d593b26937d4cfd1) (initial public import).

### 2026-08-29 — Devpost compliance controls

- Added a machine-readable event requirements manifest, automated readiness audit, judge guide, this dated disclosure, and a release-freeze checklist.
- Recorded the project as an existing application and made missing license, public repository, live URL, tested-client, demo-video, and final-submission evidence fail explicitly.
- Public commit: [`fe56264831f9d4fc55c83e95d593b26937d4cfd1`](https://github.com/patrickjcraig/PaperPilot/commit/fe56264831f9d4fc55c83e95d593b26937d4cfd1) (initial public import).

### 2026-08-29 — Compliance gates aligned to the approved PDF mentor

- Removed the deterministic webpage source from the judged-product requirements.
- Made the guided Scope and PRD required repository artifacts.
- Added fail-closed declarations and manual verification gates for the paper-agnostic admission contract, all five selection kinds, bounded source-read and structured mentor-stage callbacks, observable WebMCP activity, primary-flow accessibility, and truthful fallback labeling.
- Rewrote the judge guide and README challenge section around replaceable real PDFs and the accessible text/figure mentor flow.
- Verification performed: JSON/syntax/lint/readiness audit recorded during the PRD handoff.
- Public commit: [`fe56264831f9d4fc55c83e95d593b26937d4cfd1`](https://github.com/patrickjcraig/PaperPilot/commit/fe56264831f9d4fc55c83e95d593b26937d4cfd1) (initial public import).

### 2026-08-30 — Public arbitrary-PDF WebMCP mentor slice

- Added an anonymous browser-local Reader that accepts a replaceable born-digital PDF, renders page 1, extracts embedded text without paper-specific branching, and freezes one exact bounded passage with PDF, quote, and source-set SHA-256 digests.
- Registered `paperpilot.read_sources` and `paperpilot.stage_explanation` through `document.modelContext.registerTool`. The former returns only the frozen source; the latter validates and stages one structured undergraduate-level mentor proposal. No agent-callable Save, Discard, Approve, or Verify capability exists.
- Added a visible registration → source freeze → read callback → stage callback evidence trail, human-only review controls, browser-local note labeling, and downloadable JSON receipt.
- Deployed the static slice to GitHub Pages with enforced HTTPS and witnessed an actual Codex desktop in-app browser agent call both tools over the public origin using a previously unseen 15-page scientific PDF. The proposal remained unsaved for human review.
- Added a sanitized live-proof record and a timed 2:30 demo-video plan. The final YouTube recording, visual selection modes, full failure/accessibility matrix, and durable authenticated service are not claimed complete.
- Verification performed: JavaScript syntax; lint; TypeScript; root tests **701/701**; production build; `npm audit` with zero known vulnerabilities; anonymous HTTP 200 checks; successful Pages workflow; and public WebMCP read/stage callback receipts.
- Public implementation commit: [`c99a42dba2c4fb1c746c1146e335e665d6624c93`](https://github.com/patrickjcraig/PaperPilot/commit/c99a42dba2c4fb1c746c1146e335e665d6624c93).
- Public release-evidence commit: [`503cfee0ee714428dc466ce29b6a2dff85881ad8`](https://github.com/patrickjcraig/PaperPilot/commit/503cfee0ee714428dc466ce29b6a2dff85881ad8).
- Successful GitHub Pages deployment: [workflow run 33326383034](https://github.com/patrickjcraig/PaperPilot/actions/runs/33326383034).

## Entry template

Copy this block for each material addition:

```text
### YYYY-MM-DD — Capability name

- User-visible outcome:
- Actual WebMCP behavior:
- Provenance or safety boundary:
- Verification performed:
- Public commit:
- Live deployment commit (if applicable):
```

## Final disclosure check

The initial entries are bound to the public import commit above. Every subsequent material capability must receive its own dated public commit and disclosure entry. Confirm that the Devpost description and video make the same baseline/new-work distinction as this document.
