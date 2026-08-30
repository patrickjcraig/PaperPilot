import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const bootstrapSource = readFileSync(
  new URL("./bootstrap-roles.mjs", import.meta.url),
  "utf8",
);
const reconcileSource = readFileSync(
  new URL("./reconcile-runtime-grants.mjs", import.meta.url),
  "utf8",
);

test("Supabase bootstrap closes role memberships and uses a secure migration path", () => {
  assert.match(bootstrapSource, /pg_catalog\.pg_auth_members/u);
  assert.match(bootstrapSource, /REVOKE %I FROM %I/u);
  assert.match(bootstrapSource, /rolinherit/u);
  assert.match(bootstrapSource, /rolbypassrls/u);
  assert.match(
    bootstrapSource,
    /ALTER ROLE paperpilot_migration_owner IN DATABASE postgres[\s\S]*SET search_path = public;/u,
  );
  assert.doesNotMatch(
    bootstrapSource,
    /paperpilot_migration_owner[\s\S]{0,100}SET search_path = public, pg_catalog/u,
  );
  assert.doesNotMatch(bootstrapSource, /ALTER (?:DATABASE|SCHEMA public OWNER)/u);
});

test("runtime grant reconciliation refuses drifted PaperPilot roles", () => {
  assert.match(reconcileSource, /pg_catalog\.pg_auth_members/u);
  assert.match(reconcileSource, /memberships_closed/u);
  assert.match(reconcileSource, /attributes_closed/u);
  assert.match(reconcileSource, /The PaperPilot role authority is not closed/u);
});
