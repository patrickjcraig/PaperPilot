# Supabase-only single-host HTTPS deployment

This directory is PaperPilot's Gate 0 deployment skeleton for one Linux host.
It runs the web application, Caddy, the validator/extractor services, their
workers, and private document custody. Durable application records live only in
the approved Supabase project `avmcmmayvnjxrhrmgsdx`.

This Compose project does **not** create, start, mount, initialize, migrate, or
back up a local PostgreSQL database. It contains no PostgreSQL service, database
volume, database TLS leaf, or local database operations profile.

The long-lived topology is:

```text
Internet -> Caddy :80/:443 -> web :3000
                                  -> Supabase PostgreSQL direct endpoint

validation-worker -> Caddy private TLS -> validator -> ClamAV
        |                     |
        +---- Supabase -------+

extraction-worker -> Caddy private TLS -> extractor
        |
        +---- Supabase

web + both workers -> private_data at /private/paperpilot
```

Only Caddy publishes host ports. Validator, extractor, and ClamAV remain on
internal Compose networks. Web and the two database-backed workers join the
external `database_egress` network so they can resolve and reach
`db.avmcmmayvnjxrhrmgsdx.supabase.co:5432`. Compose network membership is an
intent boundary, not a hostname allowlist; use a reviewed host firewall or
egress proxy if the deployment platform can restrict outbound destinations.
Web separately joins `web_egress` for configured transactional email. ClamAV
alone joins `signature_updates` for FreshClam updates.

## What this skeleton does not prove

- A green `/livez` proves only that the web process is alive.
- A green `/readyz` proves that the exact runtime configuration can reach the
  expected migrated schema as `paperpilot_runtime`. It does not prove workers,
  private storage, upload admission, or PDF rendering.
- A green `npm run supabase:check` proves only public endpoint identity, DNS,
  and TCP reachability. It does not prove authentication, roles, migrations, or
  Storage configuration.
- Matching private-volume paths are not shared-storage evidence. Only a real
  upload processed by both workers proves the custody path.
- Compose does not provision Supabase roles or run migrations. Those operations
  remain blocked until the provider-specific role/migration runbook is reviewed
  and completed outside this runtime topology.
- Compose does not operate ChatGPT desktop, prove WebMCP callbacks, render a
  PDF.js page, or complete an NVDA walkthrough.

## Host and provider prerequisites

- A Linux host with Docker Engine and current Compose v2.
- At least 6 GiB of available memory; the ClamAV reference reserves 4 GiB.
- DNS A/AAAA records for the exact public hostname pointing at the host.
- Inbound TCP 80/443 and, if HTTP/3 is retained, UDP 443. Do not publish any
  database, validator, extractor, or ClamAV port.
- Outbound DNS and TCP `5432` reachability from Docker containers to
  `db.avmcmmayvnjxrhrmgsdx.supabase.co`.
- IPv6 support on the deployment host and Docker path. The approved direct
  Supabase endpoint currently resolves to IPv6. If the eventual host is
  IPv4-only, stop: do not substitute a pooler hostname or port. Add a separate
  reviewed provider profile first.
- A Supabase `paperpilot_runtime` login for project
  `avmcmmayvnjxrhrmgsdx`, with the checked-in migrations and exact grants
  already applied through a reviewed provider-specific process.
- The current Supabase database CA downloaded from the project's Connect or
  database SSL settings and stored outside the repository as one regular file.
- A release commit and reviewed immutable image digests. Resolve and scan
  images on the target architecture; never invent a digest to satisfy config.
- Production email delivery or an already provisioned, verified demo identity.
  A fresh database has no sign-in path without delivery; production signup
  intentionally fails closed when delivery is absent.

## 1. Configure without exposing secrets

From this directory:

```sh
cp compose.env.example .env
chmod 600 .env
```

Fill every required blank. The populated `.env` is ignored by Git, but it is
not a secret manager. Restrict the host account and Docker socket, keep the file
out of logs and ordinary backups, and rotate credentials after suspected
disclosure.

Database configuration is deliberately narrow:

- `PAPERPILOT_SUPABASE_DATABASE_URL` must have exactly this authority and shape:

  ```text
  postgresql://paperpilot_runtime:URL_ENCODED_PASSWORD@db.avmcmmayvnjxrhrmgsdx.supabase.co:5432/postgres?sslmode=verify-full
  ```

- Percent-encode the password for the URL user-info component. Do not paste the
  populated URL into source, documentation, command-line arguments, shell
  history, screenshots, logs, or support messages.
- `PAPERPILOT_SUPABASE_DATABASE_CA_CERT_HOST_PATH` must be an absolute host path
  to the downloaded CA file. Compose mounts that single file read-only at
  `/etc/paperpilot/supabase/database-ca.pem` in web and both workers.
- Compose pins `PAPERPILOT_DATABASE_PROFILE` to
  `supabase-avmcmmayvnjxrhrmgsdx-direct-v1`, pins the in-container CA path, and
  sets `PAPERPILOT_ALLOW_LOCAL_PRISMA_DEV=0`. Do not override those values.
- Keep `PAPERPILOT_DATABASE_POOL_MAX` conservative across the three long-lived
  processes. The example starts at `5` connections per process; reconcile the
  aggregate against the Supabase project limit before increasing it.

The Supabase database CA is separate from Caddy's private CA. Caddy's CA trusts
only the internal validator/extractor HTTPS listeners and is exported into the
`internal_ca` volume. It is not used to authenticate Supabase.

Also verify:

- `PAPERPILOT_PUBLIC_ORIGIN` is exactly `https://host.example`, with no path,
  trailing slash, query, fragment, or credentials.
