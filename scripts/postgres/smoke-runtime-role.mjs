import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { validatedAuditUrl } from "./verify-runtime-role.mjs";

const AUDIT_URL_ENV = "PAPERPILOT_ROLE_AUDIT_DATABASE_URL";

export async function main() {
  const connectionString = validatedAuditUrl(process.env[AUDIT_URL_ENV]);
  const client = new Client({
    connectionString,
    application_name: "paperpilot-runtime-smoke",
    connectionTimeoutMillis: 5_000,
    query_timeout: 20_000,
  });
  const token = randomUUID();
  const userId = `role-smoke-user-${token}`;
  const organizationId = `role-smoke-org-${token}`;
  const paperId = `role-smoke-paper-${token}`;
  const workspacePaperId = `role-smoke-workspace-paper-${token}`;
  const retainedPrincipalId = randomUUID();

  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '20s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    const { rows: identityRows } = await client.query(
      `SELECT current_user,
              current_setting('search_path') AS search_path,
              current_setting('session_replication_role') AS replication_role`,
    );
    if (
      identityRows[0]?.current_user !== "paperpilot_runtime"
      || identityRows[0]?.search_path?.replaceAll(/['"\s]/g, "") !== "pg_catalog,public"
      || identityRows[0]?.replication_role !== "origin"
    ) {
      throw new Error("Runtime smoke connection does not have the exact reviewed session identity.");
    }

    await client.query(
      `INSERT INTO public."User"
         ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, 'Runtime role smoke', $2, false, clock_timestamp(), clock_timestamp())`,
      [userId, `${token}@runtime-smoke.invalid`],
    );
    await client.query(
      `INSERT INTO public."Organization"
         ("id", "name", "slug", "revision", "kind", "createdAt", "updatedAt")
       VALUES ($1, 'Runtime role smoke', $2, 0, 'PERSONAL', clock_timestamp(), clock_timestamp())`,
      [organizationId, `runtime-smoke-${token}`],
    );
    await client.query(
      `INSERT INTO public."Paper"
         ("id", "title", "isRetracted", "createdAt", "updatedAt")
       VALUES ($1, 'Runtime role smoke', false, clock_timestamp(), clock_timestamp())`,
      [paperId],
    );
    await client.query(
      `INSERT INTO public."WorkspacePaper"
         ("id", "organizationId", "paperId", "status", "priority", "isStarred",
          "addedById", "addedAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 'SAVED', 0, false, $4,
               clock_timestamp(), clock_timestamp(), clock_timestamp())`,
      [workspacePaperId, organizationId, paperId, userId],
    );
    const { rows: principalRows } = await client.query(
      `INSERT INTO public."RetainedAuditPrincipal"
         ("id", "organizationId", "liveUserId", "createdAt")
       VALUES ($1::uuid, $2, $3, '2000-01-01T00:00:00.000Z'::timestamptz)
       RETURNING "createdAt", "liveUserId", "pseudonymizedAt"`,
      [retainedPrincipalId, organizationId, userId],
    );
    if (
      principalRows[0]?.liveUserId !== userId
      || principalRows[0]?.pseudonymizedAt !== null
      || !(principalRows[0]?.createdAt instanceof Date)
      || principalRows[0].createdAt.getUTCFullYear() === 2000
    ) {
      throw new Error("Runtime retained-principal INSERT did not enforce database authority.");
    }
    await client.query(
      `SELECT "id" FROM public."RetainedAuditPrincipal"
        WHERE "id" = $1::uuid
        FOR SHARE`,
      [retainedPrincipalId],
    );
    await client.query(
      `UPDATE public."WorkspacePaper" SET "priority" = 1 WHERE "id" = $1`,
      [workspacePaperId],
    );
    await client.query(`SELECT public."WebMcpInbox_integrity_lock"($1, $2)`, [
      organizationId,
      "runtime-smoke-inbox",
    ]);
    await client.query(`SELECT public."WebMcpPaper_integrity_lock"($1)`, [paperId]);
    await client.query(
      `SELECT public."WebMcpApproval_provenance_row_allowed"($1, $2, $3)`,
      [organizationId, "runtime-smoke-inbox", "runtime-smoke-provenance"],
    );
    await client.query(
      `SELECT public.assert_document_text_extraction_aggregate($1, $2)`,
      [organizationId, "runtime-smoke-extraction"],
    );
    await client.query(
      `SELECT public.document_text_manifest_field_v1('runtime-role-smoke')`,
    );

    await client.query("SAVEPOINT expected_manifest_error");
    try {
      await client.query(
        `SELECT public.compute_document_text_manifest_v1($1, $2, $3)`,
        [organizationId, "runtime-smoke-document", "runtime-smoke-extraction"],
      );
      throw new Error("Missing extraction unexpectedly produced a text manifest.");
    } catch (error) {
      if (error?.code !== "23503") throw error;
      await client.query("ROLLBACK TO SAVEPOINT expected_manifest_error");
    }

    await client.query(`DELETE FROM public."WorkspacePaper" WHERE "id" = $1`, [
      workspacePaperId,
    ]);
    await client.query(`DELETE FROM public."User" WHERE "id" = $1`, [userId]);
    const { rows: detachedPrincipalRows } = await client.query(
      `SELECT "liveUserId", "pseudonymizedAt"
         FROM public."RetainedAuditPrincipal"
        WHERE "id" = $1::uuid`,
      [retainedPrincipalId],
    );
    if (
      detachedPrincipalRows[0]?.liveUserId !== null
      || !(detachedPrincipalRows[0]?.pseudonymizedAt instanceof Date)
    ) {
      throw new Error("FK-driven retained-principal pseudonymization did not run.");
    }
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("ROLLBACK");
    process.stdout.write(
      "PostgreSQL runtime smoke passed; trigger-backed writes and all six helper calls were rolled back.\n",
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
