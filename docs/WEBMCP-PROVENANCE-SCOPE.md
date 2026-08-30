# PaperPilot WebMCP provenance scope

Status: superseded as the product north star by [`docs/hackathon-build/scope.md`](hackathon-build/scope.md) on 2026-08-29.

This document remains an architecture reference for the earlier webpage-passage evidence design and its custody analysis. Where it conflicts with the guided hackathon scope—especially source type, target user, arbitrary-PDF support, text-and-figure interaction, accessibility, and the judge flow—the guided scope is authoritative. Do not implement the webpage-first north-star demo from this document as the current product direction.

This document replaces broad connector expansion as PaperPilot's immediate build target. The collaboration, Zotero, crawler, upload, and production-operations work already in the repository is preserved, but new work on those tracks is deferred until the WebMCP provenance loop is demonstrably useful.

## Product decision

PaperPilot's next release proves one promise:

> Ask an agent to find the passage that matters on the webpage you are reading, inspect exactly what the agent used, and save a claim with a durable trail back to that observed text.

The first release is a browser-mediated, human-in-the-loop workflow. It is not a generalized crawler, a remote MCP server, or an autonomous literature-ingestion system.

## What WebMCP means in this release

The current WebMCP Community Group draft lets a webpage register structured tools through `document.modelContext`. A browser or in-page agent can discover those tools and invoke them with schema-checked arguments. It does not standardize arbitrary remote crawling, and it does not make every webpage's DOM a trusted data source.

PaperPilot therefore participates as a WebMCP tool provider:

- a browser agent observes a page the user has deliberately opened;
- when a source page offers a read-only WebMCP tool, the agent can use that tool to obtain a bounded passage and locator;
- otherwise, a compatible browser agent may use the text it can already observe, but that observation is labeled as agent-observed rather than publisher-attested;
- the agent calls a PaperPilot WebMCP tool to stage a closed evidence envelope;
- PaperPilot displays the envelope and its custody trail before the user can accept it; and
- only an explicit user action promotes the staged draft into durable project evidence.

The WebMCP API is still experimental. PaperPilot treats it as progressive enhancement and keeps the capture envelope independent of a single browser implementation.

Primary references:

