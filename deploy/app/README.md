# Single-host HTTPS deployment

This directory is PaperPilot's Gate 0 deployment skeleton for one dedicated
Linux VPS. It does not deploy anything by itself and is not evidence that the
public upload, PDF.js, WebMCP, or accessibility gates passed.

The long-lived topology is:

    Internet -> Caddy :80/:443 -> web :3000
                                  -> PostgreSQL (runtime role, private TLS)

    validation-worker -> Caddy private TLS -> validator -> ClamAV
    extraction-worker -> Caddy private TLS -> extractor

    web + both workers -> private_data at /private/paperpilot

Only Caddy publishes host ports. PostgreSQL, validator, extractor, and ClamAV
stay on internal Compose networks. ClamAV alone also joins the
signature_updates network so FreshClam can update its persistent signatures.
The workers have no ordinary outbound network in this Gate 0 topology. Web has
an outbound network only for its configured transactional-email HTTPS webhook;
do not treat that network boundary as a destination allowlist. ClamAV alone
also has outbound access for signature updates.

## What this skeleton does not prove

- A green /livez proves only that the web process is alive.
- A green /readyz proves release configuration, the runtime database role, and
  the migration sentinel expected by the current image. It does not prove the
  workers or shared storage.
- Matching path strings are not shared-storage evidence. Only a real upload
  processed by both workers proves the custody path.
- Compose does not operate ChatGPT desktop, prove WebMCP callbacks, render a
  PDF.js page, or complete an NVDA walkthrough.
- The internal Caddy leaf used for PostgreSQL is a time-bounded single-host
  convenience. Regenerate it and restart PostgreSQL before it expires.

## Host prerequisites

- A dedicated Linux VPS with Docker Engine and current Compose v2.
- At least 6 GiB of available memory; the ClamAV reference reserves 4 GiB.
- DNS A/AAAA records for the exact public hostname pointing at the VPS.
- Inbound TCP 80/443 and, if HTTP/3 is retained, UDP 443. Do not open database,
  validator, extractor, or ClamAV ports.
- A fresh dedicated PostgreSQL cluster/volume. The checked-in bootstrap refuses
  a shared application cluster or legacy schema.
- A release commit and reviewed immutable registry digests for Caddy and
  PostgreSQL. Resolve and scan images on the target architecture; never invent
  a digest merely to satisfy configuration.
- Production email delivery or an already provisioned, verified demo identity.
  A fresh database has no sign-in path without delivery; PaperPilot
  intentionally fails closed for production signup when delivery is absent.

## 1. Configure without exposing secrets

From this directory:

    cp compose.env.example .env
    chmod 600 .env

Fill every blank. Use independent base64url secrets so passwords are safe
inside the repository's closed PostgreSQL URLs.

- PAPERPILOT_PUBLIC_ORIGIN is exactly https://host.example, with no path,
  trailing slash, query, fragment, or credentials.
- PAPERPILOT_RELEASE_ID identifies the release commit/image and is not a
  placeholder.
- Caddy and PostgreSQL image values contain approved immutable digests.
- Admin, runtime, deploy, Better Auth, rate-limit, Reader cursor, validator,
  and extractor secrets are all different.
- On a fresh database, all three PAPERPILOT_EMAIL_* values are configured
  together. The webhook is exact HTTPS, its bearer secret is independent, and
  the sender address is valid. Leave all three empty only when an audited,
  verified demo identity already exists.
- Validator/extractor toolchain values are real lowercase nonzero SHA-256
  digests of retained provenance manifests, not random startup tokens.
- Upload bytes and extractor page limits match the UI and release metadata.

The populated .env is ignored by Git, but it is not a secret manager. Restrict
the VPS account and Docker socket, keep the file out of logs and ordinary
backups, and rotate credentials after suspected disclosure. Admin/deploy
credentials are injected only into explicit operations-profile containers;
web and workers receive only the runtime database credential.

If 172.30.241.0/24 overlaps a host or VPN network, choose an unused private
subnet and update PAPERPILOT_APP_NETWORK_CIDR,
PAPERPILOT_CADDY_APP_ADDRESS, and
PAPERPILOT_CADDY_TRUSTED_PROXY_CIDR together.

Validate interpolation and topology:

    docker compose --env-file .env config --quiet
    docker compose --env-file .env config

Inspect the rendered configuration. Only caddy may publish ports. Web and both
workers must mount the same private_data volume. Privileged database URLs must
occur only on operations-profile services.

## 2. Build and initialize private trust and storage

Build the three repository images:

    docker compose --env-file .env build web validator extractor

Start Caddy, export only its public internal CA plus the PostgreSQL leaf/key,
initialize private-volume permissions, and start the dedicated database:

    docker compose --env-file .env up -d caddy
    docker compose --env-file .env up internal-tls-export
    docker compose --env-file .env up storage-init
    docker compose --env-file .env up -d postgres
    docker compose --env-file .env ps

