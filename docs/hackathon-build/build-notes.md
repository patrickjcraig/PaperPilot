# Guided Build Notes

## 2026-08-29 — Guided onboarding started

- The project owner explicitly chose the optional guided build path after a direct implementation and Devpost-compliance pass.
- Historical baseline, superseded by the approved Scope and PRD: PaperPilot was initially going to demonstrate a browser agent staging exact webpage evidence for explicit human review, with source, agent, and human authority kept visibly separate.
- Existing product work is not being discarded. The guided documents will refine and govern the remaining WebMCP build.
- The repository already contains a strict capture contract, a capability-detected browser adapter, a focused WebMCP scope, a Devpost compliance matrix, a judge guide, and a fail-closed readiness audit.
- Active shaping moment: “Use guided build path so that we can develop better from now on.”
- Onboarding Round 1 completed. The project owner described PaperPilot as an agentic WebMCP application for overcoming scientific-literacy and specialist-language barriers.
- Core user gesture: upload a paper, highlight an unfamiliar passage or figure, and ask the agent for an accessible explanation.
- Core trust requirement: the explanation must remain grounded in the supplied material, expose provenance, and make agent hallucination or unsupported interpretation detectable.
- Technical calibration: the project owner is an advanced technical contributor, prefers enough planning to establish boundaries, and wants to build aggressively afterward; personal background details are omitted from the public repository.
- Active shaping moment: the vision expanded from webpage-passage capture alone to scientific-literacy explanations over uploaded paper text and figures.
- Onboarding sharpening Round 2 completed.
- Target user: a general reader at approximately undergraduate level reading an early difficult scientific paper, with basic prior knowledge but without specialized fluency.
- Canonical product loop accepted: upload → Reader → select text or figure → browser-agent explanation → provenance inspection → save or reject.
- Architecture direction accepted: the WebMCP-capable browser agent performs the explanation; PaperPilot exposes bounded selection-reading and proposal-writing tools and owns provenance, review, and persistence.
- Active shaping moment: the project owner made text and figures equal first-class requirements rather than treating figure understanding as a stretch goal.
- Onboarding creative Round 3 completed.
- Experience direction: hip, easy to use, and accessibility-first; avoid an intimidating institutional-research aesthetic.
- Agent voice: a supportive research mentor.
- Provenance metaphor: an evidence trail.
- Product inspiration: Notion-like clarity and progressive disclosure.
- Signature visual accepted: source passage or figure on the left, accessible explanation in the center, source → agent → human evidence trail on the right.
- Onboarding complete with all three rounds answered; guided Scope interview started next.

## 2026-08-29 — Scope interview

- Brain dump confirmed: PaperPilot should turn every word, line, equation, passage, figure, and figure region into an interactive teaching surface so readers do not have to leave the paper and reconstruct missing knowledge across unrelated searches.
- Teaching focus: jargon and definitions, prerequisite concepts, difficult technical and mathematical reasoning, within-paper synthesis, figure understanding, and screen-reader descriptions.
- Inspiration reaction: emphasize Explainpaper-like highlighting and direct interaction, Perplexity-like source proximity with stronger exact provenance, and Notion-like calm navigation.
- Time ruler: target feature completion by Tuesday, 2026-09-01; reserve the rest of the submission window for release work.
- Provenance decision: combine paper-grounded evidence, clearly labeled mentor background knowledge, and cited external authoritative sources without merging their authority.
- Figure decision: both full-figure and arbitrary rectangular-region selection are in scope.
- Reliability decision superseded by participant: curated or deterministic paper content is not acceptable; arbitrary user-uploaded PDFs are a core requirement.
- Active shaping moment: “We can’t have deterministic and we have to have it working across arbitrary PDFs.”
- The remainder of the proposed cut line is approved, including the canonical structured mentor card, accessibility essentials, friendly `Save to notes` / `Discard` UI language, and the named deferred capabilities.
- Arbitrary-PDF contract approved: valid non-encrypted bounded PDFs are rendered; exact embedded text is retained when reliable; weak-text/scanned documents retain visual regions with OCR/vision derivation labeled; corrupt, encrypted, unsupported, and oversized files fail explicitly.
- Participant approved the remainder of the cut line and chose to write the formal Scope without an additional deepening round.
- Scope deepening count: 0.
- Created `docs/hackathon-build/scope.md` as the canonical hackathon product scope.
- Marked the earlier webpage-first `docs/WEBMCP-PROVENANCE-SCOPE.md` as an architecture reference superseded for current product priorities.
- Scope handoff: next guided stage is PRD.

