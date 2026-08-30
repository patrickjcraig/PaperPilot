# PaperPilot Supabase serverless connection profiles

This directory records the provider-specific connection boundary for the
Supabase project whose public project reference is `avmcmmayvnjxrhrmgsdx`.
It does not contain a database password, API key, service-role key, or migrated
data.

## Approved Vercel runtime profile

The serverless release uses the exact **Supavisor transaction-mode** connection
shown by this project's Supabase dashboard:

| Setting | Required value |
| --- | --- |
| `PAPERPILOT_DATABASE_PROFILE` | `supabase-avmcmmayvnjxrhrmgsdx-transaction-v1` |
| Project reference | `avmcmmayvnjxrhrmgsdx` |
| Host | Exact transaction-pooler hostname copied from the project dashboard; never a wildcard |
| Port | `6543` |
| Database | `postgres` |
| PostgreSQL role | Exact project-scoped `paperpilot_runtime` identity issued for the pooler |
| TLS | Certificate and hostname verification enabled |
| Client behavior | Prepared statements disabled; no session-state, `LISTEN`, or session-lock dependency |

The exact pooler hostname is deliberately not invented in this repository.
`PAPERPILOT_SUPABASE_POOLER_HOST` must contain the exact non-secret hostname
from Supabase **Connect**. The connection parser verifies that value, the
project-scoped username, port, database, password presence,
`sslmode=verify-full`, and `pgbouncer=true` before any socket opens. It rejects
the direct endpoint for Vercel Function/Workflow traffic.

## Legacy direct runtime profile — not a migration authority

| Setting | Exact value |
| --- | --- |
| `PAPERPILOT_DATABASE_PROFILE` | `supabase-avmcmmayvnjxrhrmgsdx-direct-v1` |
| Project reference | `avmcmmayvnjxrhrmgsdx` |
| Host | `db.avmcmmayvnjxrhrmgsdx.supabase.co` |
| Port | `5432` |
| Database | `postgres` |
| PostgreSQL role | `paperpilot_runtime` |
| TLS mode | `verify-full` |
| CA path variable | `PAPERPILOT_DATABASE_CA_CERT_PATH` |

The legacy profile is retained only for the old Compose demo preflight. The
application parser no longer accepts it. It is not an approved Vercel release
profile and is not a migration/admin profile.

Do not install it in Vercel Function, Workflow, browser, or Sandbox
environments, and do not point `db:deploy` at it. A different Supabase project,
arbitrary `*.supabase.co` host, default `postgres` login, missing password,
missing/invalid CA bundle, query-level host/service/CA override, or weaker TLS
mode still fails before network I/O. There is no writable local-database
fallback.

## Credential-free endpoint preflight

Run the public routing check before installing any secret:

```powershell
npm run supabase:check
```

A green result proves only that the exact REST and Storage gateways identify
this project, the direct database hostname resolves, and TCP port `5432` is
reachable from the current machine. The result explicitly lists database
authentication, database roles, migrations, the private Storage bucket, and
Storage credentials as unverified. It never reads or prints those credentials.

## Migration and bootstrap profiles

The repository now has two purpose-fenced direct profiles:

| Use | Profile | Login |
| --- | --- | --- |
| One-time role bootstrap | `supabase-avmcmmayvnjxrhrmgsdx-bootstrap-v1` | provider-managed `postgres` |
| Reviewed Prisma release | `supabase-avmcmmayvnjxrhrmgsdx-migration-v1` | `paperpilot_migration_owner` |

Both require the exact direct project host, port `5432`, database `postgres`,
`sslmode=verify-full`, and an explicit password. The runtime, migration, and
bootstrap profiles reject one another. `prisma.config.ts` permits only offline
`generate` and exact `migrate deploy`; `migrate dev`, reset, db push, Studio,
shadow databases, loopback targets, and transaction-pooler migrations remain
blocked.

The generic files under `deploy/postgres` still target a dedicated PostgreSQL
cluster and must not be run against Supabase. PaperPilot's provider-specific
bootstrap changes only `paperpilot_migration_owner`, `paperpilot_runtime`, and
their exact schema privileges. The grant reconciler scopes changes to the
checked-in 57-table manifest, the migration ledger, and migration-owner
functions; it does not transfer ownership of `public` or rewrite provider
database ACLs.

Node and Prisma use verified system trust roots by default. If the project
requires a private/custom CA, download it from Supabase **Connect** or database
SSL settings and place it outside the repository. The configured path must be
absolute, at most 1,024 characters, and identify a readable regular
non-symlink file containing only one to eight valid CA certificate blocks with
a total size of at most 65,536 bytes. PaperPilot loads those bytes once into
the server-side PostgreSQL client configuration with
`rejectUnauthorized: true`; hostname verification remains enabled. The
validated `sslmode=verify-full` is removed only from the internal driver copy
of the URL because `pg` otherwise replaces an explicit CA object with values
parsed from the connection string. User-supplied `sslrootcert`, `ssl`, and all
other query parameters remain rejected.

The direct endpoint currently resolves to IPv6 from this workstation, which can
also establish TCP connectivity to it. That is not a credential or migration
check. The runtime pooler hostname must be copied independently from the
Supabase dashboard. Do not repurpose the legacy direct runtime profile or
broadly allow all pooler hosts.

## Setup sequence

The code path is ready, but no remote claim is made until the credentialed
commands succeed against the project. Never paste credentials into Git, an
issue, a Workflow input, or chat.

1. In Supabase **Connect**, copy the exact transaction-pooler hostname and URLs.
   Create strong independent passwords for `paperpilot_migration_owner` and
   `paperpilot_runtime`. Fill a gitignored `.env`; keep only the transaction
   runtime variables in Vercel later.
2. Temporarily configure the bootstrap URL and run
   `npm run supabase:roles:bootstrap`. Remove the bootstrap variables from the
   shell immediately afterward.
3. Run `npm run db:deploy` with only the exact migration profile/URL installed.
   This applies the checked-in Prisma chain directly as
   `paperpilot_migration_owner`.
4. Run `npm run supabase:roles:reconcile` to remove public/managed Data API
   access from PaperPilot-owned objects and grant only the reviewed runtime
   manifest.
5. Create a named server secret key in Supabase, configure
   `PAPERPILOT_SUPABASE_SECRET_KEY`, then run
   `npm run supabase:storage:apply`. The command creates or reconciles exactly
   `paperpilot-private-pdfs` as private, PDF-only, and 25 MiB maximum.
6. Run `npm run supabase:storage:check`, `npm run local:check`, the test suite,
   and one live pooler readiness/smoke check before installing Vercel secrets.

The Supabase CLI is pinned as a development dependency for later project-link,
JWT-signing-key, and migration inspection work. No command in this setup starts
the local Supabase stack.

Do not run the generic dedicated-cluster bootstrap against Supabase.
It requires a true PostgreSQL superuser and a dedicated non-default application
database, while this managed profile targets the provider-owned `postgres`
database. The provider-specific replacement must make those differences
explicit instead of weakening `deploy/postgres` or elevating the runtime role.

Run the no-network focused contract test with:

```powershell
npx tsx --conditions=react-server --test src/lib/postgres-client-config.test.ts src/lib/postgres-connection-url.test.ts src/server/operations/health.test.ts
```