internal-tls-export never copies Caddy's CA private key into application trust.
It copies the public root to internal_ca and only the PostgreSQL leaf
certificate/private key to postgres_tls. Web and workers trust the public root
through NODE_EXTRA_CA_CERTS. The PostgreSQL image UID/GID must match the values
reviewed in .env; a mismatch fails startup rather than loosening key
permissions.

## 3. Bootstrap roles, migrate, and close deployment authority

These commands intentionally remain separate. Stop at the first failure. Never
replace this path with Prisma db push, broad grants, or a runtime-owner
credential.

On the first dedicated database, and whenever a retired deploy login must be
reopened with a newly rotated password:

    docker compose --env-file .env --profile operations run --rm db-bootstrap
    docker compose --env-file .env --profile operations run --rm db-role-provision

db-bootstrap runs the checked-in provider-admin role contract.
db-role-provision sets the fixed runtime credential and creates or reopens the
short-lived paperpilot_deploy login with direct database CONNECT plus
non-admin, non-inheriting, SET-capable membership in the NOLOGIN migration
owner. PostgreSQL 16 or newer is required for that exact membership contract.
This self-hosted bootstrap uses the dedicated image's true superuser and must
never target a shared cluster.

Deploy the checked-in migration ledger, verify it, and reconcile exact runtime
grants:

    docker compose --env-file .env --profile operations run --rm db-release

Then remove the deploy login's ability to authenticate, revoke its owner
membership/direct database privilege, terminate its sessions, and verify the
runtime role:

    docker compose --env-file .env --profile operations run --rm db-retire-deployer
    docker compose --env-file .env --profile operations run --rm db-verify

Do not start web traffic unless all five operations completed for the exact
release artifact. Repeat role-provision, release, retire, and verify for later
migrations with a newly rotated deploy password.

## 4. Start the supervised topology

    docker compose --env-file .env up -d --build
    docker compose --env-file .env ps
    docker compose --env-file .env logs --no-log-prefix --tail=100 web validation-worker extraction-worker

Expected long-lived services are caddy, web, postgres, clamav, validator,
validation-worker, extractor, and extraction-worker. The two initialization
services exit successfully; the database operations profile remains stopped.
Both workers use restart: unless-stopped and stable IDs. The extractor service
is single-use and restarts after each admitted extraction by design.
The worker commands invoke the pinned local tsx binary directly; production
does not copy or load a developer .env file. ClamAV is healthy only after an
actual clamd PING succeeds, with a six-minute signature-load start period.

Health surfaces:

    https://PUBLIC_HOST/livez
    https://PUBLIC_HOST/readyz
    http://web:3000/livez
    http://web:3000/readyz
    https://validator.paperpilot.internal:8443/readyz
    https://extractor.paperpilot.internal:8443/readyz

The last four are Compose-internal. Validator/extractor readiness requires its
dedicated bearer token; liveness is not a substitute. PostgreSQL pg_isready is
only a process/startup dependency. PaperPilot /readyz performs the runtime-role
and migration-sentinel check.

## 5. Gate 0 verification

From the repository root, run the checklist commands. Keep the deployment
environment explicit so Compose does not accidentally read a developer root
`.env` instead of `deploy/app/.env`:

    docker compose --env-file deploy/app/.env -f deploy/app/compose.yaml config
    npm run build
    npm run demo:preflight -- --phase infrastructure

Then, on the exact public HTTPS origin, sign in and upload a previously unseen
valid bounded PDF. Record:

1. honest checking, page, and text states;
2. validator and extractor authenticated readiness;
3. both supervised workers running without restart churn;
4. admission of the exact uploaded bytes;
5. first-page render from that admitted generation; and
6. a second consecutive fresh upload within the release window.

Also exercise a non-PDF, encrypted PDF, oversized file, and unavailable worker.
None may become Ready, expose another paper, reveal a private path, or
substitute fixture content. This slice supplies only topology; public
upload/PDF.js behavior and evidence must come from the corresponding
application and preflight work.

## Backup and rollback

Before the first upload and before every release:

- take a tested PostgreSQL physical or custom-format logical backup;
- take a crash-consistent snapshot of private_data;
- retain exact image digests, release commit, environment variable names but
  not values, Caddy state, and the matching migration ledger; and
- restore database and private volume together in an isolated candidate
  environment and run role/migration/runtime verification there.

For an application-only rollback whose database contract is explicitly
backward-compatible, restore the previous immutable PAPERPILOT_APP_IMAGE and
release ID, then run:

    docker compose --env-file .env up -d --no-deps web validation-worker extraction-worker

For a schema-incompatible rollback, stop web/workers, restore the paired
pre-release PostgreSQL and private_data snapshots, restore matching image
digests and configuration, re-run exact role/readiness verification, then
reopen traffic. Never run an ad-hoc down migration against retained evidence
and never delete a named volume as a rollback technique.

Destructive commands such as docker compose down --volumes are intentionally
absent because they would remove database, uploaded-document, certificate, and
scanner state.
