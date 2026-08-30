# PaperPilot Supabase direct-connection profile

This directory records the provider-specific connection boundary for the
Supabase project whose public project reference is `avmcmmayvnjxrhrmgsdx`.
It does not contain a database password, API key, service-role key, or migrated
data.

## Approved runtime profile

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

The application and readiness probe accept this profile only when every value
above matches. A different Supabase project, arbitrary `*.supabase.co` host,
shared-pooler hostname, port `6543`, default `postgres` login, missing password,
missing/invalid CA bundle, query-level host/service/CA override, or weaker TLS
mode fails before network I/O.
Leaving `PAPERPILOT_DATABASE_PROFILE` empty preserves the existing generic and
local PostgreSQL contract.

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

## Local secret configuration

Keep the real password only in the ignored root `.env` file or an external
secret manager. Percent-encode it for the URL user-info component; do not paste
the password into source, documentation, command-line history, screenshots, or
support messages.

```dotenv
PAPERPILOT_DATABASE_PROFILE="supabase-avmcmmayvnjxrhrmgsdx-direct-v1"
PAPERPILOT_DATABASE_CA_CERT_PATH="E:/PaperPilot-Secrets/supabase-prod-ca.pem"
DATABASE_URL="postgresql://paperpilot_runtime:URL_ENCODED_DATABASE_PASSWORD@db.avmcmmayvnjxrhrmgsdx.supabase.co:5432/postgres?sslmode=verify-full"
DATABASE_POOL_MAX="5"
PAPERPILOT_ALLOW_LOCAL_PRISMA_DEV=""
```

`URL_ENCODED_DATABASE_PASSWORD` is intentionally a placeholder. Do not run the
application with the example value.

Download the current database CA from the project's Supabase **Connect** or
database SSL settings and place it outside the repository. The configured path
must be absolute, at most 1,024 characters, and identify a readable regular
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
check. If a future runtime is IPv4-only,
copy the exact Session pooler hostname from the Supabase dashboard and add a
separate reviewed profile. Do not repurpose this direct profile or broadly
allow all pooler hosts. Transaction mode on port `6543` is not approved for the
current persistent Prisma/worker topology.

## Deliberate migration boundary

This profile only closes and activates runtime URL validation. It does not
claim that the database is provisioned. Before changing the working local
database:

1. create the `paperpilot_runtime` role using a Supabase-reviewed role setup;
2. reconcile the existing migrations and ownership/grant contract against
   Supabase's managed-role restrictions in a disposable project or branch;
3. download and install the current Supabase database CA required by
   `sslmode=verify-full` outside the repository, then set the absolute
   `PAPERPILOT_DATABASE_CA_CERT_PATH` only in server-side configuration;
4. run the focused URL test, then the schema, role, integration, and readiness
   gates; and
5. keep the E-drive local database as rollback until a complete arbitrary-PDF
   workflow and provenance trail pass against Supabase.

Do not run the generic dedicated-cluster bootstrap blindly against Supabase.
It requires a true PostgreSQL superuser and a dedicated non-default application
database, while this managed profile targets the provider-owned `postgres`
database. A future provider-specific role/migration runbook must make those
differences explicit instead of weakening `deploy/postgres`.

Run the no-network focused contract test with:

```powershell
npx tsx --conditions=react-server --test src/lib/postgres-client-config.test.ts src/lib/postgres-connection-url.test.ts src/server/operations/health.test.ts
```
