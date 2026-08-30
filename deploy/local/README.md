# Retired PaperPilot local database

PaperPilot no longer supports a writable local application database. The
retained Prisma Dev state under `E:\PaperPilot-Prisma-Dev` is an offline archive,
not a development server, test database, pgAdmin target, or rollback runtime.

This requirement supersedes the earlier local-host workflow recorded in the
Git history and guided-build journal.

## Hard invariants

- No PaperPilot web process or worker may connect to `localhost`, `127.0.0.1`,
  `::1`, or any local PostgreSQL port. The freeze evidence checks standard port
  `5432` plus retired Prisma Dev ports `51213`, `51218`, and `51219`.
- `PAPERPILOT_ALLOW_LOCAL_PRISMA_DEV` must be `0`; setting it to `1` fails
  readiness and the local-write freeze check.
- `DATABASE_URL` is either absent while the app is intentionally unavailable or
  targets the exact approved Supabase profile.
- `SHADOW_DATABASE_URL` stays empty. `prisma migrate dev` is disabled.
- `db:dev`, `db:migrate`, `db:studio`, and database integration tests using the
  ordinary `.env` intentionally fail.
- The original archive is never started for inspection. PostgreSQL-compatible
  engines can update control, lock, statistics, or WAL state even during a
  nominally read-only session.
- No pgAdmin registration is shipped. Do not create one for the archive.

## Verify the freeze

From the repository root:

```powershell
npm run db:local:freeze-check
```

The command performs no database query, file write, or process start. It fails
unless:

- the exact Supabase profile is selected;
- the local compatibility escape hatch is disabled;
- no configured database authority points to loopback or an unapproved host;
- no shadow database is configured;
- standard PostgreSQL plus the retired control, direct, and shadow ports have no
  listeners on IPv4 or IPv6 loopback; and
- an indeterminate socket probe fails closed instead of being treated as proof
  that a port is closed.

A green result is `local_database_write_frozen`. It does not claim that
Supabase authentication, roles, migrations, or Storage are ready.

## Emergency stop only

If a retired Prisma Dev daemon is unexpectedly observed, stop the exact named
instance with:

```powershell
npm run db:local:stop
```

The repository launcher accepts only that stop operation. Start, restart,
listing/inspection, arbitrary instance names, and migration operations are
rejected.

Do not delete or move the archive as part of the freeze. Any future recovery or
inspection must first define a byte-stable copy-and-hash procedure that never
starts the original archive and has explicit project-owner approval.
