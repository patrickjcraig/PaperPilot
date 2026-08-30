# PostgreSQL least-privilege deployment

> **Superseded execution path (2026-08-29):** this document preserves the
> reviewed dedicated-cluster authority design as architecture evidence. The
> approved live target is now only Supabase project `avmcmmayvnjxrhrmgsdx`.
> Every `db:deploy`, `db:roles:*`, `db:migrations:verify`, and
> `db:authority:snapshot` package command is intentionally disabled until an
> equivalent Supabase-specific role, CA, migration, and verification workflow
> is implemented and reviewed. None of the commands below may be run against
> the stopped local archive.

PaperPilot's production database contract uses two fixed roles in one dedicated
PostgreSQL cluster per environment:

- `paperpilot_migration_owner` is a `NOLOGIN` object owner. Prisma migrations
  execute as this role through a short-lived deployment identity.
- `paperpilot_runtime` is the application login. It owns no database object and
  receives only `CONNECT`, schema `USAGE`, and reviewed DML on the exact Prisma
  application tables. `RetainedAuditPrincipal` is narrower: table `SELECT`,
  column `INSERT` only for its live identity fields, and `UPDATE(id)` solely so
  `SELECT ... FOR SHARE` can lock an immutable row; it has no delete/detach grant.

PostgreSQL roles are cluster-wide. The role names are fixed so reviewed SQL, the manifest, and the verifier cannot
disagree through operator-supplied identifier interpolation. Neither checked-in
SQL file accepts or contains a password. Staging and production may not share a
cluster: bootstrap refuses peer application databases and closes runtime access
to the remaining maintenance/template databases.

## What the contract denies

The runtime role is `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`,
`NOREPLICATION`, and `NOBYPASSRLS`. It is not a member of the migration owner or
any other role. It cannot create schemas or temporary tables, own or alter
application objects, read Prisma's `_prisma_migrations` ledger, use sequences,
use application types to create dependencies, directly execute application functions except six exact non-mutating helpers
needed by installed integrity triggers, create/replace/disable triggers, set
`session_replication_role` through either `SET` or `ALTER SYSTEM`, or obtain `TRUNCATE`, `REFERENCES`, or `TRIGGER`
table privileges.

PostgreSQL large objects are closed explicitly. Denying database/schema CREATE
does not stop the normally PUBLIC-executable `lo_create`, `lo_creat`,
`lo_from_bytea`, and `lo_import` entry points from manufacturing caller-owned
objects. The provider-admin bootstrap revokes those exact signatures from both
PUBLIC and runtime, and the live verifier proves the denial. PaperPilot uses its
private object-storage boundary and ordinary bounded columns; it does not use
PostgreSQL large objects.

Application trigger functions remain callable by their triggers; the runtime
credential cannot invoke those trigger entry points directly. Trigger functions
execute as the row writer and several call ordinary validation/locking helpers,
so the exact six helper signatures in the manifest retain `EXECUTE`. They acquire
advisory locks, compute/validate immutable text manifests, or evaluate retained
WebMCP provenance; they do not mutate tables or run with `SECURITY DEFINER`.

The current 55-table Prisma schema has no sequences. Introducing an auto-incrementing
field, a view, a sequence, a new model, or a direct application function call is
a permission-design change: update the manifest, grant SQL, verifier, and tests
in the same reviewed change.

## Files and static verification

- [`deploy/postgres/01-bootstrap-roles.sql`](../deploy/postgres/01-bootstrap-roles.sql)
  creates/reasserts exact role attributes/settings, removes third-party
  database/schema/default ACLs, and gives runtime only the reviewed entry grants.
- [`deploy/postgres/migration-preflight.sql`](../deploy/postgres/migration-preflight.sql)
  is the read-only gate executed through the exact connection used by Prisma.
- [`deploy/postgres/02-runtime-grants.sql`](../deploy/postgres/02-runtime-grants.sql)
  runs after migrations, checks exact tables and ownership, revokes stale grants,
  and applies the reviewed DML allowlist.