## 2026-08-29 — PRD interview

- Formal Scope accepted and carried forward without reopening its product boundaries.
- PRD focus: first-run behavior, upload and processing states, Reader selection behavior, WebMCP mentor interaction, structured explanation review, evidence-trail comprehension, persistence, accessibility, and testable user-visible outcomes.
- First-run recommendation approved: a calm empty library with one prominent upload action, concise product promise, supported-file/privacy information, no demo content, and recent-paper continuation for returning users.
- Upload recommendation approved: human-readable processing states, early Reader access when rendered pages are available, visual-region interaction before text readiness when necessary, and specific recoverable failure guidance.
- Reader recommendation approved: direct text highlighting, explicit visual-region mode, persistent selection outline, preflight disclosure of what will be shared, and equivalent keyboard/screen-reader paths.
- WebMCP handoff recommendation approved: `Ready for your research mentor`, a suggested request, the browser agent's normal conversation surface, and visible selection-ready / mentor-reading / explanation-ready states.
- PRD epics accepted: start reading, understand processing, select difficult material, ask the WebMCP mentor, receive a structured explanation, follow the evidence, and keep only useful results.
- Explanation arrival approved: keep the paper and selection in place, announce readiness, and let the user explicitly move focus to the explanation.
- Follow-up behavior approved: each mentor response is a separate staged proposal with its own evidence trail; no silent overwrites.
- Save behavior approved: preserve the mentor response unchanged and allow an optional, separately labeled `My takeaway`; saving never requires user-authored text.
- Evidence disclosure approved: a simple paper → mentor → user trail by default with technical coordinates, authorities, citations, WebMCP calls, timestamps, and digests behind `Show evidence details`.
- Edge behavior approved: an in-flight request remains bound to its frozen original selection; later selections and results stay separate.
- Weak-text behavior approved: preserve visual-region use, label OCR/vision wording as derived, and disable explanation only when the page cannot render.
- WebMCP failure behavior approved: distinguish unavailable, registration failure, cancellation, invalid response, and interruption; preserve the selection; never fabricate native success; label any local review fallback throughout.
- External-source behavior approved: retain citation warnings, never merge a citation into paper evidence, open links safely, and allow an informed save without claiming the citation proves truth.
- Time guard retained: sharing/export, collaboration, bulk generation, and cross-paper comparison remain outside the Tuesday build.
- Mandatory PRD beats complete; optional deepening choice pending.
- PRD deepening count: 0. Mandatory behavior interview complete.
- Participant chose one PRD deepening round.
- Explanation-depth decision: default undergraduate response plus `Make it simpler`, `Go deeper`, and `Show the math`; each follow-up is a separate response bound to the same source rather than an overwrite.
- Synthesis decision: genuine within-article synthesis is first-class, including contextual single-selection explanation and deliberate synthesis across multiple user-selected passages, equations, or figures from the same paper.
- Persistence decision: restore the last paper/page, saved notes, valid pending responses, evidence trails, and `My takeaway`; do not restore unfinished selections or requests that never yielded a valid response.
- Nonvisual-figure decision: offer current-page description, identified figure/caption choices, and labeled-item questions without requiring a visual rectangle.
- Devpost wow decision: the hero is visible real WebMCP activity—registered tools plus PaperPilot-observed bounded source-read and structured-stage callbacks—and the resulting provenance trail. Tool discovery is shown only when a supported client exposes it observably; private agent reasoning is never claimed. The figure explanation demonstrates value but is not the sole hero.
- PRD deepening count: 1. Participant requested exactly one additional round and confirmed its transcription; formal PRD generation started.
- Created `docs/hackathon-build/prd.md` with 10 product epics, 30 stable user stories, screen-observable acceptance criteria for every story, a failure/edge-case matrix, release proof matrix, and guarded submission claims.
- Reconciled the Scope with the later approved decisions: deliberate bounded same-paper multi-selection synthesis is first-class, mentor responses remain unchanged, and user interpretation lives only in the separate optional `My takeaway`.
- Tightened the public PDF claim from universal/arbitrary success to paper-agnostic support for previously unseen user uploads that meet published admission limits, with per-page exact/visual/unavailable capability.
- PRD independent reviews covered acceptance completeness, accessibility, visible WebMCP activity, scope discipline, and false-claim boundaries; their highest-value findings were incorporated.
- PRD handoff: next guided stage is the technical Spec.

