# PaperPilot local host and pgAdmin

This is the supported no-cost Windows development topology. It keeps the web app on loopback, keeps PaperPilot's persistent Prisma Dev database on the repository drive, and uses pgAdmin only as a PostgreSQL client.

It is not the public release topology and does not by itself prove public HTTPS, container isolation, production database roles, validator/extractor supervision, or a judge-accessible WebMCP deployment.

## Topology

```text
Browser
  -> http://127.0.0.1:3000
       -> PaperPilot / Prisma adapter
            -> 127.0.0.1:51218
                 -> <checkout-drive>:\PaperPilot-Prisma-Dev\...\Data\paperpilot

pgAdmin Desktop
  -> 127.0.0.1:51218
       -> the same PaperPilot development database

Prisma migrations only
  -> 127.0.0.1:51219
       -> the named shadow database
```

The launcher also reserves `51213` for Prisma Dev's control endpoint. All three ports are configurable in `.env`, but the application URL, shadow URL, and pgAdmin registration must be updated together.

## Start the stack

From the repository root:

```powershell
npm install
npm run db:dev
npm run db:migrate
npm run db:generate
npm run dev:local
```

`npm run db:dev` starts the detached named instance `paperpilot`. On Windows, always use the repository launcher. Running `npx prisma dev` directly bypasses the drive-scoped `LOCALAPPDATA`, temporary, and npm-cache redirection and can recreate state under the system drive.

If the named database exists but is stopped:

```powershell
npm run db:dev -- dev start paperpilot
```

Do not manually delete `.lock`, `postmaster.pid`, or `.pglite` files.

## Install and register pgAdmin

Install pgAdmin 4 from its Windows Package Manager identity:

```powershell
winget install --id PostgreSQL.pgAdmin --exact `
  --accept-package-agreements `
  --accept-source-agreements
```

Import [`pgadmin-servers.json`](./pgadmin-servers.json) in pgAdmin or create the server manually with:

| Field | Value |
| --- | --- |
| Name | `PaperPilot Local` |
| Host | `127.0.0.1` |
| Port | `51218` |
| Maintenance database | `template1` |
| Username | The user component of the ignored local `.env` `DATABASE_URL` |
| Password | The password component of the same URL |
| SSL mode | `Disable` |

The checked-in profile intentionally contains no password. Enter it when pgAdmin connects; save it only through pgAdmin's local credential mechanism if desired. Never add the password to this JSON file, README, screenshots, or Git.

The shadow database at `51219` exists only for Prisma migration work. Do not browse or edit it as the application database.

## Verify

With PaperPilot running:

```powershell
npm run local:check
```

The check fails unless all of the following are true:

- the Prisma runtime and named PaperPilot data directory exist on the checkout drive;
- the direct and shadow URLs are explicit, loopback-only, and use different ports;
- a fresh PostgreSQL client connection succeeds;
- database identity, row-security setting, and public table inventory are readable;
- pgAdmin is installed at a supported path or `PAPERPILOT_PGADMIN_EXE` points to it; and
- `/livez` and `/readyz` both return success from the loopback application.

The output is sanitized and never prints a password.

For a direct visual check, open:

- `http://127.0.0.1:3000/`
- `http://127.0.0.1:3000/sign-up`
- `http://127.0.0.1:3000/app`

In pgAdmin, expand `PaperPilot` → `PaperPilot Local` → `Databases` → `template1` → `Schemas` → `public` → `Tables`.

## Data-location contract

On Windows, the expected persistent root is derived from the checkout drive:

```text
<checkout-drive>:\PaperPilot-Prisma-Dev
```

The named database is beneath:

```text
<checkout-drive>:\PaperPilot-Prisma-Dev\LocalAppData\prisma-dev-nodejs\Data\paperpilot
```

The pgAdmin executable and its small desktop preferences may live under the Windows user profile on `C:`. Those files are not the PaperPilot database. Database rows and Prisma Dev persistence remain under the configured runtime root.

## Stop and recover

Stop only the named database through the launcher:

```powershell
npm run db:dev -- dev stop paperpilot
```

Restart it with:

```powershell
npm run db:dev -- dev start paperpilot
```

If the port changes because the named instance is intentionally recreated, update these together before restarting the app:

- `PAPERPILOT_PRISMA_DEV_DB_PORT`;
- `PAPERPILOT_PRISMA_DEV_SHADOW_DB_PORT`;
- `DATABASE_URL`;
- `SHADOW_DATABASE_URL`; and
- `deploy/local/pgadmin-servers.json` or the matching pgAdmin server registration.

Do not move or delete the runtime directory while Prisma Dev is running. Back up the complete named data directory before any intentional migration to a different PostgreSQL server.