- [`deploy/postgres/runtime-access-manifest.json`](../deploy/postgres/runtime-access-manifest.json)
  is the machine-readable contract used by verification.
- [`scripts/postgres/verify-runtime-role.mjs`](../scripts/postgres/verify-runtime-role.mjs)
  performs a catalog-only audit inside an explicit read-only transaction.
- [`scripts/postgres/verify-migration-ledger.mjs`](../scripts/postgres/verify-migration-ledger.mjs)
  compares every completed Prisma ledger row and checksum with the exact
  checked-in migration directories through a separate deployment identity.
- [`scripts/postgres/deploy-migrations.mjs`](../scripts/postgres/deploy-migrations.mjs)
  validates the base deploy URL, adds only the fixed owner startup policy,
  runs the preflight, and maps that result to Prisma's child-only `DATABASE_URL`.
- [`scripts/postgres/snapshot-authority.mjs`](../scripts/postgres/snapshot-authority.mjs)
  prints the complete normalized read-only function, trigger, and live-schema
  inventory used to review manifest digests.
- [`scripts/postgres/smoke-runtime-role.mjs`](../scripts/postgres/smoke-runtime-role.mjs)
  proves ordinary and retained-principal runtime writes plus all six helper
  calls inside a transaction that is always rolled back.

Run the offline gate without a database:

```powershell
   npm run db:roles:test
```

That test fails if the Prisma models, SQL allowlist, and manifest diverge, if the
grant surface expands, or if the verifier stops checking a required denial.

## Managed PostgreSQL deployment order

Use a fresh, dedicated PaperPilot PostgreSQL cluster and application database
on PostgreSQL 15 or newer. PaperPilot exclusively controls `public`; these
commands are unsupported on a shared cluster, database, or schema. Bootstrap
rejects peer application databases, refuses implicit ownership adoption, resets
   stale fixed-role settings, removes every explicit parameter privilege from
   PUBLIC and both fixed roles, and makes current database, `public`, and owner
   default ACLs exact. A legacy conversion requires a separate reviewed procedure;
   never substitute blanket `REASSIGN OWNED`.

All privileged URLs below are short-lived deployment secrets. Inject them as
masked process environment variables on an isolated runner—never put a full URL
on a command line, in `.env`, logs, source, image layers, or shell history. The
checked-in Node wrappers validate destinations before I/O and do not print URLs.

1. Provision the dedicated cluster/database and prove backup and restore before
   accepting data. Use different clusters and credentials per environment.
2. Inject `PAPERPILOT_ADMIN_DATABASE_URL` for a provider administrator with the
   exact role, membership, database/schema/default-ACL, parameter-ACL, and
   system-function powers required by the bootstrap. On PostgreSQL 16 or newer,
   the generic bootstrap requires a true PostgreSQL superuser and fails before
   creating either fixed role otherwise. PostgreSQL 16+ automatically grants a
   non-superuser `CREATEROLE` principal an ADMIN membership in each role it
   creates, and that principal cannot remove the bootstrap-superuser grant. A
   provider control-plane alternative therefore needs its own reviewed role-
   creation, cleanup, and verifier contract; plain `CREATEROLE` is insufficient.
   Run:

   ```powershell
   npm run db:roles:bootstrap
   ```

   The fixed owner becomes `NOLOGIN` with exact global settings
   `search_path=public, pg_catalog` and `row_security=on`. Runtime instead uses
   `search_path=pg_catalog, public`; both roles have no database-specific or
   unreviewed settings.
3. Through the provider control plane, create one short-lived deploy login,
   grant it direct `CONNECT` on only this database, and grant membership in
   `paperpilot_migration_owner`. It must be `LOGIN`, `NOSUPERUSER`, `NOINHERIT`,
   `NOCREATEROLE`, `NOCREATEDB`, `NOREPLICATION`, and `NOBYPASSRLS`, with no
   membership except non-admin membership in the migration owner. Do not use
   runtime or a long-lived administrator.
   Inject its base URL as `PAPERPILOT_DEPLOY_DATABASE_URL`; it may contain only
   the explicit username, host, TCP port, database, and one `sslmode`.