## 2026-08-29 — PRD approval and repository-requirements reconciliation

- The project owner confirmed that the final PRD direction is accurate.
- Formal PRD remains the approved 10-epic, 30-story user-behavior contract; the technical Spec is the next guided stage.
- Replaced the obsolete deterministic webpage-fixture requirement in the Devpost manifest and readiness audit with the canonical paper-agnostic admitted-PDF contract.
- Repository gates now require exact-text, page-region, whole-figure, figure-region, and bounded same-paper synthesis proof plus bounded PDF-source read and structured mentor-stage WebMCP capabilities.
- Added explicit release-verification gates for replaceable previously unseen PDFs, observable WebMCP activity, keyboard and screen-reader use, and the persistent **Local review—WebMCP was not invoked** fallback label.
- Rewrote the judge guide and README challenge framing around the scientific-literacy Reader while preserving the earlier webpage-capture work only as a superseded architecture reference.

## 2026-08-29 — Technical Spec interview

- The project owner advanced naturally with “Next”; the guided technical Spec stage is active.
- Repository survey confirmed a reuse-first base: Next.js 16, React 19, TypeScript, Better Auth, Prisma/PostgreSQL, private PDF upload and custody, isolated Poppler validation/extraction workers, an authenticated text Reader, immutable text anchors, and existing provenance/review primitives.
- Current extraction is embedded-text only. It does not render PDF pages, produce OCR, or retain visual crops.
- Current WebMCP work is an older webpage-evidence adapter and contract; it is a useful registration/test pattern but is not the canonical PDF mentor integration.
- Official current WebMCP references confirm the imperative `document.modelContext.registerTool` surface, AbortSignal-owned registration lifetime, `readOnlyHint`, `untrustedContentHint`, and an execution cancellation signal. Portable image-specific tool-result semantics remain unsettled, so the initial architecture must not depend on them.
- Initial recommendation batch: keep the existing TypeScript/PostgreSQL stack; let the browser agent remain the only explanation engine; render validated PDFs client-side with PDF.js while retaining Poppler chunks as exact-text authority; expose selected visual content in the current page for browser-agent observation; and deploy the existing filesystem/worker topology on one Linux Docker host instead of forcing it into serverless infrastructure.
- The project owner approved the full initial recommendation batch without modification.
- Stack boundary locked: Next.js 16, React 19, TypeScript, Better Auth, Prisma/PostgreSQL, and the existing validation/extraction services remain; PaperPilot adds no separate Python API and no in-product/server-side explanation model. The browser's WebMCP agent is the only mentor explanation engine.
- Rendering boundary locked: add a pinned `pdfjs-dist` version for client page rendering and an authenticated endpoint for the exact admitted original PDF. Poppler chunks remain exact-text authority; PDF.js page pixels and retained crop artifacts provide visual authority. Visual snapshots bind document digest, page, rotation, normalized rectangle, renderer recipe/version, full-context digest, and crop digest; a failed integrity recheck displays `Source incomplete`.
- Figure handoff locked with a release gate: the selected crop remains prominently available in a named semantic `Selected source` region, while the read tool supplies the bounded locator, authority, context, and digests. Because portable image-specific WebMCP results remain unsettled, successful visual consumption must be verified in the named supported judge client; unsupported clients state the limitation and never count figure handling as native WebMCP proof. No second vision model is introduced.
- Deployment locked: one public HTTPS Linux VPS using Docker Compose, a TLS reverse proxy, Next.js, PostgreSQL with a persistent volume, validation/extraction workers and isolated services, and a private durable PDF/artifact volume. Managed database, object-storage, serverless, crawler, Zotero, and broader networking migrations remain post-hackathon work behind stable domain contracts.
- The project owner approved Architecture Round 2 without changes.
- Library boundary locked: an authenticated upload creates a provisional upload-backed library paper with a filename-derived display title and no invented bibliography; validation and extraction gates remain authoritative, while Zotero/crawler reconciliation is deferred behind the same paper contract.
- Reader boundary locked: maintain separate page and exact-text surfaces over the admitted PDF. PDF.js supplies page/figure/region interaction, Poppler admissions supply replayable exact text, and neither authority is silently promoted into the other.
- WebMCP tool surface locked: add Reader-specific `paperpilot.read_active_paper_sources` and `paperpilot.stage_mentor_explanation`; keep the older webpage-capture tools semantically separate; never expose save, discard, approve, or verify as agent-callable tools.
- Mentor persistence boundary locked: add `ReaderProgress`, `PaperMentorRequest`, `PaperMentorSourceItem`, `PaperMentorProposal`, `PaperMentorActivityEvent`, and `PaperMentorDecision`; reuse `EvidenceNote` only as a projection created by an explicit human Save.
- Provenance/activity boundary locked: client-observed registration, server-observed read/stage, and human Save/Discard remain distinct. Registration is not claimed as discovery, callback delivery is not claimed as agent reasoning, and local review creates no fabricated WebMCP events.
- Tuesday engineering ceilings locked as configurable safeguards: at most eight same-document items, 50,000 UTF-8 exact-text bytes, two visual items, one active frozen handoff per Reader tab, a configured visual-payload ceiling, and no cross-paper synthesis.
- The project owner approved the final mandatory architecture round, including the annotated repository map, REST surface, primary data lifecycle, and implementation dependency order.
- Visual-integrity correction approved: a saved visual source retains the exact original PDF.js-produced artifact bytes and the server-recomputed digest of those received bytes, bound to admitted PDF digest, page, rotation, normalized geometry, renderer version, and recipe. Reopening verifies stored artifact integrity and source binding; it does not require a fresh cross-browser canvas render to reproduce an identical pixel digest.
- Figure-handoff correction approved: the portable read-tool contract does not require base64 or a nonstandard multimodal result. Selected pixels remain prominently visible in the semantic `Selected source` region; an inline-image result is permitted only as a named-client-tested compatibility enhancement and never as a general WebMCP claim.
- Persistence refinement approved and supersedes the earlier six-record simplification: use `ReaderProgress` plus six mentor/provenance records—`ReaderSourceSet`, `ReaderSourceItem`, `MentorExchange`, `MentorActivityEvent`, `MentorProposal`, and `MentorDecision`. Separate immutable source sets allow follow-up exchanges to reuse the exact same source without copying artifacts or conflating invocations.
- Route surface approved: page-scoped Reader state and progress, authenticated admitted PDF bytes, mentor exchange list/create/detail, server-observed source reads, structured proposal staging, bounded client-observed events, cancellation, and human-only decisions.
- The mandatory Spec interview beats are complete. The project owner accepted the recommended focused optional deepening pass over the three highest-risk live-demo boundaries before formal Spec generation.
- Spec deepening count: 1. The mandatory architecture interview and the one approved optional deepening round are complete.
- Deepening decision 1 — named-client truth gate: move minimum public HTTPS deployment into Gate 0, prove the native read/stage loop in the exact ChatGPT desktop tuple, and record separate text and visual client tuples/evidence modes instead of implying one client trace proves both.
- Deepening decision 2 — visual proof and custody: pre-key controlled A/B regions with crop-exclusive human ground truth, require a separate full-figure run, retain exact client-produced PNG bytes with server digest/admitted-document binding, and reopen them only through an authenticated source-item-scoped route.
- Deepening decision 3 — failure/accessibility truth: make registration snapshots explicitly client-asserted and persisted after exchange creation, treat callback delivery separately from model use, test client-version unregister behavior, and lock deterministic dialog/focus/error/nonvisual behavior into every slice.
- Created `docs/hackathon-build/spec.md` as the canonical implementation contract covering stack, topology, seven-record data model, closed DTOs, private artifact custody, API routes, WebMCP tools, agent boundaries, accessibility, security, verification, deployment, and checklist handoff.
- Current WebMCP reliability review shortened the canonical tool names to `paperpilot.read_sources` and `paperpilot.stage_explanation`, set annotations according to actual callback effects/output trust, and separated the durable 50,000-byte source ceiling from the named client's serialized tool-result ceiling. The longer names recorded earlier are historical interview output, not implementation requirements.
- Independent Spec audits covered PRD traceability, database/API/idempotency/storage closure, accessibility, prompt injection, exact supported-client semantics, and false-claim boundaries. Incorporated corrections include admitted-PDF generation binding, complete manifest/chunk FKs, HMAC read receipts, private artifact retrieval and quota accounting, replay-before-CAS decisions, per-source synthesis trails, intent-specific mentor validation, and safe persistent citation warnings.
- Technical Spec handoff: next guided stage is `build-checklist`.
- Final closure pass: three independent read-only auditors returned PASS after rechecking PRD acceptance/undefined DTOs, WebMCP and accessibility truth, and database/API/transaction/storage scope. The canonical Spec is 2,781 lines with SHA-256 `074EB1DDF4883D4DE92B96216F88EF639A217D4FB284D8F56BA9D7EB6B0CF662` at handoff.