- [WebMCP Community Group draft](https://webmachinelearning.github.io/webmcp/)
- [Chrome WebMCP documentation](https://developer.chrome.com/docs/ai/webmcp)
- [WebMCP security and privacy self-review](https://github.com/webmachinelearning/webmcp/blob/main/security-privacy-questionnaire.md)

## North-star demo

The two-minute demo is deliberately narrow:

1. The researcher opens a supported technical article and PaperPilot in the same browser session.
2. The researcher asks the browser agent: “Find the passage that supports the claimed resolution improvement and stage it in PaperPilot.”
3. The agent reads bounded source text, identifies one passage, and calls PaperPilot's `stage_web_evidence` tool.
4. PaperPilot visibly receives a pending capture. Nothing is silently filed.
5. The review docket separates:
   - exact source text;
   - the agent's proposed bounded claim;
   - the researcher's interpretation;
   - source URL/title and observation time;
   - text locators and hashes;
   - the source and PaperPilot tool calls that formed the handoff.
6. The researcher edits the interpretation, chooses a project, and accepts the capture.
7. Refreshing the app preserves the record. “Open source” uses a safe external tab, while “Copy locator” exposes the saved TextQuote selector for the user or browser agent.
8. PaperPilot never rewrites the original observation. A later agent/source-tool observation may append an explicit exact/context/moved/changed/unavailable revalidation record.

## Experience map

```text
SOURCE WEBSITE                      BROWSER AGENT                     PAPERPILOT

visible article or      observe / call source read tool     registered WebMCP tools
read-only WebMCP tool  ───────────────────────────────────▶  describe_capture_contract
        │                                                      stage_web_evidence
        │                         bounded envelope                    │
        └─────────────────────────────────────────────────────────────▶
                                                                     │
                                                           Pending capture docket
                                                                     │
                                                       human review / edit / reject
                                                                     │
                                                                     ▼
                                                       Durable evidence + provenance
                                                                     │
                                                                     ▼
                                                       reopen / revalidate / re-anchor
```

## Primary screen: Web evidence workbench

The existing Sources card becomes an active “Web evidence” entry point. It opens a workbench with three regions:

```text
┌──────────────────── Source session ────────────────────┬──────── Agent trail ────────┐
│ URL, title, observed time, capture method              │ 1  source tool observed      │
│                                                       │ 2  passage returned           │
│ Exact passage with prefix/suffix context               │ 3  PaperPilot tool called    │
│ [open source] [copy locator] [revalidate]              │ 4  awaiting human review     │
├──────────────────── Evidence draft ────────────────────┴─────────────────────────────┤
│ Agent-proposed claim                                                                │
│ Researcher interpretation                                                           │
│ Open question · confidence · destination project                                    │
│                                                                                     │
│ [Reject capture]                                      [Accept as project evidence]  │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

On narrow screens these become Source, Draft, and Trail tabs. The exact quote is visually immutable. Agent-authored and researcher-authored text are always labeled separately.

## WebMCP tool surface

### `paperpilot.describe_capture_contract`

Read-only. Returns the supported schema version, field limits, active workspace/project choices that the signed-in user may see, and the distinction between staging and approval. It returns no secrets and performs no mutation.

### `paperpilot.stage_web_evidence`

Creates a pending draft, not accepted evidence. The input is a closed `WebEvidenceCaptureEnvelopeV1`; unknown fields fail. PaperPilot assigns workspace, signed-in actor, receipt time, stage ID, server digest, and review status. The tool cannot choose another user, approve itself, claim publisher authenticity, or grant document custody.

The first implementation should register tools with the current imperative API:

```ts
await document.modelContext.registerTool({
  name: "paperpilot.stage_web_evidence",
  title: "Stage web evidence in PaperPilot",
  description: "Stage one bounded webpage passage for explicit human review.",
  inputSchema: captureEnvelopeSchema,
  annotations: {
    readOnlyHint: false,
    untrustedContentHint: true,
  },
  execute: stageWebEvidence,
});
```

Registration must be capability-detected. Browsers without WebMCP continue to show the workbench and can load the same envelope through a clearly labeled local test/import control; that fallback must not be presented as an agent invocation.

### Later tools

These are useful but not part of the first acceptance gate:

- `paperpilot.list_pending_web_evidence`
- `paperpilot.open_web_evidence`
- `paperpilot.compare_source_observation`
- `paperpilot.suggest_follow_up_question`

No WebMCP tool may accept or verify evidence on the user's behalf in the first release.

## Capture envelope v1

The browser/agent supplies observations; the server supplies authority. The command is bounded and versioned.

```ts
type WebEvidenceCaptureEnvelopeV1 = {
  schemaVersion: 1;
  clientOperationId: string;
  agent: {
    kind: "browser-integrated" | "in-page" | "extension" | "unknown";
    runId: string;
    providerLabel?: string;
    assertionAuthority: "client-asserted";
  };
  source: {
    url: string;
    title: string;
    observedAt: string;
    language?: string;
    captureMethod: "source-webmcp-tool" | "browser-agent-observation";
    sourceTool?: {
      origin: string;
      name: string;
      schemaVersion?: string;
      invocationId: string;
      invokedAt: string;
      input: JsonValue;
      inputDigest: string;
      output: JsonValue;
      outputDigest: string;
    };
  };
  artifact: {
    scope: "bounded-fragment-context";
    mediaType: "text/plain;charset=utf-8";
    rawText: string;
    rawSha256: string;
  };
  fragment: {
    exact: string;
    prefix?: string;
    suffix?: string;
    quoteSha256: string;
    locator: {
      textQuote: { exact: string; prefix?: string; suffix?: string };
      textPosition: {
        unit: "utf8-byte";
        start: number;
        end: number; // end-exclusive offsets into artifact.rawText
      };
      cssSelector?: string;
      headingPath?: string[];
    };
    derivation:
      | {
          kind: "source-tool-output-string";
          sourceOutputDigest: string;
          sourceOutputPointer: string; // bounded JSON Pointer to one string scalar
        }
      | { kind: "browser-visible-text" };
  };
  agentProposal: {
    claim: string;
  };
};
```

For a source-tool capture, `input` and `output` are the exact bounded JSON values the client says crossed that tool boundary. PaperPilot canonicalizes and retains both, recomputes their digests, resolves the bounded JSON Pointer to exactly one string scalar, and requires that scalar to equal the admitted text artifact. A digest without its admitted bytes, an ambiguous search, or an orphan pointer is rejected. Source-tool mode, source-tool identity, and source-tool derivation are an all-or-nothing relationship; the reported tool origin must equal the canonical source URL origin. For a browser observation there is no source-tool assertion; the bounded text artifact itself is retained with `CLIENT_ASSERTED` authority.

`artifact.rawText` is explicitly a bounded fragment plus context, never a full-page snapshot. The TextPosition selector uses zero-based, end-exclusive UTF-8 byte offsets into that exact artifact. Server admission slices those bytes and requires them to reconstruct `fragment.exact`; CSS and heading paths remain reopen hints, not custody proof.

The staging envelope contains only an explicitly agent-proposed claim. Researcher interpretation, open question, confidence, final edited claim, and destination project belong exclusively to the later authenticated human decision command. PaperPilot retains the original agent proposal and the final researcher fields as separate immutable revisions.

Server admission recomputes all canonical digests, canonicalizes the URL, bounds every string/JSON collection/depth, and stores client observation/tool times separately from the database receipt time. Capture contract v1 admits only query-free public HTTPS source URLs: a parameter blacklist cannot safely distinguish ordinary navigation parameters from bearer/share credentials, and accepted provenance becomes collaborator-visible and reopenable. A later explicit redaction/retention policy may expand URL support without rewriting v1 records. The server assigns frozen capture-contract, URL-canonicalization, canonical-JSON/digest, locator, content-admission, retention, and WebMCP transport policy versions; clients cannot choose those versions.

## Durable provenance model

The minimum defensible record contains five distinct layers. Keeping them separate prevents a model-generated statement from being mistaken for source text.

| Layer | Durable facts | Authority |
| --- | --- | --- |
| Source identity | canonical URL, origin, reported title, language | observed by browser/agent; not publisher authentication |
| Observation artifact | exact bounded text/tool input/tool output, byte lengths, raw and canonical digests, server receipt time, client times, capture method | retained server bytes plus explicitly labeled client assertion |
| Fragment | exact quote, prefix/suffix context, quote digest, reconstructed UTF-8 offsets, text quote/DOM hints | immutable admitted payload checked against the retained artifact |
| Agent activity | ordered invocation ID, origin/name/schema, retained input/output, digests, outcome, transformations, timestamps | server-observed PaperPilot calls plus explicitly `CLIENT_ASSERTED` source/agent facts |
| Human decision | actor/principal, exact envelope and final-draft digests, project, accept/reject, database time | authenticated PaperPilot action |

The first durable schema should introduce a general web-source record rather than pretend a webpage is a PDF:

- `WebCaptureSession`: tenant, staging user/principal, actor-scoped idempotency key plus exact request digest, source identity, claimed client time, server time, capture method, access class, actor-private pending status, and frozen policy versions;
- `WebCaptureArtifact`: exact bounded text or canonical JSON, scope, media type/charset, byte length, raw digest, canonical digest, and fact authority;
- `WebSourceFragment`: artifact binding, exact admitted quote, contexts, UTF-8 selector, reopen hints, anchor digest, and locator version;
- `WebProvenanceStep`: unique ordered, append-only source-tool, observation, selection, staging, proposal, user-edit, decision, and later-revalidation steps whose input/output digests form a closed chain;
- `WebEvidenceDraftRevision`: immutable agent proposal followed by any explicit researcher edit revisions, each bound to the fragment and predecessor digest;
- `WebEvidenceDecision`: one immutable accept/reject authority row binding the exact envelope, final draft, destination project, retained human principal, server decision time, operation/request digest, optional rejection reason, and accepted evidence ID;
- accepted capture link to a dedicated `WebEvidence` plus `ProjectWebEvidence` edge and the existing `ProvenanceRecord` ledger.

The existing `EvidenceNote` requires a `WorkspacePaper`, so standalone webpage evidence cannot honestly use it. The first release uses a dedicated accepted-web-evidence projection. Unifying PDF and web anchors behind a common `ResearchSource` abstraction belongs in Next; the first release must not weaken the existing PDF `EvidenceTextAnchor` custody contract or create a fake paper merely to reuse its table.

Pending captures are private to their staging actor. They do not appear in the workspace-wide Inbox and no other member—including an owner—can read, accept, or reject the exact captured text through normal product routes. Only an accepted record inherits the explicitly chosen project's visibility. Multiple captures at the same canonical URL remain distinct by capture/envelope identity; URL is not a singleton deduplication key.

Artifacts, fragments, steps, drafts, and decisions are immutable. PostgreSQL enforces tenant-safe composite foreign keys; one staged operation per `(workspaceId, stagingActorUserId, clientOperationId)` plus exact request digest; one v1 fragment; ordered step and revision cardinality; one final decision; reciprocal accepted-graph integrity; and delete-and-reinsert resistance. Replay lookup reauthorizes the same staging actor inside the transaction. A foreign actor's colliding operation ID is independent and cannot disclose, block, accept, or reject the original actor's private draft. `ProvenanceRecord.payload` alone is not sufficient authority because its general JSON shape is not database-closed.

## Provenance claims PaperPilot may and may not make

PaperPilot may say:

- “PaperPilot received this exact text and URL in this browser-mediated capture at this time.”
- “This authenticated user accepted this claim after seeing this source fragment.”
- “The admitted quote and envelope have not changed since acceptance.”
- “A later observation matched, moved, or no longer matched the saved selectors.”

PaperPilot may not say, without later independent authority:

- that the publisher authored the text;
- that the webpage was globally unchanged at the observation time;
- that a client-supplied timestamp is a trusted timestamp;
- that a browser agent's model name or hidden reasoning is verified;
- that a hash proves public availability or legal right to retain the content; or
- that an agent-observed passage is equivalent to a source-provided WebMCP result.

These limits must be visible in the provenance inspector, not buried only in documentation.

## Now / Next / Later

### Now — WebMCP provenance wedge

Committed outcome: one browser agent can stage one passage and one user can turn it into auditable project evidence.

- Add capability-detected WebMCP tool registration to the authenticated app.
- Implement the closed v1 envelope, strict client/server decoders, digest rules, idempotent staging route, and durable models.
- Admit only query-free public HTTPS source URLs in v1 so accepted/reopenable provenance cannot retain an unrecognized share credential.
- Build the Web evidence workbench, pending-capture notification, explicit accept/reject action, and provenance inspector.
- Add a same-repository source fixture that exposes bounded, read-only article tools so the end-to-end WebMCP demo is deterministic.
- Preserve a clearly labeled non-WebMCP envelope test path for CI and unsupported browsers.
- Add safe source reopen and copyable TextQuote/UTF-8 locator controls; do not claim that the PaperPilot tab can inspect a cross-origin page.
- Test prompt-injection-shaped text as inert untrusted content, cross-workspace IDs, replay, changed intent, oversized content, malformed selectors, and unknown fields.
- Exercise the real loop with Chrome's WebMCP testing flag or origin trial plus the Model Context Tool Inspector.

### Next — stronger research workflow

- Multi-passage and multi-page capture sessions.
- Explicit immutable correction/re-anchor successors when a webpage changes.
- Browser-agent/source-tool revalidation that appends exact, context, moved, changed, or unavailable observations; automatic cross-origin highlighting is not a Now requirement.
- Common `ResearchSource` / `SourceAnchor` projection across webpages and PDF Reader evidence.
- Agent-assisted comparison of two already captured sources with citation-per-claim output.
- Source-page adapters for sites that expose their own scholarly WebMCP tools.
- Export to citation and note formats after provenance survives round-trip tests.
- Optional archival/notary authority that can independently attest bytes and time.

### Later — deferred platform breadth

- General server-side crawling, arbitrary remote acquisition, robots/DNS/TLS/redirect policy, and object-storage scale.
- Zotero OAuth, continuous library synchronization, and attachment transfer expansion.
- Direct remote MCP bearer-token APIs and third-party tool registries.
- Multi-user collaboration breadth, invitations, fine-grained sharing, and real-time activity.
- Horizontal workers, durable delivery outboxes, production deployment topology, and broad operations hardening.
- Autonomous discovery and unattended agent workflows.

Existing code on these tracks remains in the repository. “Later” means no new scope is pulled into the WebMCP acceptance gate; it does not mean deleting completed foundations.

## Release acceptance gates

The focused release is complete only when all of these are true:

1. A real WebMCP-capable browser or inspector discovers PaperPilot's registered tools and validates their schemas.
2. An agent can move one bounded source passage into a pending PaperPilot draft without a server crawler or manual retyping.
3. The pending draft is visibly non-authoritative and cannot approve itself.
4. Exact source text, agent proposal, researcher interpretation, and tool trail are distinguishable in the UI and accessible by keyboard.
5. Source-tool captures retain the exact bounded input/output JSON, recompute both digests, and reconstruct the quote through UTF-8 offsets into the retained text artifact; digest-only or orphan transformations fail closed.
6. Acceptance survives refresh and has a separate immutable human decision binding the authenticated principal, server time, destination, exact envelope digest, and final researcher-edited draft digest.
7. Same-actor replays return the original result and changed intent conflicts; two workspace members may use the same client operation ID without disclosure or interference; cross-workspace identifiers do not disclose records; direct database writes cannot mutate or break the accepted graph.
8. Source reopen uses `noopener`/`noreferrer`, and the provenance inspector exposes a copyable versioned locator without claiming that PaperPilot inspected or highlighted the cross-origin page.
9. Page text containing tool instructions or prompt-injection language remains quoted data and never becomes authority or an executable command.
10. The demo and fallback paths are labeled truthfully; unsupported WebMCP is never shown as a successful agent connection.
11. Unit, database integration, lint, typecheck, production build, and browser interaction gates pass.

## Success measures

The first evaluation should measure the provenance loop, not connector count:

- median time from agent request to reviewed capture;
- percentage of accepted claims with an exact quote and valid locator;
- percentage of accepted records whose saved TextQuote and UTF-8 locator can be exported without loss;
- number of user edits between agent proposal and accepted claim;
- rate of rejected captures and rejection reason;
- zero accepted captures without explicit human action;
- zero evidence records in which agent text is rendered as direct source text.

## Deferred-loop checkpoint

The paused collaboration/operations loop should resume only after the focused release gates pass or a blocking production need appears. Its current worktree changes must be retained and audited before any database migration is applied. Resumption starts with migration/authority reconciliation, membership-race verification, readiness configuration validation, and the full release gate; those items are not silently declared complete by this scope change.