4. First exercise every release against an isolated, freshly bootstrapped release-
   candidate database made from the exact release artifact. Also inject the
   same base deploy-login URL as `PAPERPILOT_MIGRATION_AUDIT_DATABASE_URL`, then run:

   ```powershell
   npm run db:deploy
   npm run db:authority:snapshot
   npm run db:roles:test
   ```

   `db:deploy` adds only the fixed startup options, maps the resulting URL to the
   Prisma child process's `DATABASE_URL`, and runs `migration-preflight.sql`
   before Prisma. The preflight requires effective owner identity,
   `search_path=public, pg_catalog`, `row_security=on`,
   `session_replication_role=origin`, `check_function_bodies=on`, the dedicated
   destination, exact fixed-role attributes/settings/membership graph, and closed
   database/schema/default/parameter ACLs (including direct deploy `CONNECT`).
   It therefore fails before DDL if the base URL is stale, overpowered, or
   pointed at the wrong database. `SHADOW_DATABASE_URL` is removed from the
   deploy child.

   Set `PAPERPILOT_MIGRATION_AUDIT_DATABASE_URL` to the same *base* deploy-login
   URL before `db:authority:snapshot`; do not add startup `options`. The read-only
   wrapper adds the same exact owner startup policy and asserts it on the audit
   session. The command prints the full normalized inventory and digests for
   functions, application and internal constraint triggers, relations,
   columns/defaults/nullability, constraints, indexes, RLS/policies, and
   standalone types including ordered enum values. Review that inventory,
   update the manifest in the release, and
   regenerate it from the exact LF-normalized release artifact. Do not promote
   a release whose checked-in manifest differs.

   Then run the *entire* remainder of this sequence against the candidate:
   migration/live-schema verification, runtime-grant reconciliation, deploy
   process exit and login/session retirement, runtime-role catalog audit, and
   rollback-only runtime smoke. Provision candidate-only runtime credentials as
   needed and destroy/revoke them afterward. Production must never be the first
   database on which a release exercises grants, retirement, or runtime writes.
5. With the reviewed manifest already in the production release, run on the
   production database:

   ```powershell
   npm run db:deploy
   npm run db:migrations:verify
   npm run db:roles:reconcile
   ```

   `db:migrations:verify` uses the base URL from
   `PAPERPILOT_MIGRATION_AUDIT_DATABASE_URL`. It requires one clean, finished,
   non-rolled-back Prisma row per checked-in LF migration, exact checksums, no
   extra/duplicate attempts, and the reviewed function/trigger/live-schema
   digests. Grant reconciliation then removes stale table/column/sequence/
   function/type/default ACLs and applies the exact runtime allowlist.
6. Make the deploy process and any proxy pool exit. Disable/rotate its provider
   credential, then inject the admin URL and exact deploy role name as
   `PAPERPILOT_DEPLOY_LOGIN_ROLE` and run:

   ```powershell
   npm run db:roles:retire-deployer
   ```

   This sets that transient role `NOLOGIN`, removes owner membership and direct
   database privileges, terminates every remaining backend for the login, and
   verifies none remain. Revoking membership alone is insufficient: an already
   authenticated backend that executed `SET ROLE` keeps owner authority. If a
   managed IAM/proxy identity cannot be retired through PostgreSQL, disable it
   in the provider control plane and use provider-admin catalog/session controls
   to prove the same zero-session result before continuing.