## 2026-08-29 — Build Checklist planning

- The project owner chose the recommended hand-off path: Codex owns sequencing and executes autonomously rather than running a second co-design interview.
- Build cadence locked as a speed-run with focused automated checks after every item and only three participant look-at-it pauses: named-client truth after Gate 0, the complete exact-text vertical slice, and the complete visual vertical slice.
- The previously approved wow moment remains authoritative and was not re-asked: visible real WebMCP source-read/stage activity plus the resulting inspectable source → agent → human trail; figure-region understanding is supporting first-class proof rather than the sole hero.
- Initial Git safety note: the checkout first appeared as an untracked child of an enclosing worktree. Autonomous building could not stage or commit until PaperPilot was confirmed as an isolated repository boundary.
- Checklist deepening count: 0. The hand-off path skips a separate deepening interview; the project owner's required gut-check applies to the finished draft.
- Created `docs/hackathon-build/checklist.md` with 12 dependency-ordered work packages spanning Gate 0 truth spikes, the exact-text slice, the visual slice, same-paper teaching and hardening, release evidence, and the required Devpost handoff.
- Checklist status remains draft pending the project owner's gut-check; guided state does not advance to `build-project` until the owner accepts the amount and sequence of work.
- Three independent read-only checklist audits covered dependency order/scope, PRD and release-gate traceability, and WebMCP/accessibility/security boundaries. They found no orphaned PRD epic, release row, or no-compromise invariant.
- Audit correction incorporated: the repository does not yet define `test:e2e` or `demo:preflight`; the checklist now creates those scripts before they are used as required release commands.
- Sizing truth: the approved candidate cannot honestly fit twelve literal 15–30-minute tasks. The document therefore uses 12 dependency-ordered work packages and requires `$build-project` to split each into short internal green/red cycles without adding more participant pauses.
- The project owner approved the finished checklist without changes. The twelve-package order, autonomous speed-run mode, checkpoint-commit safety rule, and participant pauses after items 2, 8, and 10 are now locked for `$build-project`.
- Checklist handoff complete: the next guided command is `build-project`; implementation has not started during the checklist stage.

