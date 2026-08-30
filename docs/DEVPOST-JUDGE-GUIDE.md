# PaperPilot judge guide

PaperPilot is an accessibility-first scientific reading workspace. Its WebMCP Challenge experience lets a reader upload a previously unseen admitted PDF, point at difficult text or visual material, and ask a browser agent for a supportive research-mentor explanation. PaperPilot keeps the answer beside the source and exposes an evidence trail that separates document evidence, image-derived context, mentor knowledge, external sources, observed WebMCP callbacks, and the reader's own save or discard decision.

The canonical product contract is the guided [Scope](hackathon-build/scope.md) and [PRD](hackathon-build/prd.md). This guide describes the judge-facing proof of that contract.

## Readiness note

This is the release target, not a claim that every step is implemented today. PaperPilot already has secure PDF intake, an authenticated Reader foundation, provenance and review primitives, and an earlier capability-detected WebMCP adapter. The final scientific-mentor Reader tools, text-and-figure selection experience, and hosted end-to-end judge flow still require implementation and release verification. [DEVPOST-COMPLIANCE.md](DEVPOST-COMPLIANCE.md) and the fail-closed `npm run devpost:check` verdict are authoritative for readiness.

## Supported PDF contract

The judged path is paper-agnostic:

- The user chooses a syntactically valid, non-encrypted scientific PDF within the published byte and page limits.
- The product renders every admitted page without recognizing the paper or branching on its title, authors, identifier, or contents.
- Each page exposes its strongest honest interaction mode: exact embedded-text selection, rendered visual-region selection, or unavailable.
- OCR- or vision-derived wording is labeled **Derived from page image** and never receives exact-document-text authority.
- Corrupt, encrypted, oversized, unsupported, and non-renderable inputs fail with a specific reason. PaperPilot never substitutes another document.

A paper may be rehearsed for timing, but the same implementation must work with replaceable, previously unseen admitted PDFs. Public claims must not say that every PDF, text layer, or figure is supported perfectly.

## Supported WebMCP clients

Only clients and versions recorded under `judgeExperience.testedClients` in [devpost-requirements.json](../devpost-requirements.json) are claimed as tested. That list remains empty until the released public HTTPS build completes the real judge flow in each declared client.

## Target flow under three minutes

1. Sign in to the public HTTPS app and upload a real PDF that is not bundled with or preconfigured in PaperPilot.
2. Open Reader, highlight a difficult term, equation, or short passage, and inspect the sharing preview. The preview identifies the paper, page, exact or derived authority, and bounded context before anything is shared.
3. Ask the browser agent to explain the selection at an undergraduate level. Show **Tools ready for your browser mentor**, then the PaperPilot-observed **Selection read through WebMCP** and **Explanation received through WebMCP** events.
4. Review the structured mentor response beside the frozen source. Open the evidence trail and distinguish what came from the paper, what was derived from the page image, what the mentor added as background, and any declared external citations.
5. On a figure-rich page, select a whole figure and then a region. Request a screen-reader-friendly description and an explanation of what the selected visual detail means.
6. Choose **Save to notes**, refresh, and reopen the note at its original text or visual source. The mentor response remains unchanged; an optional **My takeaway** remains separately labeled as reader-authored.

The extended proof also exercises **Connect ideas** with at least two visible selections from the same paper. A successful result explains a real relationship among the frozen items or says that the supplied evidence does not support one. It is never presented as whole-paper or cross-paper synthesis.

## Required WebMCP behavior

The signed-in Reader registers actual tools through `document.modelContext.registerTool`. Final names and schemas are governed by the technical Spec, but the release must provide two closed capabilities:

- **Read the bounded active PDF source** — return only the frozen text selection, rendered page/figure/region, or visible same-paper source set and its provenance. Do not expose the rest of the library or another user's content.
- **Stage one structured mentor explanation** — accept one validated response with the approved explanation sections, authority declarations, citations, uncertainty, and source binding for private human review.

No browser-agent tool may save, accept, discard, approve, or verify a response. Only the authenticated reader's visible **Save to notes** or **Discard** action records that human decision.

Registration is not invocation. **Tools ready** means PaperPilot made the tools available. **Selection read through WebMCP** appears only after PaperPilot observes the bounded read callback. **Explanation received through WebMCP** appears only after PaperPilot accepts a valid stage callback. PaperPilot does not claim access to the browser agent's private reasoning, discovery process, or model identity.

## What the evidence trail proves

The trail is designed to show:

- the uploaded document and exact retained text, rendered page, whole figure, or crop;
- page identity, offsets or coordinates, bounded context, caption availability, and content digests;
- whether quoted wording was exact embedded text or derived from a page image;
- which Reader WebMCP callbacks PaperPilot actually observed;
- the unchanged structured mentor proposal and client-declared external citations;
- the authenticated reader's separate **My takeaway**, when present; and
- the reader's explicit save or discard decision and PaperPilot receipt time.

The trail does not prove that the explanation is true, that a citation is authoritative, that a digest establishes authorship, or that an agent used the returned context correctly. Those boundaries must remain visible in the interface and demo narration.

## Accessibility proof

The primary flow must be demonstrable without a pointer:

- upload, page navigation, selection alternatives, mentor handoff, evidence inspection, follow-up, save, and discard are keyboard operable;
- source, explanation, and evidence are named regions with a stable logical reading order even when the three-column layout stacks;
- processing, selection, WebMCP activity, explanation readiness, errors, and decisions are announced without unexpected focus movement;
- **Go to explanation** moves focus only when the reader requests it;
- **Describe this page** and identified figure/caption choices provide a nonvisual route when rectangle drawing is unsuitable;
- exact, derived, mentor, external, and human authority never depend on color alone; and
- zoom, reflow, visible focus, and reduced-motion behavior preserve the complete primary journey.

The release may claim only the primary paths and assistive technologies that were actually tested. It must not imply comprehensive accessibility conformance without that evidence.

## Failure and fallback behavior

The judge flow must distinguish WebMCP unavailable, tool registration failed, source read without a returned explanation, cancellation, interruption, invalid staged response, save failure, and unsupported PDF. Each state stops at the last event PaperPilot actually observed and preserves the reader's source where recovery is possible.

If a local review path is offered, its exact persistent label is **Local review—WebMCP was not invoked**. The label must appear in status, explanation, evidence trail, and any saved note from that path. Local review may demonstrate the review interface, but it never counts as WebMCP proof and never receives native-success styling.

## Judge access

The final live URL must either work anonymously or include reliable judge credentials in Devpost's private testing-instructions field. Never place credentials, tokens, entrant residence, or other private form data in this repository. The public demonstration must not depend on the owner's existing browser session.

## Local verification

From a clean checkout with a supported Node.js release:

```bash
npm ci
npm run devpost:check
npm test
npm run typecheck
npm run lint
npm run build
```

The browser-local demo at `/` is useful for exploring legacy product surfaces but is not the judged WebMCP proof path. The release proof uses the authenticated Reader and its durable PostgreSQL-backed source, proposal, evidence, and human-decision records.

## Final release record

Before submission, add the following values here and to the requirements manifest:

- Live URL: **pending**
- Public repository: **pending**
- Public YouTube demo: **pending**
- Release commit SHA: **pending**
- Release tag: **pending**
- Tested WebMCP client(s) and versions: **pending**
- Tested PDF corpus and outcomes: **pending**
- Keyboard and screen-reader verification: **pending**
- Last incognito judge-flow verification (UTC): **pending**