7. After the Supabase-specific replacement is implemented and reviewed,
   provision runtime authentication through the provider secret/IAM control
   plane. Prefer short-lived IAM/certificates; otherwise use a unique high-
   entropy password. Inject `PAPERPILOT_ROLE_AUDIT_DATABASE_URL` as an explicit
   `paperpilot_runtime` URL and run:

   ```powershell
   # Future reviewed Supabase workflow; these commands currently fail closed.
   npm run db:roles:verify
   npm run db:roles:smoke
   ```

   The first command is catalog-only and always rolls back its read-only
   transaction. It proves the dedicated cluster/database, exact roles/settings/
   memberships, direct and effective ACLs/grant options, PUBLIC/default/type/
   large-object/parameter denial, object ownership, migration-ledger isolation,
   and the reviewed function/trigger/live-schema digests. The second performs
   generic and retained-principal runtime writes, `FOR SHARE`, FK-driven
   pseudonymization, and all six helper calls inside a transaction that is
   always rolled back.
8. Configure every web process and worker with `DATABASE_URL` authenticating
   exactly as `paperpilot_runtime` against the approved direct Supabase host.
   Loopback proxies, sidecars, generic PostgreSQL targets, and local Prisma Dev
   are not application modes. Start workloads only after both runtime proofs
   pass.

Repeat the release-candidate snapshot and production steps for every schema
release. A new object has no runtime authority until the exact manifest and
grant reconciliation change together, and live schema drift fails even when
the Prisma ledger itself is unchanged.

Runtime, deploy, admin, and audit URLs require an explicit user, port, and
database. The closed parsers prevent ambient `PGUSER`/`PGPORT`/`PGDATABASE`,
host/service redirects, duplicate parameters, and query overrides from changing
the reviewed destination. The active application and administration boundaries
require the exact approved Supabase direct host and `sslmode=verify-full`.

Some managed products do not expose the powers this bootstrap needs: a true
superuser for generic PostgreSQL 16+ role creation and idempotent reruns, role
creation and membership, role-attribute administration, schema ownership,
system-function ACLs, parameter `SET`/`ALTER SYSTEM` ACLs, and database ACLs.
Do not silently omit or conditionally ignore a failed statement. A provider that
cannot run the exact contract and pass the live verifier is currently unsupported;
an equivalent provider-specific design would require a separate manifest,
bootstrap, verifier, and adversarial review before use.

## Rollback and recovery

Both SQL scripts are transactional: a validation or permission failure rolls
back that script. If a release fails after `migrate deploy`, Prisma does not
provide an automatic down migration. Keep the previous application version
schema-compatible, restore from the tested backup when necessary, and treat a
data/schema rollback separately from a role rollback.

To revoke a suspected runtime credential, first stop or isolate all web and worker
processes, disable `LOGIN` or revoke the provider IAM binding, and rotate the
secret. Re-run the bootstrap/grant/audit sequence before restoring service.

To uninstall the roles, use a provider administrator only after inventorying
ownership and grants in every database in the PostgreSQL cluster. Roles are
cluster-wide. Transfer the `public` schema, Prisma ledger, tables, functions, and
types to a reviewed successor owner; revoke runtime grants; then drop the roles.
Do not run a blind `DROP OWNED` or `REASSIGN OWNED`: those commands can affect
unrelated objects in the connected database. Removing roles does not roll back
migrations or delete PaperPilot data.

## Security boundary and limitations

This is a materially smaller credential than a migration/database owner, but it
is not row-level containment. The current Next.js server, Better Auth adapter,
queue workers, and connector workers share one runtime role and collectively need
ordinary DML across the current Prisma model set. A stolen runtime credential can
therefore issue arbitrary allowed DML and may forge a self-consistent authority
graph that satisfies foreign keys and integrity triggers. Triggers prove internal
consistency; they do not prove that a write came through PaperPilot's authorization
logic, a human review, OpenAlex, or a particular worker.

Containing that stronger threat requires a later design with database-enforced
tenant isolation (`RLS`, including `FORCE ROW LEVEL SECURITY` where ownership
would otherwise bypass it), narrowly scoped `SECURITY DEFINER` procedures with
pinned search paths and closed parameters, and separate web/auth/worker roles.
Those procedures and policies require their own adversarial review. This slice
does not claim that application compromise is contained, only that the runtime
credential cannot become the migration owner, mutate schema/triggers, or bypass
the installed database checks using PostgreSQL administrative capabilities.