## 2026-08-29 — Guided build execution

- The project owner advanced with “Next,” authorizing execution of the approved autonomous checklist.
- Guided state entered `build`; checklist item 1 is the active work package.
- The build will use short internal green/red cycles, preserve existing work, and stop for participant inspection only after items 2, 8, and 10 unless a no-compromise invariant fails earlier.

## 2026-08-29 — Checklist item 1 implementation checkpoint (blocked at public Gate 0)

- Corrected the repository boundary before any checkpoint commit: the PaperPilot checkout became its own Git repository rather than an untracked child of an unrelated enclosing repository. At that point it had no commits, so item 1 remained unverified.
- Kept local mutable state on the `E:` drive. Applied the pending `20260829261000_user_name_text_policy` migration to the drive-scoped Prisma Dev database and restored the local database after stress runs; the local application readiness endpoint returned `200 {"status":"ready"}` at handoff.
- Added the single-host release skeleton: a multi-stage non-root application image, Caddy public/private TLS configuration, private PostgreSQL/validator/extractor/ClamAV networks, supervised validation and extraction workers, one shared private document volume, bounded resources/logs, explicit database role/migration jobs, a release environment contract, and a safe deployment/rollback runbook.
- Added a deny-by-default root `.dockerignore`. Local `.env` files, retained `.paperpilot-data`, Git metadata, dependencies, generated build output, reports, logs, and private-key formats are excluded from all three repository-root image contexts while the app, migrations, operations scripts, validator, extractor, and scanner configuration remain available.
- Corrected production worker commands to invoke the pinned local `tsx` binary without a developer `.env`; added a real ClamAV daemon ping healthcheck; passed the all-or-nothing transactional-email variables only to web; and kept ordinary worker egress closed.
- Added a phase-aware `demo:preflight` that checks repository/deployment files, immutable image/build inputs, exact Compose topology, private ports and networks, shared storage, supervised runtime state, authenticated private readiness, public health, and bounded release evidence. It explicitly leaves fresh upload behavior, native-client activity, visual understanding, and accessibility as `NOT CHECKED` instead of promoting metadata into proof.
- Fixed a Compose path-resolution false-positive: preflight now uses the directory containing `deploy/app/compose.yaml` as the Compose project directory, matching actual build-context and bind-mount semantics. The deployment runbook now invokes Compose from the repository root with an explicit `deploy/app/.env`.
- Added the minimal arbitrary admitted-PDF visual Reader slice with pinned `pdfjs-dist` `6.3.289`, an authenticated admitted-original endpoint, exact document/digest/ETag generation binding, server and client SHA-256 verification, post-read authority recheck, same-origin worker delivery, and an accessible page-one status/error/summary surface. The existing exact-text Reader remains available independently.
- Closed an audit defect in `PAPERPILOT_READER_PDFJS`: unset or `0` now disables both UI and binary route, exact `1` enables them, and every other value fails configuration closed. The public Gate 0 environment must explicitly enable the flag.
- Reconciled two stale integration assertions with existing authority contracts: document-link failures now expect the generalized “validated PDF source” message, and retained-PDF counts exclude storage-authority/tombstone control files.
- Automated verification after the final patches: `npm run lint` passed; `npm run typecheck` passed; `npm test` passed **635/635**; focused Reader-PDF tests passed **9/9**; demo-preflight tests passed **9/9**; and a production-shaped `npm run build` with `PAPERPILOT_READER_PDFJS=1` passed and emitted the Reader PDF route plus same-origin PDF.js worker.
- Static release verification passed with a SHA-verified standalone Docker Compose v2.40.3 configuration render and Caddy v2.10.2 validation. This proves syntax/topology only; this Windows host has no Docker daemon and those tools did not build or run the release containers.
- The broader local upload/link/Reader database suite improved to **15/17** after the stale assertions were corrected. Remaining failures are not claimed green: the Prisma pg adapter hit `SET TRANSACTION ISOLATION LEVEL must be called before any query` during a grounded-evidence replay, and the drive-scoped Prisma Dev process terminated during the final quota case. Existing Reader authorization, custody, unavailable-state, generation, cursor, and page-cap cases that executed passed. Target-host PostgreSQL verification remains required.
- `npm run demo:preflight -- --phase infrastructure` remains intentionally red: **2 passed, 3 failed, 5 blocked, 5 not checked**. There is no configured public HTTPS origin, release ID, populated `deploy/app/.env`, Docker runtime, or recorded signed-in fresh-PDF upload through both workers and PDF.js.
- Gate decision: checklist item 1 remains unchecked and item 2 has not started. Advancing would violate the approved rule against simulating public HTTPS, worker/shared-volume behavior, admitted-byte binding, or the named-client truth spike. The next build action requires a real Linux Docker host/domain/SSH path, or explicit approval for a lower-isolation temporary HTTPS tunnel used only for an isolated feasibility spike.

