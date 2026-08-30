# PaperPilot judge guide

PaperPilot is an accessibility-first scientific reading workspace. Its WebMCP Challenge experience lets a reader upload a previously unseen admitted PDF, point at difficult text or visual material, and ask a browser agent for a supportive research-mentor explanation. PaperPilot keeps the answer beside the source and exposes an evidence trail that separates document evidence, image-derived context, mentor knowledge, external sources, observed WebMCP callbacks, and the reader's own save or discard decision.

The canonical product contract is the guided [Scope](hackathon-build/scope.md) and [PRD](hackathon-build/prd.md). This guide describes the judge-facing proof of that contract.

## Readiness note

The public exact-text vertical slice is implemented at <https://patrickjcraig.github.io/PaperPilot/webmcp/>. It loads an arbitrary born-digital PDF in the browser, freezes a bounded passage, registers `paperpilot.read_sources` and `paperpilot.stage_explanation`, stages an unsaved mentor proposal, and shows page-observed callback provenance. The credentialed Supabase service, figure/region/synthesis modes, complete failure matrix, screen-reader verification, and final submission evidence still require implementation or verification. [DEVPOST-COMPLIANCE.md](DEVPOST-COMPLIANCE.md) and the fail-closed `npm run devpost:check` verdict remain authoritative.

## Supported PDF contract

The judged path is paper-agnostic:

- The user chooses a syntactically valid, non-encrypted scientific PDF within the published byte and page limits.
- The product renders every admitted page without recognizing the paper or branching on its title, authors, identifier, or contents.
- Each page exposes its strongest honest interaction mode: exact embedded-text selection, rendered visual-region selection, or unavailable.
- OCR- or vision-derived wording is labeled **Derived from page image** and never receives exact-document-text authority.
- Corrupt, encrypted, oversized, unsupported, and non-renderable inputs fail with a specific reason. PaperPilot never substitutes another document.

A paper may be rehearsed for timing, but the same implementation must work with replaceable, previously unseen admitted PDFs. Public claims must not say that every PDF, text layer, or figure is supported perfectly.

## Supported WebMCP clients

Only clients and versions recorded under `judgeExperience.testedClients` in [devpost-requirements.json](../devpost-requirements.json) are claimed as tested. The current released exact-text flow was tested in **OpenAI Codex desktop 26.820.10647.0**, using its in-app browser WebMCP capability with Chromium 151.0.7922.170 on Windows, on 2026-08-30. No other client is implied.

## Current public flow under three minutes

1. Open the anonymous HTTPS demo and upload a real born-digital PDF that is not bundled with or preconfigured in PaperPilot.
2. Highlight a difficult word, equation, or passage—or use the generic first-readable-passage shortcut—and freeze the source. Inspect the page, quote digest, word count, and bounded sharing prompt before any tool reads it.
3. Ask the browser agent to use PaperPilot. Show **2 tools ready for your mentor**, then the PaperPilot-observed **WebMCP read callback observed** and **WebMCP stage callback observed** events.
4. Review the structured mentor response beside the frozen paper source. Distinguish the paper connection, mentor background knowledge, external sources, and limitations.
5. Show that WebMCP exposes no Save, Discard, Approve, or Verify action. The reader may add a separately labeled **My takeaway** and use the ordinary **Save to this browser** or **Discard proposal** UI.
6. Download the JSON provenance receipt and close on the public repository, MIT license, release URL, and the next slice.

The extended product target still includes whole-figure and rectangular-region explanations, bounded same-paper synthesis, durable authenticated notes, refresh/reopen proof, and nonvisual figure access. Those modes must not be shown or described as released until their separate evidence gates pass.

## Required WebMCP behavior

The public Reader registers actual tools through `document.modelContext.registerTool`. The released names are `paperpilot.read_sources` and `paperpilot.stage_explanation`, with two closed capabilities:

- **Read the bounded active PDF source** — return only the frozen text selection, rendered page/figure/region, or visible same-paper source set and its provenance. Do not expose the rest of the library or another user's content.
- **Stage one structured mentor explanation** — accept one validated response with the approved explanation sections, authority declarations, citations, uncertainty, and source binding for private human review.

No browser-agent tool may save, accept, discard, approve, or verify a response. Only the reader's visible **Save to this browser** or **Discard proposal** action records that human decision in the current slice; durable authenticated decisions remain future service work.

Registration is not invocation. **Tools ready** means PaperPilot made the tools available. **Selection read through WebMCP** appears only after PaperPilot observes the bounded read callback. **Explanation received through WebMCP** appears only after PaperPilot accepts a valid stage callback. PaperPilot does not claim access to the browser agent's private reasoning, discovery process, or model identity.

## What the evidence trail proves

The trail is designed to show:

- the uploaded document and exact retained text, rendered page, whole figure, or crop;
- page identity, offsets or coordinates, bounded context, caption availability, and content digests;
- whether quoted wording was exact embedded text or derived from a page image;
- which Reader WebMCP callbacks PaperPilot actually observed;
- the unchanged structured mentor proposal and client-declared external citations;
- the reader's separate **My takeaway**, when present; and
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

The current live URL works anonymously at <https://patrickjcraig.github.io/PaperPilot/webmcp/> and requires no owner session or judge credentials. Never place credentials, tokens, entrant residence, or other private form data in this repository. Any later authenticated judge path must place credentials only in Devpost's private testing-instructions field.

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

The browser-local demo at `/` is useful for exploring legacy product surfaces but is not the judged WebMCP proof path. The current proof path is the deployed `/webmcp/` slice and its recorded public callback receipts. The authenticated PostgreSQL/Supabase Reader remains the durable-service target.

## Final release record

Before submission, add the following values here and to the requirements manifest:

- Live URL: <https://patrickjcraig.github.io/PaperPilot/webmcp/>
- Public repository: <https://github.com/patrickjcraig/PaperPilot>
- Public YouTube demo: **pending**
- Release commit SHA: `c99a42dba2c4fb1c746c1146e335e665d6624c93`
- Release tag: **pending**
- Tested WebMCP client(s) and versions: **OpenAI Codex desktop 26.820.10647.0 in-app browser WebMCP capability, Chromium 151.0.7922.170, on Windows, 2026-08-30**
- Tested PDF corpus and outcomes: **one unrelated 15-page born-digital paper completed page-1 render, 212-word freeze, live read, and live stage; the required multi-PDF/visual/unsupported matrix remains pending**
- Keyboard and screen-reader verification: **pending**
- Last incognito judge-flow verification (UTC): **pending**