- `PAPERPILOT_RELEASE_ID` identifies the release commit/image and is not a
  placeholder.
- Caddy and application/service images use approved immutable digests.
- Better Auth, rate-limit, Reader cursor, validator, and extractor secrets are
  independent.
- All three `PAPERPILOT_EMAIL_*` values are configured together on a fresh
  database. Leave all three empty only when an audited verified demo identity
  already exists.
- Validator/extractor toolchain values are real lowercase nonzero SHA-256
  digests of retained provenance manifests, not random startup tokens.
- Upload bytes and extractor page limits match the UI and release metadata.

If `172.30.241.0/24` overlaps a host or VPN network, choose an unused private
subnet and update `PAPERPILOT_APP_NETWORK_CIDR`,
`PAPERPILOT_CADDY_APP_ADDRESS`, and
`PAPERPILOT_CADDY_TRUSTED_PROXY_CIDR` together.

Validate interpolation and topology:

```sh
docker compose --env-file .env config --quiet
docker compose --env-file .env config
```

Inspect the rendered configuration without copying it into logs or a ticket;
it contains the database URL. Confirm all of the following:

- Services contain no `postgres` service or local database volume.
- Only Caddy publishes ports.
- Web and both workers receive the exact pinned database profile, CA path,
  local-database prohibition, and supplied Supabase URL.
- Web and both workers mount the same provider CA file read-only.
- Web and both workers join `database_egress`.
- Web and both workers mount the same `private_data` volume.
- No admin, deploy, service-role, or Supabase API key appears in the rendered
  runtime environment.

## 2. Build and initialize internal trust and private storage

Build the three repository images:

```sh
docker compose --env-file .env build web validator extractor
```

Start Caddy, export its public internal-service CA, and initialize private
volume permissions:

```sh
docker compose --env-file .env up -d caddy
docker compose --env-file .env up internal-ca-export
docker compose --env-file .env up storage-init
docker compose --env-file .env ps
```

`internal-ca-export` copies only Caddy's public internal root into
`internal_ca`; it never copies the CA private key or any database certificate.
Web and both workers trust that root through `NODE_EXTRA_CA_CERTS` for their
validator/extractor calls.

There is intentionally no database initialization command here. Do not run the
generic dedicated-cluster bootstrap against Supabase: it assumes a true
superuser and a dedicated non-default database, neither of which matches this
managed profile.

## 3. Verify Supabase before starting application traffic

From the repository root, the credential-free public preflight is safe:

```sh
npm run supabase:check
```

Before starting PaperPilot, separately verify through the reviewed provider
process that:

1. `paperpilot_runtime` exists and has only the intended runtime grants;
2. the complete migration ledger is installed;
3. the current release migration sentinel exists;
4. row security and `search_path` match the application contract; and
5. an authenticated readiness probe succeeds with the downloaded CA.

Do not point the runtime at Supabase while roles or migrations are incomplete.
Do not fall back to a local database to keep the UI running.

## 4. Start the supervised topology

```sh
docker compose --env-file .env up -d --build
docker compose --env-file .env ps
docker compose --env-file .env logs --no-log-prefix --tail=100 web validation-worker extraction-worker
```

Expected long-lived services are Caddy, web, ClamAV, validator,
validation-worker, extractor, and extraction-worker. The two initialization
services exit successfully. There is no PostgreSQL container. Both workers use
`restart: unless-stopped` and stable IDs. The extractor is single-use and
restarts after each admitted extraction by design. Worker commands invoke the
pinned local `tsx` binary directly; production does not load a developer
`.env` file.

Health surfaces:

```text
https://PUBLIC_HOST/livez
https://PUBLIC_HOST/readyz
http://web:3000/livez
http://web:3000/readyz
https://validator.paperpilot.internal:8443/readyz
https://extractor.paperpilot.internal:8443/readyz
```

The last four are Compose-internal. Validator/extractor readiness requires its
dedicated bearer token; liveness is not a substitute. PaperPilot `/readyz`
performs the runtime-role and migration-sentinel check against Supabase.

## 5. Gate 0 verification

From the repository root, keep the deployment environment explicit so Compose
does not read a developer root `.env`:

```sh
docker compose --env-file deploy/app/.env -f deploy/app/compose.yaml config
npm run build
npm run demo:preflight -- --phase infrastructure
```

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
substitute fixture content. This skeleton supplies only topology; public
upload/PDF.js behavior and evidence must come from the corresponding
application and preflight work.

## Backup and rollback

Before the first upload and before every release:

- use Supabase's supported backup/export and restore path for the managed
  database; do not create a local PaperPilot runtime database as a backup;
- take a crash-consistent snapshot of `private_data`;
- retain exact image digests, release commit, environment variable names but
  not values, Supabase project/profile identity, CA fingerprint, Caddy state,
  and the matching migration ledger; and
- restore the managed-database backup and private-volume snapshot together in
  an isolated candidate environment, then run migration/runtime verification.

For an application-only rollback whose database contract is explicitly
backward-compatible, restore the previous immutable `PAPERPILOT_APP_IMAGE` and
release ID, then run:

```sh
docker compose --env-file .env up -d --no-deps web validation-worker extraction-worker
```

For a schema-incompatible rollback, stop web/workers, restore the paired
Supabase and `private_data` snapshots, restore matching image digests and
configuration, re-run exact role/readiness verification, then reopen traffic.
Never run an ad-hoc down migration against retained evidence.

Destructive commands such as `docker compose down --volumes` are intentionally
absent because they would remove uploaded-document, certificate, cache, and
scanner state even though the managed database is external.