## 2026-08-29 — Local hosting and pgAdmin development checkpoint

- Active shaping moment: after rejecting paid VPS hosting and then declining the Sites runtime migration, the project owner directed: “Host it locally and use pgAdmin.”
- Kept the currently healthy Next.js application loopback-only at `http://127.0.0.1:3000`; `/livez` and `/readyz` both return `200`, and readiness includes a fresh database connection plus migration-sentinel verification.
- Verified that the active Prisma Dev database is the named `paperpilot` PGlite/PostgreSQL-compatible instance on `127.0.0.1:51218`, with its shadow database on `51219` and persistent state under the checkout-drive-scoped Prisma Dev root.
- Targeted checks found no Prisma data at the known old system-drive roots. Upload quarantine also remains under the repository's ignored `.paperpilot-data` directory.
- Installed pgAdmin 4 version 9.17 from the signed Windows Package Manager package, launched it as the visible database client, and registered the password-free `PaperPilot Local` profile against the existing database. pgAdmin did not create or relocate a second PaperPilot database.
- Verified PostgreSQL wire compatibility with pgAdmin's bundled `psql`: the connection resolved to database `template1`, user `postgres`, row security `on`, and 57 public application tables. No password was written to the repository or printed by the new preflight.
- Added stable local Prisma Dev control/direct/shadow ports (`51213`/`51218`/`51219`), a password-free pgAdmin server profile, `npm run dev:local`, `npm run local:check`, and the dedicated `deploy/local/README.md` lifecycle and recovery contract.
- This is a local development checkpoint, not a public release claim. It does not prove public HTTPS, production role separation, Docker isolation, validator/extractor supervision, shared-volume behavior, or judge access; checklist item 1 therefore remains unchecked.

