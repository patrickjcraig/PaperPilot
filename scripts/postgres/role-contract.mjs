import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const manifestPath = resolve(
  repositoryRoot,
  "deploy",
  "postgres",
  "runtime-access-manifest.json",
);

const ROLE_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const DATABASE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const FIXED_DATABASE_SCHEMA = "public";
const FIXED_MIGRATION_OWNER = "paperpilot_migration_owner";
const FIXED_RUNTIME_ROLE = "paperpilot_runtime";
const REQUIRED_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"];
const FORBIDDEN_PRIVILEGES = ["TRUNCATE", "REFERENCES", "TRIGGER"];
const REQUIRED_FUNCTION_EXECUTE = [
  "WebMcpApproval_provenance_row_allowed(text,text,text)",
  "WebMcpInbox_integrity_lock(text,text)",
  "WebMcpPaper_integrity_lock(text)",
  "assert_document_text_extraction_aggregate(text,text)",
  "compute_document_text_manifest_v1(text,text,text)",
  "document_text_manifest_field_v1(text)",
];
const FORBIDDEN_SYSTEM_FUNCTION_EXECUTE = [
  "lo_creat(integer)",
  "lo_create(oid)",
  "lo_from_bytea(oid,bytea)",
  "lo_import(text)",
  "lo_import(text,oid)",
];
const MANIFEST_KEYS = [
  "schemaVersion",
  "authoritySnapshotVersion",
  "databaseSchema",
  "migrationOwnerRole",
  "runtimeRole",
  "requiredTablePrivileges",
  "forbiddenTablePrivileges",
  "tablePrivilegeOverrides",
  "forbiddenSystemFunctionExecute",
  "requiredFunctionExecute",
  "applicationFunctionAuthority",
  "applicationTriggerAuthority",
  "applicationSchemaAuthority",
  "applicationTables",
].sort();

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${label} must be an array of strings.`);
  }
  return value;
}

export function validateRuntimeAccessManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("The PostgreSQL runtime access manifest must be an object.");
  }
  const keys = Object.keys(value).sort();
  if (!sameArray(keys, MANIFEST_KEYS)) {
    throw new TypeError("The PostgreSQL runtime access manifest has an open or incomplete shape.");
  }
  if (value.schemaVersion !== 5) {
    throw new TypeError("The PostgreSQL runtime access manifest schemaVersion must be 5.");
  }
  if (value.authoritySnapshotVersion !== 3) {
    throw new TypeError("The PostgreSQL authority snapshot version must be 3.");
  }
  if (!ROLE_IDENTIFIER.test(value.migrationOwnerRole)) {
    throw new TypeError("migrationOwnerRole must be one unquoted lowercase PostgreSQL identifier.");
  }
  if (!ROLE_IDENTIFIER.test(value.runtimeRole)) {
    throw new TypeError("runtimeRole must be one unquoted lowercase PostgreSQL identifier.");
  }
  if (value.runtimeRole === value.migrationOwnerRole) {
    throw new TypeError("The migration owner and runtime role must be distinct.");
  }
  if (!ROLE_IDENTIFIER.test(value.databaseSchema)) {
    throw new TypeError("databaseSchema must be one unquoted lowercase PostgreSQL identifier.");
  }
  if (value.migrationOwnerRole !== FIXED_MIGRATION_OWNER) {
    throw new TypeError(`migrationOwnerRole must be exactly ${FIXED_MIGRATION_OWNER}.`);
  }
  if (value.runtimeRole !== FIXED_RUNTIME_ROLE) {
    throw new TypeError(`runtimeRole must be exactly ${FIXED_RUNTIME_ROLE}.`);
  }
  if (value.databaseSchema !== FIXED_DATABASE_SCHEMA) {
    throw new TypeError(`databaseSchema must be exactly ${FIXED_DATABASE_SCHEMA}.`);
  }

  const requiredPrivileges = stringArray(
    value.requiredTablePrivileges,
    "requiredTablePrivileges",
  );
  if (!sameArray(requiredPrivileges, REQUIRED_PRIVILEGES)) {
    throw new TypeError("Runtime table privileges must be exactly SELECT, INSERT, UPDATE, DELETE.");
  }
  const forbiddenPrivileges = stringArray(
    value.forbiddenTablePrivileges,
    "forbiddenTablePrivileges",
  );
  if (!sameArray(forbiddenPrivileges, FORBIDDEN_PRIVILEGES)) {
    throw new TypeError("Forbidden table privileges must be exactly TRUNCATE, REFERENCES, TRIGGER.");
  }

  const requiredFunctionExecute = stringArray(
    value.requiredFunctionExecute,
    "requiredFunctionExecute",
  );
  const sortedFunctionExecute = [...new Set(requiredFunctionExecute)].sort();
  if (!sameArray(requiredFunctionExecute, sortedFunctionExecute)) {
    throw new TypeError("requiredFunctionExecute must be unique and sorted.");
  }
  if (requiredFunctionExecute.some(
    (signature) => !/^[A-Za-z_][A-Za-z0-9_]*\(text(?:,text){0,7}\)$/.test(signature),
  )) {
    throw new TypeError("Every executable function must be a closed text-only identity signature.");
  }
  if (!sameArray(requiredFunctionExecute, REQUIRED_FUNCTION_EXECUTE)) {
    throw new TypeError("requiredFunctionExecute must equal the six reviewed trigger helpers.");
  }
  const forbiddenSystemFunctionExecute = stringArray(
    value.forbiddenSystemFunctionExecute,
    "forbiddenSystemFunctionExecute",
  );
  const sortedForbiddenSystemFunctions = [...new Set(forbiddenSystemFunctionExecute)].sort();
  if (!sameArray(forbiddenSystemFunctionExecute, sortedForbiddenSystemFunctions)) {
    throw new TypeError("forbiddenSystemFunctionExecute must be unique and sorted.");
  }
  if (forbiddenSystemFunctionExecute.some(
    (signature) => !/^lo_[a-z_]+\((?:(?:integer|oid|text|bytea)(?:,(?:integer|oid|text|bytea))*)?\)$/.test(signature),
  )) {
    throw new TypeError("Every forbidden system function must be one closed large-object signature.");
  }
  if (!sameArray(forbiddenSystemFunctionExecute, FORBIDDEN_SYSTEM_FUNCTION_EXECUTE)) {
    throw new TypeError("forbiddenSystemFunctionExecute must equal the five reviewed large-object creators.");
  }

  const applicationTables = stringArray(value.applicationTables, "applicationTables");
  if (applicationTables.length === 0) {
    throw new TypeError("applicationTables must not be empty.");
  }
  if (applicationTables.some((table) => !DATABASE_IDENTIFIER.test(table))) {
    throw new TypeError("Every application table must be one bounded PostgreSQL identifier.");
  }
  const sortedTables = [...new Set(applicationTables)].sort();
  if (!sameArray(applicationTables, sortedTables)) {
    throw new TypeError("applicationTables must be unique and sorted.");
  }
  if (applicationTables.includes("_prisma_migrations")) {
    throw new TypeError("The Prisma migration ledger must not enter the runtime allowlist.");
  }

  const authorityContract = (authority, label) => {
    if (
      !authority
      || typeof authority !== "object"
      || Array.isArray(authority)
      || !sameArray(Object.keys(authority).sort(), ["count", "sha256"])
      || !Number.isSafeInteger(authority.count)
      || authority.count < 1
      || typeof authority.sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(authority.sha256)
    ) {
      throw new TypeError(`${label} must be one exact count and SHA-256 contract.`);
    }
    return Object.freeze({ count: authority.count, sha256: authority.sha256 });
  };
  const applicationFunctionAuthority = authorityContract(
    value.applicationFunctionAuthority,
    "applicationFunctionAuthority",
  );
  const applicationTriggerAuthority = authorityContract(
    value.applicationTriggerAuthority,
    "applicationTriggerAuthority",
  );
  const applicationSchemaAuthority = authorityContract(
    value.applicationSchemaAuthority,
    "applicationSchemaAuthority",
  );

  if (!Array.isArray(value.tablePrivilegeOverrides)) {
    throw new TypeError("tablePrivilegeOverrides must be an array.");
  }
  const tablePrivilegeOverrides = value.tablePrivilegeOverrides.map((override) => {
    if (!override || typeof override !== "object" || Array.isArray(override)) {
      throw new TypeError("Every table privilege override must be an object.");
    }
    if (!sameArray(Object.keys(override).sort(), [
      "columnPrivileges", "table", "tablePrivileges",
    ])) {
      throw new TypeError("Every table privilege override must have one closed shape.");
    }
    if (!applicationTables.includes(override.table)) {
      throw new TypeError("Every table privilege override must name an application table.");
    }
    const tablePrivileges = stringArray(
      override.tablePrivileges,
      `${override.table}.tablePrivileges`,
    );
    if (
      !sameArray(tablePrivileges, [...new Set(tablePrivileges)].sort())
      || tablePrivileges.some((privilege) => !REQUIRED_PRIVILEGES.includes(privilege))
    ) {
      throw new TypeError("Override tablePrivileges must be a unique sorted DML subset.");
    }
    if (!Array.isArray(override.columnPrivileges)) {
      throw new TypeError("Override columnPrivileges must be an array.");
    }
    const columnPrivileges = override.columnPrivileges.map((grant) => {
      if (
        !grant
        || typeof grant !== "object"
        || Array.isArray(grant)
        || !sameArray(Object.keys(grant).sort(), ["columns", "privilege"])
        || !["INSERT", "REFERENCES", "SELECT", "UPDATE"].includes(grant.privilege)
      ) {
        throw new TypeError("Every column privilege grant must have one closed shape.");
      }
      const columns = stringArray(grant.columns, `${override.table}.${grant.privilege}`);
      if (
        columns.length === 0
        || columns.some((column) => !DATABASE_IDENTIFIER.test(column))
        || !sameArray(columns, [...new Set(columns)].sort())
      ) {
        throw new TypeError("Column privilege names must be nonempty, unique, sorted identifiers.");
      }
      return Object.freeze({
        privilege: grant.privilege,
        columns: Object.freeze([...columns]),
      });
    });
    const privilegeNames = columnPrivileges.map((grant) => grant.privilege);
    if (!sameArray(privilegeNames, [...new Set(privilegeNames)].sort())) {
      throw new TypeError("Column privilege grants must be unique and sorted by privilege.");
    }
    return Object.freeze({
      table: override.table,
      tablePrivileges: Object.freeze([...tablePrivileges]),
      columnPrivileges: Object.freeze(columnPrivileges),
    });
  });
  const overrideTables = tablePrivilegeOverrides.map((override) => override.table);
  if (!sameArray(overrideTables, [...new Set(overrideTables)].sort())) {
    throw new TypeError("tablePrivilegeOverrides must be unique and sorted by table.");
  }

  return Object.freeze({
    schemaVersion: 5,
    authoritySnapshotVersion: 3,
    databaseSchema: value.databaseSchema,
    migrationOwnerRole: value.migrationOwnerRole,
    runtimeRole: value.runtimeRole,
    requiredTablePrivileges: Object.freeze([...requiredPrivileges]),
    forbiddenTablePrivileges: Object.freeze([...forbiddenPrivileges]),
    tablePrivilegeOverrides: Object.freeze(tablePrivilegeOverrides),
    forbiddenSystemFunctionExecute: Object.freeze([...forbiddenSystemFunctionExecute]),
    requiredFunctionExecute: Object.freeze([...requiredFunctionExecute]),
    applicationFunctionAuthority,
    applicationTriggerAuthority,
    applicationSchemaAuthority,
    applicationTables: Object.freeze([...applicationTables]),
  });
}

export function loadRuntimeAccessManifest(path = manifestPath) {
  return validateRuntimeAccessManifest(JSON.parse(readFileSync(path, "utf8")));
}

export function prismaTableNames(schemaSource) {
  const tables = [];
  const modelPattern = /^model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)^\}/gm;
  for (const match of schemaSource.matchAll(modelPattern)) {
    const mappedName = match[2].match(/^\s*@@map\("([A-Za-z_][A-Za-z0-9_]*)"\)\s*$/m)?.[1];
    tables.push(mappedName ?? match[1]);
  }
  return [...new Set(tables)].sort();
}

export function sqlApplicationTables(sqlSource) {
  const block = sqlSource.match(
    /-- BEGIN APPLICATION TABLES:[^\n]*\n([\s\S]*?)-- END APPLICATION TABLES\./,
  )?.[1];
  if (!block) throw new TypeError("The runtime grant SQL is missing its application-table block.");
  return [...block.matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)].map((match) => match[1]);
}
