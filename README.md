# PaperPilot

PaperPilot is a research workspace for discovering scholarly literature, collecting it with source provenance, organizing it around explicit research questions, and turning close reading into an auditable evidence trail.

## Try the live WebMCP paper mentor

Open the [public PaperPilot WebMCP reader](https://patrickjcraig.github.io/PaperPilot/webmcp/?release=9dd6bd5) in a WebMCP-capable browser. Choose the official **Attention Is All You Need** demo or your own admitted PDF, read its continuous pages in the center, highlight a difficult passage or describe a region, and ask the browser mentor to explain it and evolve its source-linked knowledge graph. Six real site tools support reads, source navigation, explanation staging, and reversible graph/annotation edits. Human-only **Undo** and **Redo** keep those edits reviewable; explanation **Save** and **Discard** remain separate decisions.

**[Watch the narrated demo on YouTube](https://youtu.be/EDpbN35rDfQ)** · [Download the 2:30 MP4](docs/demo/PaperPilot-WebMCP-demo.mp4) · [Captions](docs/demo/PaperPilot-WebMCP-demo.srt) · [Recording evidence](docs/release/DEMO-RECORDING-2026-09-02.md). The latest toolbar release, `9dd6bd5`, places the annotation controls above the PDF. The video contains real captured page interactions and all six native tool types, with edited timing and synthetic narration disclosed. [Public video checks](docs/release/YOUTUBE-VERIFICATION-2026-09-02.md) establish access, under-three-minute duration and participant-confirmed audio; they do not claim completed human application accessibility acceptance or Devpost publication.

The current [public release proof](docs/release/PUBLIC-RELEASE-REFRESH-2026-09-02.md) binds source `9dd6bd561b3fc628907e797442a252b5a8012379`, fingerprint `a0d5f6636b0eace96e04011526450f0942a6a797ee5d8fafda9faf2bbf8b7167`, and successful [Pages run 33647998514](https://github.com/patrickjcraig/PaperPilot/actions/runs/33647998514). It combines the same-release Attention recording with fresh public GW150914, weak-text and invalid-input checks: **36 successful native callback receipts**, exact graph/annotation Undo/Redo restoration, visible source return, and safe foreign-source/non-PDF rejection. Technical readiness passes **63/63**; human review and submission remain open. These are previously used fixtures through the shared arbitrary-PDF pipeline, not newly unseen papers. The release query avoids stale entry HTML; it is not a permanently pinned deployment URL. The [673726c proof](docs/release/PUBLIC-RELEASE-PROOF-2026-09-02.md), [274c739 hardening record](docs/release/RECOVERY-ACCESSIBILITY-HARDENING-2026-09-02.md), and [old two-tool recording](docs/release/WEBMCP-LIVE-PROOF.md) remain explicitly historical.

> **Current public scope:** the actual PDF is central, with no persistent transcript. The automatic map covers document structure, not complete semantic understanding. Arbitrary bounded PDFs use the same pipeline; limits are 25 MiB and 200 pages, and weak text stays explicitly limited. Figures and regions are page-bound locators with reader descriptions: `locator_only`, `pixelUseVerified: false`, not verified image understanding. The original PDF is immutable and never exported. Human screen-reader, literal 200% browser zoom, forced-colors/reduced-motion inspection and another-machine review remain pending; this is not an accessibility-certification or submission-complete claim. The canonical requirements are the guided [Scope](docs/hackathon-build/scope.md), [PRD](docs/hackathon-build/prd.md), and [technical Spec](docs/hackathon-build/spec.md).

The owner approved a [hackathon-only deferral of four unfinished human checks](docs/release/HUMAN-RELEASE-REVIEW-2026-09-02.md), with the limitations kept public and the manifest flags left false. The [release-freeze plan](docs/release/HACKATHON-FREEZE-PLAN-2026-09-02.md) preserves the judged runtime separately from future development; it does not claim automated enforcement or a completed Devpost entry.

> **Later authenticated service architecture: serverless only.** The
> account-synchronized port targets Vercel Next.js Functions + Vercel Workflow + one fresh
> non-persistent Vercel Sandbox per PDF attempt, backed by Supabase PostgreSQL
> and private Supabase Storage. There is no release VPS, Compose host, polling
> worker, shared local volume, production-local filesystem, or local database.
> Browser PDF transfers bypass Function bodies through short-lived exact-object
> capabilities. This later port, Zotero, crawler acquisition, collaboration and cross-paper graph UI are not required to run the anonymous GitHub Pages reader. See the canonical [serverless architecture decision](docs/SERVERLESS-ARCHITECTURE.md).

### Run the same public reader locally

The authored entrypoint is [spikes/webmcp-contract/index.html](spikes/webmcp-contract/index.html), composed by [app.mjs](spikes/webmcp-contract/app.mjs). [contracts.mjs](spikes/webmcp-contract/contracts.mjs) owns the six closed tool contracts and registration boundary. The lockfile-based packager creates `.paperpilot-pages/` with same-origin PDF.js, Graphology and Sigma assets; it does not package paper bytes or secrets. This path needs no database, Supabase credentials or model-server key.

```bash
npm ci --ignore-scripts
npm run typecheck:webmcp
npm run test:webmcp:contracts
npm run test:webmcp:pages
npm run webmcp:pages:build
npm run webmcp:pages:serve
```

Then open `http://127.0.0.1:4175/webmcp/`. Choose your own PDF or explicitly open the live demo; there are no tools until a paper is ready. A browser without WebMCP can still use the local reader, annotations and graph, but has no native mentor callback proof. The separate `spike:webmcp:serve` command serves authored development files; it is not the packaged-release verification command.

The optional `spike:webmcp:paper:fetch` and `spike:webmcp:paper:verify` commands reproduce the ignored Attention fixture for development. Its [source manifest](spikes/webmcp-contract/assets/papers/attention-is-all-you-need-1706.03762v7.source.json) records the official URL, attribution and byte digest. The paper uses arXiv's non-exclusive distribution license, not PaperPilot's MIT license. Pinning the optional demo's bytes does not specialize the arbitrary-PDF parser or graph logic.

Recovery is opt-in through the human Save controls. A bounded 4 MiB `paperpilot:webmcp:v3:<PDF-SHA-256>` snapshot stores graph/annotation state, reversible history and saved mentor notes—not the PDF bytes. Reload requires reuploading byte-identical PDF data. Legacy v1/v2 copies are preserved during ordinary load/migration/Save; explicit, cancellable **Clear saved copies** removes only the current paper's known saved versions and leaves its open workspace intact. Failed or quota-limited saves remain explicitly unsaved. There are no local-database or server writes in this public slice.

## The WebMCP Challenge build

PaperPilot is being entered in [The WebMCP Challenge](https://webmcp.devpost.com/) as an **existing application with new WebMCP work**. The release uses real `document.modelContext.registerTool` callbacks with six frozen names: `paperpilot.read_focus`, `paperpilot.read_graph`, `paperpilot.focus_source`, `paperpilot.stage_explain`, `paperpilot.apply_graph`, and `paperpilot.apply_annotation`. Fresh public Attention and GW150914 walkthroughs invoked all six through Codex desktop's In-app Browser on Windows; unreported browser/model build strings are not inferred from the older recording. PaperPilot keeps automatic structure, exact paper evidence, mentor interpretation/background, unverified external citations, observed callbacks, graph/annotation revisions, human Undo/Redo, and explanation Save/Discard distinct. New explanations carry per-claim authority and source/graph links; older string notes remain explicitly unclassified.

Repository readiness is intentionally fail-closed. Run:

```bash
npm run devpost:check -- --phase technical
npm run devpost:check
```

The technical phase audits the implemented public artifact and reproduced technical evidence. The default full check additionally requires human accessibility/access inspection, final narrated video, handoff and submission/freeze evidence; it is expected to remain red until those checks are actually complete. Neither phase treats a registered tool as an invocation or automated accessibility tests as a human screen-reader pass. Missing evidence remains an explicit failure.

- [Canonical guided Scope](docs/hackathon-build/scope.md)
- [Canonical product requirements](docs/hackathon-build/prd.md)
- [Devpost compliance requirements](docs/DEVPOST-COMPLIANCE.md)
- [Judge guide and under-three-minute flow](docs/DEVPOST-JUDGE-GUIDE.md)
- [Dated baseline/new-work disclosure](docs/HACKATHON-CHANGELOG.md)
- [Current public release proof index](docs/release/PUBLIC-RELEASE-REFRESH-2026-09-02.md)
- [Superseded webpage-provenance architecture reference](docs/WEBMCP-PROVENANCE-SCOPE.md)
- [Machine-readable readiness manifest](devpost-requirements.json)

The repository now contains three intentionally separate product paths:

- `/webmcp/` is the deployed six-tool, centered continuous-PDF reader with structural mapping, spatial annotations, graph navigation, claim-level mentor proposals, reversible edits and browser-local recovery. It is the judged public proof path. Its release record separately identifies passing technical checks and pending human acceptance.
- `/` is the legacy deterministic, browser-local product demo. It remains the fastest way to exercise Discover, Inbox, Reader, evidence, and collections without an account, but it is not the judged WebMCP Challenge proof path.
- `/app` is the live-service path. It has verified email/password sessions, a PostgreSQL-backed workspace, live OpenAlex discovery, durable projects/imports/collections/evidence, credential-safe Zotero OAuth plus explicit library discovery/selection and background metadata synchronization, authenticated upload and governed one-PDF crawler custody through quarantine, validation, and user-directed custody retirement, explicit paper linking, a bounded Reader over authoritative embedded-text extraction, immutable manifest-bound passage capture, and explicit review/re-anchor successor revisions with a visible audit ledger. Start at `/sign-up` to use it.

The split is deliberate. Authenticated features never silently fall back to browser persistence. The `/webmcp/` release has explicit browser-local recovery; the authenticated Reader remains the later port for durable account-synchronized records and the complete serverless service. The service sections below do not describe a backend requirement for the public reader.

## Current service status

| Capability | Demo at `/` | Live service at `/app` |
| --- | --- | --- |
| Discover navigation and search UI | Bundled corpus plus optional OpenAlex | Authenticated OpenAlex gateway |
| Projects | Browser snapshot v3 | PostgreSQL, authorization checked per command |
| Project creation | Atomic browser command | Atomic, idempotent, optimistic server command |
| Inbox and paper filing | Working browser-local flow | Durable stage/review/file commands with canonical deduplication |
| Project detail and collections | Working browser-local flow | PostgreSQL read model, collection creation, paper/evidence filing |
| Evidence | Working for bundled demo papers | Structured durable notes, exact UTF-8 Reader passage capture, immutable review/re-anchor successors, and a head-first revision ledger; review and source-currentness remain independent |
| Reader | Working for bundled demo papers | Explicit validated-PDF linking plus database-admitted immutable manifests, generation-bound signed pagination, bounded keyset reads, and honest unavailable, processing, and no-text states |
| Accounts and sessions | Not required | Better Auth database sessions, verification, recovery, and shared throttling |
| Zotero | Product preview | Read-only OAuth 1.0a, personal/group discovery, explicit selection, durable cursor-safe metadata sync, sanitized attachment discovery, opt-in one-file imports, and shared quarantine/validation/extraction custody; metadata and attachment workers run separately |
| PDF upload | Product preview | Existing exact-custody domain path is implemented; the required direct-to-private-Supabase reserve/finalize adapter and Workflow/Sandbox runtime are the active Gate 0 migration and are not yet release-verified |
| WebMCP/MCP review | Legacy `/` surfaces are not the judged proof | The separate public `/webmcp/` release has six reproduced native capabilities, source-linked graph/annotation revisions and human Undo/Redo. Porting those contracts into authenticated `/app` durability remains later work; metadata proposals in the existing service are not the public reader's execution path. Direct MCP tokens and remote byte acquisition remain deferred. |
| Crawler | Live first mode | The existing supervised-worker implementation is retained as migration reference, not as a serverless release path. It must be converted to bounded event-driven Workflow/Sandbox execution after the upload/WebMCP vertical slice; no daemon or local-quarantine fallback is allowed in Production |

The UI labels live, demo, preview, and upcoming states explicitly. A metadata result is never presented as processed full text.

## Develop locally with Supabase

Requirements:

- Node.js 24 or another version supported by Prisma 7
- npm
- access to the approved Supabase project
- the project database CA and a restricted `paperpilot_runtime` credential

Install the application:

```powershell
npm install
Copy-Item .env.example .env
```

PaperPilot has a **Supabase-only database policy**. The retained
`E:\PaperPilot-Prisma-Dev` directory is an offline archive and must never be
started, queried, migrated, opened in pgAdmin, or used by tests. Confirm the
freeze without connecting to any database:

```powershell
npm run db:local:freeze-check
```

If a retired Prisma Dev daemon is ever observed, the only permitted lifecycle
operation is the idempotent stop command:

```powershell
npm run db:local:stop
```

Direct Prisma CLI use is technically restricted to offline `prisma generate`.
The supported lifecycle, migration, Studio, SQL-execution, database role,
database deployment, authority-inspection, and `test:integration` commands
intentionally fail until remote, isolated Supabase equivalents are reviewed.
Offline client generation remains available:

```powershell
npm run db:generate
```

After the exact Supabase URL, downloaded CA, runtime role, migrations, and
readiness checks are installed, `npm run dev:local` starts only the web process
on loopback while all durable database traffic goes to the approved Supabase
project. Until then it fails before spawning Next.js.

Once configured, open:

- [http://127.0.0.1:3000/](http://127.0.0.1:3000/) for the browser-local demo;
- [http://127.0.0.1:3000/sign-up](http://127.0.0.1:3000/sign-up) to create a live workspace;
- [http://127.0.0.1:3000/app](http://127.0.0.1:3000/app) to return to an authenticated workspace.

### Retired local database archive

The old E-drive Prisma Dev database is retained only as an offline archive. It
is not an active rollback database: even a nominally read-only PostgreSQL
startup may update control, lock, statistics, or WAL state. The original
archive therefore stays stopped and is not a supported pgAdmin target.

```text
E:\PaperPilot-Prisma-Dev
  -> retained offline
  -> no listeners on standard PostgreSQL 5432 or retired 51213/51218/51219
  -> no application, worker, test, migration, Studio, or pgAdmin access
```

Run `npm run db:local:freeze-check` to verify the process and configuration
boundary without opening the archive. See
[`deploy/local/README.md`](deploy/local/README.md) for the frozen-archive
contract and recovery cautions.

### Supabase project connection

The repository is pinned to the supplied Supabase project reference
`avmcmmayvnjxrhrmgsdx` through a mandatory provider-specific database profile.
The public endpoint check is safe to run without credentials:

```powershell
npm run supabase:check
```

That command verifies the exact REST and Storage gateway identities, database
DNS, and TCP route. It deliberately does **not** claim database authentication,
role setup, migrations, or Storage readiness. The E-drive database remains
offline even while those checks are incomplete; PaperPilot remains unavailable
rather than falling back locally. The exact profiles, verified TLS
requirement, secret placement, and managed-provider migration boundary are
documented in
[`deploy/supabase/README.md`](deploy/supabase/README.md).

## Environment configuration

The Prisma CLI reads `.env`; Next.js also loads it. The file is ignored by Git.

| Variable | Local development | Production requirement |
| --- | --- | --- |
| `DATABASE_URL` | Empty until the remote runtime role exists; local URLs are forbidden | Exact dashboard-issued Supavisor transaction URL, port `6543`, database `postgres`, project-scoped `paperpilot_runtime.avmcmmayvnjxrhrmgsdx`, `sslmode=verify-full`, and `pgbouncer=true` |
| `PAPERPILOT_DATABASE_PROFILE` | `supabase-avmcmmayvnjxrhrmgsdx-transaction-v1` | Same exact transaction profile; the direct runtime transition profile is rejected |
| `PAPERPILOT_SUPABASE_POOLER_HOST` | Exact non-secret hostname copied from Supabase Connect | Same reviewed hostname; arbitrary poolers are rejected before I/O |
| `PAPERPILOT_DATABASE_CA_CERT_PATH` | Optional absolute CA-only PEM path; verified system trust roots are used when empty | Optional deployment-mounted CA bundle; TLS hostname/certificate verification is always enabled |
| `PAPERPILOT_MIGRATION_DATABASE_PROFILE` | `supabase-avmcmmayvnjxrhrmgsdx-migration-v1` only while applying releases | Never installed in the Vercel runtime; protected migration job only |
| `PAPERPILOT_MIGRATION_DATABASE_URL` | Exact direct `paperpilot_migration_owner` URL on port `5432` | Protected migration job only; never browser, Workflow, or Sandbox state |
| `PAPERPILOT_ALLOW_LOCAL_PRISMA_DEV` | Must be `0`; `1` is rejected | Must be `0`; there is no local runtime exception |
| `SHADOW_DATABASE_URL` | Must be empty | Must remain empty; `migrate dev` is disabled |
| `PAPERPILOT_PRISMA_DEV_ROOT` | Optional location of the stopped archive for freeze verification | Not used by the application |
| `PAPERPILOT_PRISMA_DEV_PORT` | Retired control port checked for absence; default `51213` | Not used by the application |
| `PAPERPILOT_PRISMA_DEV_DB_PORT` | Retired database port checked for absence; default `51218` | Not used by the application |
| `PAPERPILOT_PRISMA_DEV_SHADOW_DB_PORT` | Retired shadow port checked for absence; default `51219` | Not used by the application |
| `DATABASE_POOL_MAX` | May be empty or exactly `1` | Exactly `1` per serverless instance for this release; malformed or wider values fail closed |
| `PAPERPILOT_SUPABASE_SECRET_KEY` | Server-only modern `sb_secret_...` key for Storage setup/control-plane work | Vercel encrypted server environment only; never `NEXT_PUBLIC_*`, Workflow state, or Sandbox |
| `BETTER_AUTH_SECRET` | At least 32 characters | Independent high-entropy secret from a secret manager |
| `BETTER_AUTH_URL` | `http://127.0.0.1:3000` | Canonical HTTPS origin |
| `PAPERPILOT_RELEASE_ID` | Optional; readiness uses `development` when omitted | Required immutable commit/image release identity shared by the web deployment |
| `PAPERPILOT_ALLOW_INSECURE_ORIGIN` | `true` permits local HTTP builds | Omit; production rejects a non-HTTPS auth origin |
| `PAPERPILOT_RATE_LIMIT_SECRET` | Optional; falls back to `BETTER_AUTH_SECRET` | Prefer an independent 32-byte-or-longer secret for non-reversible quota bucket keys |
| `PAPERPILOT_IP_ADDRESS_HEADERS` | Usually empty locally | Only the exact forwarding headers documented by the production platform |
| `PAPERPILOT_TRUSTED_PROXIES` | Usually empty locally | Exact trusted proxy IP/CIDR list; never trust arbitrary forwarded headers |
| `PAPERPILOT_IPV6_RATE_LIMIT_SUBNET` | Optional | Deployment-specific integer from 1–128 when IPv6 aggregation is required |
| `PAPERPILOT_READER_CURSOR_SECRET` | Optional; falls back to `BETTER_AUTH_SECRET` | Prefer an independent 32-byte-or-longer HMAC secret shared by every web node; rotation intentionally refreshes open pagination |
| `PAPERPILOT_READER_USER_PER_MINUTE` | `60` | Per-authenticated-user Reader token-bucket capacity/refill |
| `PAPERPILOT_READER_WORKSPACE_PER_MINUTE` | `300` | Per-canonical-workspace Reader token-bucket capacity/refill |
| `PAPERPILOT_READER_IP_PER_MINUTE` | `600` | Trusted-client-IP Reader token-bucket capacity/refill; omitted when no trusted IP can be resolved |
| `PAPERPILOT_EMAIL_WEBHOOK_URL` | Optional | Credential-free HTTPS delivery endpoint; required for public signup |
| `PAPERPILOT_EMAIL_WEBHOOK_SECRET` | Optional | At least 32 characters from a secret manager; required with the webhook URL |
| `PAPERPILOT_EMAIL_FROM` | Optional | Valid sender address authorized by the downstream email provider |
| `OPENALEX_API_KEY` | Optional during local evaluation | Recommended for a stable provider budget |
| `OPENALEX_ALLOW_ANONYMOUS` | `true` for local evaluation | `false` so the server key/budget is controlled |
| `ZOTERO_OAUTH_CONSUMER_KEY` | Empty until an HTTPS callback is available | Zotero OAuth 1.0a application consumer key |
| `ZOTERO_OAUTH_CONSUMER_SECRET` | Empty until configured | Independent secret-manager value; never expose to browser code |
| `ZOTERO_OAUTH_STATE_SECRET` | Empty until configured | Independent 32-byte-or-longer state/HMAC secret |
| `ZOTERO_OAUTH_CALLBACK_URL` | HTTPS tunnel/development origin | Exact registered callback at `/api/integrations/zotero/oauth/callback` |
| `PAPERPILOT_ZOTERO_CALLBACK_IP_PER_MINUTE` | `120` | Bounded pre-session callback flood budget; tune only with observed traffic and proxy validation |
| `PAPERPILOT_ZOTERO_WORKER_ID` | Generated when omitted | Optional stable, bounded identity for an independently supervised Zotero worker |
| `PAPERPILOT_ZOTERO_ATTACHMENT_BLOB_ALLOWLIST` | Empty / worker disabled | Required non-empty JSON list of exact HTTPS blob origins or path-style S3 origin+bucket rules; no wildcard or provider redirect may expand it |
| `PAPERPILOT_ZOTERO_ATTACHMENT_WORKER_ID` | Generated when omitted | Optional stable, bounded identity for the independently supervised stored-PDF download worker |
| `PAPERPILOT_CREDENTIAL_ACTIVE_KEY_VERSION` | `v1` | Active envelope-key identifier |
| `PAPERPILOT_CREDENTIAL_ENCRYPTION_KEYS` | JSON keyring with a 32-byte base64/base64url key | Secret-manager JSON retaining active and rotation-read keys |
| `PAPERPILOT_CREDENTIAL_FINGERPRINT_KEY` | Empty until configured | Independent 32-byte base64/base64url HMAC key |
| `PAPERPILOT_UPLOAD_QUARANTINE_ROOT` | `.paperpilot-data/quarantine` | Required absolute, canonical, pre-provisioned private directory in production |
| `PAPERPILOT_UPLOAD_MAX_BYTES` | `26214400` | Maximum bytes for one PDF reservation and stream |
| `PAPERPILOT_UPLOAD_SESSION_TTL_SECONDS` | `900` | Upload-reservation lifetime |
| `PAPERPILOT_UPLOAD_LEASE_TTL_SECONDS` | `600` | Exclusive receive-lease lifetime |
| `PAPERPILOT_UPLOAD_STREAM_IDLE_TIMEOUT_SECONDS` | `30` | Maximum delay between upload-body chunks |
| `PAPERPILOT_UPLOAD_STREAM_ABSOLUTE_TIMEOUT_SECONDS` | `300` | Absolute upload-body stream deadline |
| `PAPERPILOT_UPLOAD_MAX_CONCURRENT_PER_USER` | `2` | Active upload ceiling per user |
| `PAPERPILOT_UPLOAD_MAX_CONCURRENT_PER_WORKSPACE` | `10` | Active upload ceiling per workspace |
| `PAPERPILOT_UPLOAD_MAX_RETAINED_BYTES_PER_WORKSPACE` | `262144000` | Workspace quarantine reservation/retention ceiling |
| `PAPERPILOT_CRAWLER_POLICY_VERSION` | `paperpilot-crawler-explicit-pdf-v1` | Reviewed first-mode acquisition-policy identity; required explicitly in production and frozen per request |
| `PAPERPILOT_CRAWLER_RATE_POLICY_VERSION` | `paperpilot-crawler-origin-rate-v1` | Reviewed origin-budget identity, frozen per request |
| `PAPERPILOT_CRAWLER_ROBOTS_USER_AGENT` | `PaperPilotCrawler` | RFC 9309 product token used for robots matching; ASCII letters, `_`, and `-` only |
| `PAPERPILOT_CRAWLER_WORKER_IDENTITY` | `paperpilot-crawler-local` | Required bounded deployment identity/policy compatibility token |
| `PAPERPILOT_CRAWLER_WORKER_ID` | Generated when omitted | Optional stable identity for one independently supervised crawler worker process |
| `PAPERPILOT_CRAWLER_JOB_LEASE_TTL_MS` | `600000` | Fenced job lease; must exceed both crawler and quarantine-stream absolute deadlines |
| `PAPERPILOT_CRAWLER_MAX_REDIRECTS` | `0` | Must remain `0` in the exact-path first mode; redirected destinations require a future separately reviewed scope contract |
| `PAPERPILOT_CRAWLER_MAX_DNS_ADDRESSES` | `8` | Maximum all-public DNS answers admitted per resolution |
| `PAPERPILOT_CRAWLER_DNS_LOOKUP_TIMEOUT_MS` | `3000` | Per-resolution deadline inside the absolute fetch budget |
| `PAPERPILOT_CRAWLER_MAX_RESPONSE_BYTES` | `26214400` | Per-request deployment ceiling, additionally capped by the upload limit and the user's lower admitted cap |
| `PAPERPILOT_CRAWLER_MAX_RESPONSE_HEADER_BYTES` | `32768` | Strict response-header byte ceiling |
| `PAPERPILOT_CRAWLER_RESPONSE_HEADER_TIMEOUT_MS` | `5000` | Response-header deadline |
| `PAPERPILOT_CRAWLER_RESPONSE_IDLE_TIMEOUT_MS` | `10000` | Maximum delay between response-body chunks |
| `PAPERPILOT_CRAWLER_ABSOLUTE_DEADLINE_MS` | `60000` | One deadline covering DNS, robots, rate admission, headers, redirect rejection, and body |
| `PAPERPILOT_CRAWLER_ORIGIN_REQUESTS_PER_MINUTE` | `6` | Shared token refill for each origin hostname and frozen rate-policy version |
| `PAPERPILOT_CRAWLER_ORIGIN_BURST` | `1` | Shared origin token-bucket capacity; the worker waits within the absolute deadline instead of starving a robots→PDF sequence |
| `PAPERPILOT_VALIDATION_SERVICE_ENDPOINT` | Required by the worker | Exact HTTPS isolated-validator endpoint; loopback HTTP is development-only |
| `PAPERPILOT_VALIDATION_SERVICE_READINESS_ENDPOINT` | Same origin at `/readyz` | Exact authenticated readiness URL probed before a durable job attempt is claimed |
| `PAPERPILOT_VALIDATION_SERVICE_BEARER_SECRET` | Empty until configured | Independent non-placeholder secret of at least 32 characters |
| `PAPERPILOT_VALIDATION_POLICY_VERSION` | `paperpilot-document-validation-v1` | Worker/validator policy contract identifier |
| `PAPERPILOT_VALIDATION_TIMEOUT_SECONDS` | `30` | Absolute validator request deadline |
| `PAPERPILOT_VALIDATION_MAX_RESPONSE_BYTES` | `16384` | Strict bounded-attestation response ceiling |
| `PAPERPILOT_VALIDATION_SIGNATURE_MAX_AGE_SECONDS` | `86400` | Maximum accepted malware-signature age |
| `PAPERPILOT_VALIDATION_FUTURE_CLOCK_SKEW_SECONDS` | `300` | Maximum accepted validator clock lead |
| `PAPERPILOT_VALIDATION_WORKER_ID` | Generated | Optional bounded worker identity for lease operations |
| `PAPERPILOT_EXTRACTION_SERVICE_ENDPOINT` | `http://127.0.0.1:4020/v1/extract-pdf` | Exact private HTTPS external-extractor endpoint |
| `PAPERPILOT_EXTRACTION_SERVICE_READINESS_ENDPOINT` | Same origin at `/readyz` | Exact authenticated readiness URL probed before a durable extraction attempt is claimed |
| `PAPERPILOT_EXTRACTION_SERVICE_BEARER_SECRET` | Empty until configured | Independent non-placeholder secret of at least 32 characters |
| `PAPERPILOT_EXTRACTION_POLICY_VERSION` | `paperpilot-text-extraction-v1` | Worker/extractor policy contract identifier |
| `PAPERPILOT_EXTRACTION_EXPECTED_TOOLCHAIN_DIGEST` | Empty until configured | Independent nonzero SHA-256 pin for the approved extractor image/SBOM/policy/toolchain; required by validation scheduling and extraction workers |
| `PAPERPILOT_EXTRACTION_TIMEOUT_SECONDS` | `75` | Absolute extractor request deadline |
| `PAPERPILOT_EXTRACTION_MAX_RESPONSE_BYTES` | `8388608` | Strict bounded extraction-result response ceiling |
| `PAPERPILOT_EXTRACTION_RESULT_MAX_AGE_SECONDS` | `900` | Maximum accepted result age |
| `PAPERPILOT_EXTRACTION_FUTURE_CLOCK_SKEW_SECONDS` | `300` | Maximum accepted extractor clock lead |
| `PAPERPILOT_EXTRACTION_WORKER_ID` | Generated | Optional bounded extraction-worker identity for lease operations |

Do not expose any credential through a `NEXT_PUBLIC_` variable.

Production public registration is enabled only when all three transactional-email values are valid. Missing delivery configuration keeps registration disabled; partial or insecure configuration stops startup rather than silently opening signup. Production accounts require email verification, password-reset tokens expire after one hour, and a completed reset revokes existing sessions. Local development keeps self-service signup enabled for evaluation.

### Service health probes

- `GET`/`HEAD /livez` is process-only and never touches the database or deployment configuration. It returns `200 {"status":"live"}` when the web process can serve requests.
- `GET`/`HEAD /readyz` admits traffic only after the bounded release/configuration contract, runtime database connection, runtime-role identity in production, and the latest required migration sentinel all pass. Success is `200 {"status":"ready"}`; failures are fixed, non-sensitive `503` reason codes (`configuration_invalid`, `database_unavailable`, or `migration_incomplete`).
- Worker health is intentionally separate from web readiness. Supervise and alert on each independently deployed validation, extraction, Zotero, attachment, and crawler worker rather than making ordinary web traffic depend on every background queue.

Both probe responses are `Cache-Control: no-store` and omit database hosts, credentials, release IDs, migration names, exception text, and worker details.

### Transactional identity email

PaperPilot uses a provider-neutral HTTPS webhook so the application does not depend on a specific email vendor. It sends `POST` with `Content-Type: application/json`, `Authorization: Bearer <PAPERPILOT_EMAIL_WEBHOOK_SECRET>`, and this versioned shape:

```json
{
  "schemaVersion": 1,
  "message": {
    "kind": "email-verification",
    "from": "accounts@paperpilot.example",
    "to": "researcher@example.edu",
    "subject": "Verify your PaperPilot email",
    "text": "...",
    "html": "..."
  }
}
```

The receiver translates that neutral message into SES, Postmark, SendGrid, or another transactional provider request and returns any `2xx` response. PaperPilot refuses webhook redirects, credentials/query secrets in the endpoint URL, foreign auth-link origins, and unexpected callback paths. Provider response bodies and underlying errors are not copied into application errors. Because message bodies necessarily contain one-time auth links, the receiver must also avoid request-body logging and apply equivalent token redaction.

Password-reset messages use a URL fragment for the one-time token. The fragment is never included in the reset-page HTTP request or a Referer header, and the client removes it from browser history immediately. The UI also accepts Better Auth's legacy `?token=` callback form, then scrubs it in the same way.

## Five-minute service walkthrough

1. Open `/sign-up`, create an account, and enter `/app`. The authenticated path opens on Discover.
2. Run the default OpenAlex query. Results expose provider identity, provider version, identifiers, access state, retraction state, and source links.
3. Open Workspace and create a project with a research question, project type, and visibility.
4. Return to Discover, choose **Save to project**, review the import preview, and file the paper into that project. PaperPilot stages the provider snapshot and provenance in the Inbox before canonicalizing the paper and membership.
5. Open the project, create a collection, add the paper, and save a structured manual evidence note. Researcher-entered source text remains visibly marked **Needs verification** and must name an explicit visible project that already contains the paper.
6. Open Sources, select a PDF, and explicitly choose **Upload PDF**. Native progress is shown; a completed transfer navigates to a document-only Inbox row labeled **Quarantined**. With the separate validator/extractor services plus `npm run worker:validation` and `npm run worker:extraction` running, the Inbox polls durable validation, link, and extraction state through an immutable page/paragraph generation or a bounded no-text/failure outcome. `Ready` on the custody stage means only that the private file passed malware/PDF validation; it never silently chooses a bibliography record.
7. After validation, use the Inbox's explicit link control to associate the PDF with one existing visible workspace paper. Open that paper from the project or Inbox. The live Reader reports unavailable, processing, or no-text honestly and serves bounded chunks only when the linked document's current accepted validation, current extraction generation, and database-admitted manifest agree. Select text across contiguous paragraphs or use **Capture paragraph**, complete the evidence docket, and file it into an explicit project and optional collections. PaperPilot reconstructs the quote from admitted server chunks, verifies its digest and UTF-8 boundaries, and stores an immutable anchor. Continuations and evidence anchors are generation-bound; a changed source restarts Reader pagination and labels earlier evidence **Source updated** instead of silently re-anchoring it.
8. Open Notes. Review the exact quote, claim, and interpretation to create an immutable verified successor, or choose **Re-anchor in Reader** for source-updated evidence, make a fresh selection, and confirm the new captured successor. Switch to the revision ledger to inspect preserved history; project and collection counts continue to show current heads only.
9. If Zotero OAuth is configured on an HTTPS origin, start `npm run worker:zotero` in a separate terminal, choose a read-only scope, connect Zotero, discover personal/group libraries, explicitly select the libraries to monitor, and request a sync. The Sources folio shows the persistent cursor, latest sanitized run counts/status, provider backoff, and a metadata-only stored-PDF accession register. An owner/admin may enable **Manual imports**; a member then chooses one eligible PDF at a time. With an explicit blob allowlist and `npm run worker:zotero-attachments` running, the exact provider generation is copied into private quarantine, checksum-bound, validated, extracted, and tracked in Inbox. Connecting or syncing alone never downloads attachment bytes.
10. Start `npm run worker:crawler`, return to Sources, and review the active crawler policy passport. Enter one query-free HTTPS URL whose path ends in `.pdf`, choose a display filename and byte cap, and affirm the exact indefinite-research-custody declaration. The URL remains private; the public ledger shows only the request ID, filename, frozen policy, byte progress, lifecycle, retry time, and closed failure code. The worker checks robots, re-resolves and pins every public connection, waits inside the absolute deadline for origin-rate capacity, streams only an eligible bounded PDF into private quarantine, creates an immutable receipt, and hands the document to validation. A ready result remains in Research Inbox for a separate paper-link/project decision. To retire the private copy, review the explicit deletion disclosure and confirm **Delete private PDF custody**. Reader closes immediately; quota remains held until the authoritative storage generation proves the final and partial object names absent. If any grounded evidence depends on an extraction, its complete extracted-text generation may remain, potentially including the paper's full extracted text.
11. Refresh the page. The project, Inbox decisions, crawler ledger, document link and processing state, paper, collection, note, and revision history are reloaded from PostgreSQL, not `localStorage`.
12. Sign out and navigate directly to `/app`. PaperPilot redirects to `/sign-in`.
13. Sign in again. The same durable workspace state returns.

The browser-local walkthrough remains available at `/`: Discover → import preview → Inbox/project → Reader → evidence → collections.

## Architecture

PaperPilot uses Next.js 16, React 19, TypeScript, Better Auth 1.7, Prisma 7,
Supabase PostgreSQL/private Storage, Vercel Workflow, and Vercel Sandbox. The
diagram below is the required release topology; current local-quarantine and
polling-worker code is migration input, not an approved production fallback.

```text
Browser
  ├─ /                 demo workspace client → versioned localStorage snapshot
  └─ /app              HTTPS workspace client → Vercel Next.js Functions
                                                   │
                                                   ├─ auth + authorization + idempotency
                                                   ├─ Prisma → Supavisor transaction pooler
                                                   ├─ WebMCP focus/graph/navigation/explanation/reversible-mutation control plane
                                                   └─ reserve/finalize PDF object + start Workflow

Browser ── short-lived exact-object capability ──> private Supabase Storage
                                                       ▲              │
                                                       │              │ one PDF object
                                                       │              ▼
Supabase PostgreSQL <── bounded job/receipt ── Vercel Workflow
                                                       │
                                                       ▼
                                             fresh Vercel Sandbox
                                             persistent: false
                                             qpdf + ClamAV + Poppler
                                                       │
                                                       └─ immutable artifacts/receipt

Authorized Reader ── short-lived exact-generation capability ──> PDF.js
                                                              └─ client verifies admitted SHA-256
```

Important directories:

- `src/app/api/auth/[...all]/` exposes Better Auth's server handler.
- `src/app/api/workspaces/` exposes session- and membership-checked workspace resources.
- `src/server/workspaces/` owns workspace resolution, tenant authorization, optimistic revisions, durable idempotency, project commands, and authoritative grounded-evidence reconstruction.
- `src/lib/workspace/` defines the transport-neutral async client contract plus browser-demo and authenticated HTTP adapters.
- `src/lib/workspace-store.ts` owns browser snapshot v3 migration and duplicate normalization.
- `src/lib/integrations/openalex-adapter.ts` is the server-only live discovery provider.
- `src/server/integrations/zotero/` is the first server-only Zotero Web API v3 boundary.
- `src/server/integrations/webmcp/` owns the closed metadata-only proposal contract and its server-assigned Inbox/provenance admission path.
- `src/server/integrations/web-source/` owns the closed crawler command/configuration, tenant-safe queue and custody-retirement services, reusable public-URL/address-policy primitives, RFC 9309 evaluation, pinned HTTPS fetch boundary, origin-rate admission, and fenced job/deletion transitions.
- `src/workers/governed-crawler-worker.ts` leases one frozen crawler request at a time, streams an eligible PDF into attempt-specific private quarantine, persists an immutable receipt, hands the exact asset to the shared validation lifecycle, and reconciles confirmed custody deletion before claiming new work.
- `src/workers/zotero-sync-worker.ts` schedules and leases selected-library pulls, enforces stable provider versions/backoff, and publishes staged metadata only through an atomic cursor commit.
- `src/server/uploads/` owns upload configuration, filename/media validation, bounded streaming, private object finalization, durable custody transitions, and credential-free status DTOs.
- `src/server/platform/` defines provider-neutral private-object and one-attempt PDF Sandbox boundaries; Supabase/Vercel adapters replace filesystem/polling deployment behavior without changing provenance semantics.
- `src/workflows/` owns durable Vercel Workflow orchestration. Workflow state stays bounded; Supabase remains the user-visible job and receipt authority.
- `src/server/documents/` owns the strict validation/extraction contracts and clients, fenced job/attestation/generation semantics, the database-admitted manifest seal, signed Reader cursors, the explicit document-to-paper link command, and the authorization-checked bounded Reader read model.
- `docs/GROUNDED-EVIDENCE.md` defines the authority chain, byte-boundary contract, immutable revision rules, independent review/source states, and retry behavior for Reader capture.
- `docs/CRAWLER-CUSTODY-DELETION.md` defines the destructive command, authorization, storage proof, quota release, derived-text retention, exact retry, and safe failure contract.
- `src/workers/document-validation-worker.ts` and `src/workers/document-extraction-worker.ts` retain reusable one-shot domain behavior and historical polling entrypoints; production calls bounded behavior from Workflow/Sandbox and never deploys the polling loops.
- `services/document-validator/` is the standalone hostile-PDF service with bounded HTTP parsing, subprocess isolation, ClamAV/qpdf wrappers, closed attestations, and safe JSON-line telemetry.
- `services/document-extractor/` is the standalone embedded-text service with bounded HTTP parsing, shell-free Poppler wrappers, deterministic page/paragraph chunks, process-tree deadlines, and redacted telemetry.
- `deploy/document-validator/` and `deploy/document-extractor/` are local/reference contracts for the pinned Sandbox image, not production services.
- `deploy/app/` is the superseded single-host topology and cannot satisfy release preflight.
- `deploy/postgres/` defines the secret-free, exact-table PostgreSQL owner/runtime grant contract; [docs/POSTGRES-ROLES.md](docs/POSTGRES-ROLES.md) documents managed deployment, read-only verification, rollback, and the remaining arbitrary-DML limitation.
- `prisma/schema.prisma` contains auth, organization, canonical-paper, workspace, evidence, connector, sync, job, audit, document, and asset models.
- `prisma/migrations/` is the committed database history. Generated Prisma client files are regenerated by `postinstall` and are ignored.

### Workspace command safety

Every production-shaped mutation contract includes:

- `clientOperationId`, also accepted as `Idempotency-Key`;
- `expectedVersion` for optimistic concurrency;
- server-derived identity and membership checks;
- organization-scoped reads and writes;
- an atomic transaction;
- a durable idempotency receipt containing a request hash, not the raw request;
- an append-oriented audit event for successful state changes.

The project command uses a compare-and-increment organization revision, so two concurrent writes based on the same version cannot both succeed. A repeated operation with the same payload replays its original result; the same key with different intent is rejected.

### Data ownership

Canonical public bibliographic data is separated from private workspace state:

```text
Paper + PaperIdentifier + PaperAuthor
               │
        WorkspacePaper
         ├─ ProjectPaper
         ├─ InboxEntry
         ├─ EvidenceNote
         ├─ Collection membership
         └─ Document / provenance / connector links
```

The Better Auth organization model is PaperPilot's workspace boundary. Membership and role are always resolved from the authenticated session; client-provided user IDs or roles are never authoritative.

### PDF custody boundary

The live Sources page now reserves an idempotent, revision-checked upload session and streams the raw `File` to an authenticated same-origin route. The server enforces declared and actual byte limits, a parameter-free PDF media type, strict filename normalization, per-user/workspace concurrency and retained-byte quotas, a receive lease, a bounded PDF envelope screen, exclusive file creation, and a SHA-256 custody digest. Production storage configuration fails closed unless its root is an absolute, canonical, pre-provisioned private directory outside application-served paths.

A completed transfer becomes `Asset.QUARANTINED` and `Document.PENDING` and atomically creates one deduplicated validation job. It creates no text, fake bibliographic record, Reader access, or project membership. Before leasing an attempt, the worker authenticates an exact same-origin readiness endpoint; a known timeout or service outage backs off without consuming the durable attempt budget, while authentication, redirect, and configuration failures stop the worker. A separately configured worker then verifies the same open object's size/hash, streams it to an isolated validator, validates a strict content-bound attestation, and alone may atomically set the asset/document pair to `READY`. Retry backoff returns to quarantined state; content rejection and dead-letter outcomes remain visible without exposing scanner/storage details. Exact validator rejection evidence remains immutable in the attestation even when the public failure state is deliberately canonicalized.

An accepted validation transaction also enqueues exactly one extraction job bound to that immutable attestation, input hash, size, storage version, policy, and independently configured expected toolchain digest. Before claiming work, the extraction worker requires an exact authenticated readiness identity containing the expected policy, toolchain digest, `poppler` engine, and a valid engine version. PostgreSQL supplies the lease clock. If admission becomes busy after the provisional claim, the worker atomically rewinds that claim without consuming an attempt; deterministic unsupported-input and resource-limit failures dead-letter instead of retrying. The worker then reopens and hashes the same private object before sending its bytes to the extractor. Completion atomically writes an immutable extraction generation and deterministic page/paragraph chunks; database constraints reject incomplete, cross-tenant, cross-document, mutable, or aggregate-inconsistent generations. A `NO_TEXT` result is explicit and creates no chunks.

Linking remains a separate, user-visible command: a permitted workspace member can associate one `READY`, currently accepted PDF with one existing `WorkspacePaper` visible to that member. PostgreSQL admits each immutable extraction only after validating its complete ordered manifest, canonical text, locators, hashes, counts, and byte totals; both extracted and `NO_TEXT` generations receive a compact immutable seal. The Reader API/UI then selects only the authoritative linked document under its current accepted validation, current-policy extraction generation, and exact admission. Each request reads at most the requested 100 chunks plus one boundary predecessor, uses a subject-bound signed continuation, and consumes the authenticated user/workspace/trusted-IP quota. It never falls back to stale text; instead it exposes unavailable, processing, and no-text states, or refreshes pagination when the generation changes. Workspace bootstrap and upload polling use the compact authority projection and do not hydrate text or consume the public Reader budget.

Reader passage capture now accepts only a current admitted manifest and exact endpoint chunk identities, hashes, locators, and zero-based end-exclusive UTF-8 byte offsets. The server reconstructs at most 50,000 quote bytes from authoritative chunks with the canonical `\n\n` delimiter, verifies the client-observed SHA-256 digest, and atomically creates the evidence note, immutable text anchor, project/collection memberships, extraction and user-assertion provenance, audit event, and idempotency receipt. Grounding state (`current`, `superseded`, or `unresolvable`) is independent from researcher review (`captured` or `verified`); a new capture is never silently promoted to verified.

Review and re-anchor are exact authenticated successor commands, not updates. Review preserves the existing quote, anchor, retrieval metadata, and semantics while recording a verified successor and review time. Re-anchor resolves a fresh current Reader selection through the same byte-exact authority path, preserves researcher semantics, and resets review to captured. Both actions retain full visible history, dynamically re-authorize idempotent replays, and keep project/collection indexes on current heads. PostgreSQL rejects anchor mutation/deletion, forged or cross-tenant custody, canonical projects that do not contain the paper, later removal of that custody edge, missing anchor/note cardinality, backdated successors, and multiple successors. Generic metadata imports still cannot assert upload/Zotero/crawler/MCP custody or file document rows.

The reference extractor runs with concurrency one, single-use shutdown after one admitted request, and `restart: always`. That is an immediate shared-UID exposure mitigation, not a production isolation guarantee. Production must create a fresh disposable container or microVM for every extraction request with distinct mount, PID, and user namespaces, reached through private HTTPS with workload identity. The readiness toolchain digest detects deployment drift; because it is self-reported by the service, it is not cryptographic proof of the running binary. Signed or measured immutable release provenance remains a production gate. See [docs/UPLOAD-INTAKE.md](docs/UPLOAD-INTAKE.md), [deploy/document-validator/README.md](deploy/document-validator/README.md), and [deploy/document-extractor/README.md](deploy/document-extractor/README.md) for the custody protocol and runtime release gates.

### WebMCP metadata boundary

The authenticated route `POST /api/workspaces/{workspaceId}/integrations/webmcp/proposals` now accepts one closed, 64-KiB, versioned bibliographic proposal. It applies the existing trusted-origin/session check, current membership and mutation-role authorization, shared rate limit, optimistic workspace revision, tenant-local idempotency, canonical identifier/source deduplication, and serializable transaction. The server assigns `WEB_MCP` Inbox/provenance identity, actor, provider, retrieval time, status, audit metadata, and source IDs; callers cannot assert tenant, project, source, custody, storage, checksum, document, receipt, job, validation, extraction, or Reader fields.

The proposal endpoint deliberately creates metadata only: one reviewable Inbox entry, one provenance record, one idempotency receipt, and one audit event. New retained snapshots carry explicit `schemaVersion: 2` and a domain-separated SHA-256 over code-point-canonical JSON; the exact unversioned v1 shape and its original digest algorithm remain permanently readable without a database rewrite. A candidate PDF URL never sets `hasFullText` and is never fetched. The generic Inbox filing command rejects WebMCP proposals. Canonical promotion is a two-step human-consent flow: `POST /api/workspaces/{workspaceId}/integrations/webmcp/proposals/{inboxEntryId}/approval-challenges` independently freezes a five-minute authority dossier for the exact destination and duplicate intent; only after the browser renders its complete snapshot, digest, and expiry can schema-v2 consent reach `POST /api/workspaces/{workspaceId}/integrations/webmcp/proposals/{inboxEntryId}/approval`. Unknown final outcomes retain and retry the same operation ID and byte-identical body instead of preparing different evidence. Provider metadata and verified DOI/OpenAlex identifiers—not agent claims—create canonical state; identifier-free human review creates no identifiers, and use-existing adds none. An immutable approval row plus deferred PostgreSQL guards bind the retained Inbox, staged digest/provenance, one-use challenge, canonical workspace paper, and exact project edge. WebMCP human activity now also dual-writes one random organization-scoped retained audit principal across Inbox, provenance, approval, and audit records; the legacy live-user links remain temporarily for rolling compatibility, so account erasure is not enabled until the verified backfill/contract phase. Any later PDF follows the existing authenticated upload → quarantine → validation → extraction → explicit-link path, whose physical source remains `BROWSER_UPLOAD`.

This is not yet a direct token-authenticated MCP server. WebMCP proposals remain metadata-only and cannot invoke the separately authorized crawler. The governed crawler has its own cookie/origin-authenticated one-PDF command, affirmative rights declaration, durable authority row, worker, and quarantine receipt; a candidate PDF URL inside a WebMCP proposal is never promoted into that command automatically. See [docs/WEBMCP-INTAKE.md](docs/WEBMCP-INTAKE.md) for the metadata command and custody separation.

### Governed crawler boundary

`POST /api/workspaces/{workspaceId}/integrations/crawler/requests` accepts one closed, versioned acquisition command for an explicit query-free `https://…/*.pdf` URL on port 443. The browser must bind the current workspace revision, policy version, normalized filename, byte ceiling, and affirmative indefinite-research-custody declaration to one idempotency key. The private URL is retained only in tenant-bound authority/provenance rows; list and mutation responses expose a URL-free operational ledger. A response of unknown outcome is retried with the original byte-identical body and key, including across navigation and policy rotation.

The worker refuses incompatible policy or deployment identity before network access. For both the robots request and exact PDF request it resolves all addresses, admits only public unicast destinations, pins the TLS socket to an admitted address while preserving hostname verification, rechecks the path/port/query contract, and waits for a shared origin budget inside the frozen absolute deadline. Redirect responses are rejected in this exact-path first mode; a future redirect-capable mode needs its own frozen destination scope. Robots rules are evaluated over normalized octets; unavailable or malformed policy fails closed except for the deliberately reviewed 404/410 no-policy case. The stream admits only a 2xx, parameter-free PDF response with bounded framing and a valid PDF envelope, writes exclusively to an attempt-specific private path, computes the custody digest during streaming, and never parses PDF structure in the web process.

Success atomically binds the attempt, exact storage identity, receipt, asset, document, Inbox row, provenance, and validation job. Retryable failures preserve a fenced retry time; terminal or post-write failures retain quota until exact cleanup proof. The database rejects cross-tenant joins, mutable frozen policy, forged state transitions, receipt reuse, and deletion of the retained actor/custody graph. Validation, extraction, and explicit paper/project linking remain separate authorities: a crawler success is not a safety verdict and never grants Reader access by itself.

`POST /api/workspaces/{workspaceId}/integrations/crawler/requests/{crawlerImportId}/custody` is a separate, closed, explicitly confirmed command. Owners/admins may retire any workspace crawler copy; a member may retire only their own request. Acceptance immediately closes Reader, cancels/fences work, redacts raw locators, and preserves the exact command for byte-identical retry after an unknown outcome. The worker certifies deletion only against the immutable storage-authority generation that accepted the bytes and releases quota only after writer exclusion plus final/partial namespace absence. PostgreSQL terminal guards prevent a `DELETED` crawler's Document, Asset, Inbox, jobs, ingress cleanup, provenance, validation, or extracted-text graph from being reactivated behind the terminal ledger state.

Private PDF retirement is not whole-record erasure. Immutable receipts, pseudonymous audit/provenance records, user-authored evidence, and any complete extracted-text generation needed by grounded evidence remain. Because one referenced chunk protects its generation as an integrity unit, retained text can include the paper's full extracted text and text unrelated to the saved excerpt. The command proves authoritative object-name removal from the bound storage generation; backup, snapshot, open-descriptor, and storage-media retention remain deployment-policy responsibilities.

### Browser snapshot v3

This section describes the legacy product demo at `/`, not the public `/webmcp/` reader. Its snapshot key is `paperpilot:workspace:v3`, preserving projects, imports, Inbox entries, evidence notes, collections, and the active project together. Legacy v2 snapshots migrate forward, malformed/future data fails safely, and OAuth-style page reloads no longer discard in-memory evidence. The public reader instead uses the separate PDF-digest-qualified `paperpilot:webmcp:v3:<sha>` recovery contract described above.

The demo workspace client adds a bounded `paperpilot:workspace-client:v1` sidecar for optimistic versions and idempotency receipts. This is a demo compatibility layer; the authenticated service uses database receipts.

### Zotero boundary

The current Zotero module is intentionally inbound/read-only. The server boundary:

- implements the OAuth 1.0a request-token, clean callback, access-token, identity-verification, status, and disconnect lifecycle;
- retains only keyed hashes for callback state/request tokens and envelope-encrypted temporary/long-lived secrets;
- atomically claims one callback, erases the temporary secret before commit, and makes replays inert;
- gives claimed callbacks a separate processing lease and reconciles ambiguous database commits before deciding whether a key was persisted;
- routes superseded-key and disconnect revocation only through a serializably claimed, encrypted outbox; exchanged-but-unattributed keys are never automatically deleted because another workspace may already use the same provider key;
- restricts connection management to workspace owners/admins while exposing only credential-free summaries to members/viewers;
- pins `Zotero-API-Version: 3`;
- accepts an opaque connection ID and resolves the credential just in time;
- sends the key in an authorization header, never a URL;
- disables redirects so authorization cannot cross origins;
- validates pagination links against exactly `https://api.zotero.org`;
- preserves versions as strings;
- re-verifies personal/group permissions and requires optimistic, explicit library selection;
- fetches incremental item/collection version manifests, changed bodies in at most 50-key batches, and deletion manifests;
- parses `Backoff`, `Retry-After`, `Last-Modified-Version`, and `Total-Results`;
- stages each pass under a worker/job/connection-generation fence and advances a library cursor only when every response agrees on one provider version and the objects/tombstones/provenance/run state can commit atomically; a failed late CAS throws inside the transaction so partial publication rolls back;
- persists connection-wide `Backoff` even on terminal attempts, schedules default 15-minute selected-library pulls, excludes active/terminal jobs before scheduler batching, and reports exact queued/coalesced dispositions per library;
- revalidates `/keys/current` after a library `403` to distinguish a revoked key from one inaccessible library, and treats the 5 MiB response, 10,000-object, and 64 MiB decoded-pass ceilings as terminal resource limits rather than retry storms;
- strips note and annotation body fields, turns only top-level bibliographic items into reviewable Inbox snapshots, and keeps source identity distinct across personal/group libraries even when DOI metadata matches;
- tombstones deleted source objects and pending source Inbox rows without deleting a filed paper, project membership, quotation, or evidence note;
- returns sanitized capabilities, selection/cursor state, backoff, and sync-run summaries without logging or returning the credential.

The web routes enqueue durable work. `npm run worker:zotero` performs metadata synchronization; `npm run worker:zotero-attachments` performs explicitly requested stored-PDF copies. Both run separately from the web process and share the database plus credential keyring. Note/annotation bodies, streaming-trigger wiring, and two-way write-back remain later connector slices. See [docs/ZOTERO-INTEGRATION.md](docs/ZOTERO-INTEGRATION.md).

## Verification

Run the credential-free repository gate. These commands do not require or start
a database:

```powershell
npm run db:local:freeze-check
npm run supabase:check
npm test
npm run lint
npm run typecheck
npm run db:generate
npm run build
```

`test:integration`, database deployment/role commands, Prisma lifecycle and
migration commands, Studio, validation, and direct SQL execution are currently
blocked. They return only after an isolated remote Supabase test target and a
provider-specific role/migration workflow are implemented and reviewed. The
original E-drive archive is never a test target.

Current automated coverage includes:

- browser snapshot migration, malformed data, deep-clone isolation, and duplicate normalization;
- demo command optimistic concurrency, persistent replay, atomic import/evidence updates, and storage rollback;
- request-ID/header safety, provider URL normalization, bounded JSON/auth bodies, and exact-origin mutation checks;
- transactional-email HTTPS/configuration enforcement, callback-origin validation, token-redacted failures, and reset-link scrubbing;
- shared PostgreSQL auth/discovery/workspace quota boundaries under parallel load;
- Zotero OAuth signing/state, bounded provider bodies, atomic callback consumption, encrypted persistence, claimed-callback expiry, ambiguous commits, fingerprint rotation, cross-workspace same-key races, leased revocation delivery, reconnect/disconnect cleanup, critical-audit fallback, tenant-bound credential lookup, API-origin validation, and browser authorization URL validation;
- Zotero identity/group discovery, explicit optimistic selection and replay, exact 50-key provider batches, stable-version staging/atomic cursor commit, concurrent-claim and repeated-cycle fencing, exact duplicate-trigger dispositions, persistent terminal-attempt provider backoff, resource-limit admission, terminal scheduler suppression, disconnect cleanup, source-specific Inbox/provenance projection, and tombstones that preserve canonical papers and evidence;
- upload-root fail-closed rules, adversarial filenames/media/lengths, fixed-memory PDF envelope screening, attempt-specific exclusive finalization, stalled-stream deadlines, durable cleanup reconciliation, upload replay/conflict, quotas, leases, ambiguous status reconciliation, and cross-tenant denial;
- strict external-validator configuration/stream/response boundaries, exact content/policy/storage binding, fresh signature/timestamp checks, concurrent job claims, heartbeat and stale-worker fencing, retry/dead-letter behavior, immutable attestations, lifecycle database constraints, atomic accepted/rejected promotion, and tampered-object rejection before egress;
- strict external-extractor configuration/stream/response boundaries, exact readiness identity and accepted-attestation/input/toolchain binding, database-owned lease timing, no-budget pre-admission deferral, deterministic dead-letter classification, immutable generation persistence, deferred aggregate checks, and application-to-service compatibility;
- explicit validated-document linking, visibility/relink/conflict denial, durable Inbox link/extraction state, bounded Reader authorization/states/cursors, generation consistency, and response-size ceilings;
- immutable verify/re-anchor successors, A → B → C replay hydration, stale-head and one-successor races, preserved semantic/source custody, head-only filing projections, hidden-lineage non-disclosure, and malformed client read-model rejection;
- PostgreSQL project/import/collection/evidence durability, canonical deduplication, simultaneous retry replay, stale/concurrent writes, source custody, required project-paper custody, private-project visibility, and adversarial compound-FK cross-tenant denial.
- WebMCP public-URL preflight, closed metadata contracts, strict stored-snapshot decoding, source-derived identity, tenant/role authorization, replay and changed-intent conflict, optimistic versions, zero byte-custody side effects, provenance/audit identity, generic-filing denial, and private-project dedupe non-disclosure.
- governed crawler command/configuration admission, cross-policy idempotent replay, no-raw-locator DTOs, tenant/role/quota boundaries, RFC 9309 matching, public-address filtering, hostname-verified pinned TLS, redirect rejection, shared origin pacing, response/PDF/byte deadlines, fenced leases and heartbeats, attempt-specific receipts, retry cleanup, quarantine/validation handoff, exact reload-safe custody-deletion retries, late-writer exclusion, storage-generation proof, evidence-aware text retirement, and reciprocal terminal database guards.

The service slice has also been exercised in the browser through sign-up, live discovery, project creation, reload persistence, sign-out, anonymous redirect, sign-in restoration, the source/provenance-aware import preview, a real raw-PDF transfer, its quarantined Inbox presentation, and post-smoke cleanup. The database suite exercises both Discover-shaped stage → file → refresh and PDF reservation → quarantine/status lifecycles.

## Deployment sequence

For the serverless release, the sequence below is the required Gate 0 path.
The Supabase role, migration, and private-bucket commands are now executable;
the later Workflow/Sandbox steps remain under construction:

1. Link the GitHub repository to a Vercel project and create Preview and
   Production environments. Pin Node, dependency-lock, Workflow, Sandbox, and
   release identity; never configure a VPS/Compose fallback.
2. Provision only Supabase project `avmcmmayvnjxrhrmgsdx`. Create a private
   object bucket, an exact least-privilege runtime role, and the separate
   Supabase-compatible migration authority using the commands in
   `deploy/supabase/README.md`. Runtime Functions/Workflow steps
   use the dashboard-issued Supavisor transaction endpoint on port `6543` with
   prepared statements disabled. Direct port `5432` is migration/bootstrap
   authority only.
3. Put Better Auth, rate-limit, Reader cursor, transactional-email, database,
   Storage, and provider secrets in Vercel environment variables. No browser,
   Workflow argument, or Sandbox receives the database password or Supabase
   server secret key.
4. Run the reviewed migrations and role/grant/sentinel verification from the
   explicit deployment job. Keep traffic closed until authenticated `/readyz`
   proves the exact project, schema, runtime grants, and private bucket.
5. Build, scan, and digest-pin one PDF-tools image containing the reviewed qpdf,
   ClamAV, Poppler, and PaperPilot processing entrypoint. It must run non-root,
   bound CPU/memory/PID/time/output, record tool/signature identities, and emit a
   closed receipt without raw paths or document content.
6. Deploy Next.js with the stable Workflow integration. The upload path is
   reserve → short-lived exact-object signed browser upload → finalize → one
   durable Workflow. The Reader returns a short-lived capability for the exact
   admitted generation; neither path proxies PDF bytes through a Function.
7. Every Workflow attempt creates a native Workflow-serializable Vercel
   Sandbox with `persistent: false` and networking initially `deny-all`. A
   server-only, job-fenced binder installs a short-lived Storage credential in
   an exact host/path/method firewall transform; neither the credential nor a
   signed URL enters Workflow arguments or the guest. The lifecycle restores
   deny-all before parsing, runs extraction only after validation acceptance,
   persists bounded artifacts/receipt, rejects stale leases/results, and
   attempts stop in `finally`.
8. Deploy a Preview and run provider-contract, isolated Supabase, live Sandbox,
   and Playwright gates. Prove success, rejection, timeout, abort, retry with a
   distinct Sandbox ID, no cross-document state, no PDF in Function/Workflow
   payloads, and no secret/content telemetry. Also prove a scheduled idempotent
   reconciler stops tagged Sandboxes left by external Workflow cancellation or
   platform termination; `finally` alone is not accepted as orphan proof.
9. Exercise two unrelated previously unseen PDFs through direct upload,
   admission, centered multi-page Reader render with no transcript, automatic
   structural mapping, spatial text/region anchors, real WebMCP focus/graph/
   navigation/explanation/mutation callbacks, graph ↔ PDF source return,
   human Undo/Redo, explanation Save/Discard, and byte-identical restore. Record
   the exact Vercel URL/deployment, commit, Supabase project, Workflow/Sandbox
   correlations, policy/toolchain identities, accessibility results, and
   sanitized evidence bundle.
10. Promote the verified deployment. Confirm Vercel rollback, Supabase backup
    and restore, Storage recovery/retention, provider quota headroom, structured
    request IDs, HTTPS cookies, key rotation, and explicit quota-exhausted UI.
11. Keep Zotero synchronization, crawler operation, broader networking, and
    semantic retrieval out of the Tuesday runtime unless separately migrated to
    bounded event-driven serverless paths. They cannot reintroduce polling
    workers or shared storage into the WebMCP candidate.

The application boundaries for transactional email, required verification,
password reset, and shared auth/discovery/workspace throttling are implemented.
Public sign-up still requires a deployed delivery receiver plus verified
sender/domain. Production still requires authenticated provider setup,
observability, recovery drills, Preview evidence, and the WebMCP client gates.

## Known boundaries

- Authenticated Discover → Inbox → project import, project detail, collection writes, structured manual evidence, Zotero OAuth connect/status/disconnect, library discovery/selection, durable metadata synchronization, sanitized attachment discovery, opt-in manual stored-PDF import, metadata-only WebMCP proposals, digest-bound human review/OpenAlex-backed canonical promotion, the governed explicit one-PDF crawler plus confirmed custody retirement, PDF quarantine, durable validation/extraction, explicit validated-PDF linking, bounded live Reader pagination, immutable grounded passage capture, explicit review/re-anchor successors, revision-ledger history, and collaborative workspace invitations/roles/rosters/switching are implemented in the existing domain architecture. Separately, the public `/webmcp/` reader has released technical proof for its centered PDF, whole-paper structural map, Graphology/Sigma and DOM outline, six tools, reversible graph/annotation revisions and Undo/Redo; full human accessibility acceptance remains open. Cross-paper graph UI, broad OCR/automatic figure-panel-caption-equation detection, direct MCP authorization, remote WebMCP byte acquisition, collaboration activity, and annotated-PDF export remain subsequent slices. The original PDF stays immutable, and the current scope exposes no PDF writer or export control.
- PDF quarantine is deliberately not a safety verdict. Neither quarantined bytes, metadata, a merely `READY` document, nor unlinked extracted storage unlocks Reader. The Reader serves only an explicitly linked document whose current accepted validation and authoritative current-policy extraction generation agree.
- The validation/extraction contracts, leases, retries, dead letters, immutable attestations/generations, standalone tools, and one-shot worker functions exist. The old polling entrypoints and Compose topologies are not deployable production paths. Gate 0 must build, scan, digest-pin, and adversarially exercise the PDF-tools image in one fresh non-persistent Vercel Sandbox per attempt.
- The reference extractor's single-use mode is only migration input. Production requires a new Sandbox for every attempt, bounded resources, deny-all egress while parsing, exact object capabilities, receipt fencing, and unconditional termination. Its self-reported toolchain digest detects drift only; pinned-image and release evidence are still required.
- The current upload adapter uses a private local filesystem and the current Reader route proxies complete PDFs. Both are explicitly blocked for Vercel release. Direct private Supabase Storage reserve/finalize upload and exact-generation signed Reader download are required before upload traffic is enabled.
- Reader, workspace bootstrap, and upload polling share the same fail-closed validation/extraction authority. PostgreSQL now creates an immutable admission seal only after the complete manifest passes ordered/canonical-text/hash/locator checks; Reader requires that seal, verifies a user/workspace/paper-bound HMAC cursor, and keyset-reads only the requested page plus one boundary predecessor. Bootstrap and upload status fetch no chunk text, and the public Reader route atomically consumes dedicated user/workspace/trusted-IP read budgets. Production must use separate non-owner runtime and migration roles because a table owner or superuser can bypass trigger-based integrity controls.
- The legacy `/` demo Reader still uses bundled papers; the public `/webmcp/` reader accepts arbitrary admitted local PDFs plus an explicit optional Attention download. The authenticated `/app` Reader serves verified chunks only after explicit linking and authoritative extraction; an OpenAlex result remains metadata until that custody path completes. Live Reader capture creates a source-current but researcher-unreviewed `captured` record. Review and source re-anchoring create immutable successors and preserve the prior quote/anchor; they do not turn metadata-only results into possessed full text.
- Zotero connection alone does not import metadata or files: an owner/admin must discover and explicitly select readable libraries, request or await a scheduled metadata run, and keep the metadata worker online. Stored PDFs require a second owner/admin policy decision, one explicit file command, a deployment-reviewed redirect allowlist, and the separate attachment worker. Cursored metadata sync, sanitized attachment projection, fenced download/quarantine handoff, validation/extraction lifecycle projection, tombstones, provider backoff, and provenance are implemented; notes/annotation bodies, streaming notifications, and conflict-aware write-back are not.
- PaperPilot does not directly scrape Google Scholar. Scholar-origin discoveries can enter through user-reviewed Zotero records, identifier/file intake, or the metadata-only WebMCP proposal route. The live crawler is an explicit one-PDF custody command, not a search-results scraper or autonomous discovery spider.
- The crawler first mode and user-directed local custody retirement are implemented, but production enablement must remain allowlisted, policy-aware, rate-limited, separately supervised, and separate from Zotero attachment ingestion. It still requires reviewed deployment values, a durable version-addressable private storage backend, explicit storage-authority generation management, public-origin and deletion-race adversarial drills, monitoring, alerts, backups/retention policy, and recovery runbooks.
- The application has no local-database mode. The approved Supabase profile
  defaults each web/worker process to a conservative five-connection ceiling;
  reconcile the aggregate against the project limit before tuning it.
- Prisma 7.10.0 currently pins an advisory-affected `deepmerge-ts` release in its trusted CLI/config loader. PaperPilot temporarily overrides that transitive package to `8.0.2`, scoped only to `@prisma/config@7.10.0`; remove the override once `@prisma/config` publishes an 8.x dependency, then regenerate the lockfile and rerun the full schema, build, integration, and audit gates. Do not replace this with npm's proposed forced Prisma downgrade.
- PaperPilot has its own repository boundary. Keep credentials, retained documents, local database state, generated clients, dependencies, and build output outside committed history as enforced by the checked-in ignore and build-context policies.

The long-term development plan and exit criteria are in [docs/ROADMAP.md](docs/ROADMAP.md).

## License

PaperPilot is available under the [MIT License](LICENSE).