## 2026-08-29 — Supabase project staging checkpoint

- Active shaping moment: the project owner supplied Supabase project reference `avmcmmayvnjxrhrmgsdx` and asked to hook it up.
- Verified only the public, non-secret routing boundary: the exact REST and Storage gateways identify that project and reject unauthenticated access, the direct database hostname resolves, and this workstation can establish a TCP connection to port `5432`.
- No Supabase access token, database password, Storage server credential, authenticated CLI session, provider CA file, or deploy-time database authority was present. No database role, migration, bucket, policy, or object was created or changed, and no authenticated-readiness claim was made.
- Added an opt-in direct-database profile fixed to `db.avmcmmayvnjxrhrmgsdx.supabase.co:5432/postgres`, runtime role `paperpilot_runtime`, and `sslmode=verify-full`. The profile rejects other projects, pooler substitution, the provider `postgres` login, missing passwords, extra query parameters, weaker TLS, and local-development fallback.
- A real unauthenticated PostgreSQL handshake exposed the expected provider-certificate trust gap on this machine. The profile therefore requires `PAPERPILOT_DATABASE_CA_CERT_PATH`, validates a bounded CA-only PEM file outside the repository, and supplies it explicitly to both Prisma and the readiness client with certificate verification enabled.
- Added `npm run supabase:check` as a credential-free, fail-closed endpoint preflight. Its output explicitly separates verified routing from database authentication, roles, migrations, Storage bucket configuration, and Storage credentials.
- Supabase's managed `postgres` role is not a true PostgreSQL superuser, and the provider profile targets the managed `postgres` database. The dedicated-cluster bootstrap in `deploy/postgres` was not run or weakened; a provider-specific role and migration reconciliation remains required before cutover.
- The E-drive Prisma Dev database remains the active application database and rollback boundary. Checklist item 1 remains unchecked because public deployment, authenticated managed-database readiness, full worker custody, and the named-client WebMCP proof are still unverified.
- Supabase Storage remains a later provider-adapter slice. A project reference alone cannot provision or authenticate a private bucket, and switching the current local PDF custody path without the validation, extraction, Reader, reconciliation, and digest-verification boundaries would create a false provenance claim.

## 2026-08-29 — No-local-database-write architecture amendment

- Active shaping moment: the project owner explicitly corrected the prior rollback assumption—“There shouldn’t be written anything to our local db.” This supersedes the writable Prisma Dev/pgAdmin workflow and makes Supabase project `avmcmmayvnjxrhrmgsdx` the only approved application database target.
- Immediately stopped the loopback Next.js process and used the repository-supported named-instance stop operation for Prisma Dev. Verification found no listeners on `3000`, `51213`, `51218`, or `51219`; the retained E-drive database files were not deleted or migrated.
- Removed the local database URL and shadow URL from the ignored `.env`, disabled the local compatibility flag, and selected the exact Supabase profile. With the CA and runtime credential still absent, PaperPilot now remains unavailable instead of falling back locally.
- Made the live Prisma client and `/readyz` require the exact Supabase project profile in every environment. Empty, generic, alternate-project, and loopback application configurations fail before network I/O; the old local pool/transaction branch was removed.
- Wrapped every supported web and worker start command in a no-socket Supabase configuration preflight. Disabled `db:dev`, `db:migrate`, `db:studio`, and ordinary `.env` integration tests; the Prisma Dev launcher accepts only the exact emergency stop command.
- Added a read-only freeze check that verifies the exact profile, rejects every configured local/unapproved authority and shadow database, and probes the retired IPv4/IPv6 listener ports without opening a database connection or writing a file.
- Hardened Prisma CLI configuration so offline client generation uses a non-secret exact-project sentinel while configured CLI targets must use the approved Supabase direct authority; local and shadow targets are rejected.
- The earlier self-hosted PostgreSQL Compose topology is now a known red gate and may not be used for release. Replacing it with CA-mounted Supabase connectivity and provider-specific migration authority remains inside checklist item 1; no authenticated Supabase or Storage readiness claim has been made.
- Checklist item 1 remains unchecked. The local-write freeze can be green while the application is deliberately offline; completion still requires authenticated remote role/schema/migration/readiness proof and the remaining public Gate 0 evidence.

## 2026-08-30 — No-local-database enforcement checkpoint

- Converted the active `deploy/app` topology to Supabase-only operation. Removed the PostgreSQL service, `postgres_data` and `postgres_tls` volumes, database-internal network, database leaf/key export, Caddy database listener, and all self-hosted database operation containers. Web and both database-backed workers now require the exact Supabase profile, a read-only provider-CA mount, and the shared non-internal `database_egress` network.
- Strengthened infrastructure preflight so it rejects any retired self-hosted PostgreSQL primitive, stale database container, generic/alternate database target, weak or malformed runtime URL, missing read-only CA mount, or database client without managed-database egress. Focused preflight tests pass **12/12** without printing connection URLs or passwords.
- Disabled all supported database lifecycle, migration, Studio, integration, deployment, role, smoke, ledger, and authority-snapshot commands until their Supabase-specific replacements are reviewed. Retained administration parsers are additionally pinned to the exact approved project before any socket can open.
- Closed the direct-CLI escape: `prisma.config.ts` now admits only offline `prisma generate`; direct Prisma Dev, migration, Studio, validation, and SQL-execution commands fail while loading project configuration. Database-dependent integration helpers also reject every non-approved URL before constructing their raw clients.
- Made Prisma client construction lazy, so unit tests and production builds that only import server modules do not parse database configuration, open a socket, or create a pool. The first actual database member access still performs the exact Supabase URL and CA validation.
- Expanded the no-local access proof to validate the Compose-facing database URL, check standard PostgreSQL port `5432` plus retired ports `51213`/`51218`/`51219` on IPv4 and IPv6 loopback, and fail closed on timeout, permission, or other indeterminate probe outcomes. Live verification returned `local_database_write_frozen`; no listeners existed on those ports or application port `3000`.
- Removed the checked-in pgAdmin registration and updated the root, local-archive, Supabase, deployment, PostgreSQL-authority, Zotero, scope, checklist, and environment documentation so no active path instructs developers to start or write the retained archive.
- Credential-free Supabase endpoint verification remains green for project `avmcmmayvnjxrhrmgsdx`: REST and Storage gateways reject unauthenticated access as expected, database DNS resolves, and TCP `5432` is reachable. Authentication, runtime role creation, migrations, private Storage, and authenticated readiness remain explicitly unverified.
- Final no-database verification passed: `npm run db:generate`; `npm run lint`; `npm run typecheck`; `npm test` **655/655**; `npm run build`; `npm run db:local:freeze-check`; and `npm run supabase:check`. Docker is not installed on this workstation, so native `docker compose config` and container execution were not claimed; the parsed topology and adversarial configuration tests are green.
- Checklist item 1 remains unchecked. PaperPilot is intentionally unavailable until the external Supabase CA and credentials are installed and the provider-specific role/schema/migration/readiness workflow passes; it never falls back to a local database.
