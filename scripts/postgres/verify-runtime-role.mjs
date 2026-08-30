import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { Client } from "pg";

import { validatedPostgresConnectionUrl } from "../../src/lib/postgres-connection-url.mjs";
import { loadRuntimeAccessManifest } from "./role-contract.mjs";

const AUDIT_URL_ENV = "PAPERPILOT_ROLE_AUDIT_DATABASE_URL";
const MINIMUM_POSTGRES_VERSION = 150000;
export const AUTHORITY_SNAPSHOT_VERSION = 3;

export function validatedAuditUrl(rawValue) {
  return validatedPostgresConnectionUrl(rawValue, {
    label: AUDIT_URL_ENV,
    requireTlsForNonLoopback: true,
    requiredUsername: "paperpilot_runtime",
  }).connectionString;
}

function exactSet(actual, expected) {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function recordViolation(violations, condition, message) {
  if (!condition) violations.push(message);
}

function aclPrivileges(rows, grantee) {
  return rows
    .filter((row) => row.grantee === grantee)
    .map((row) => row.privilege_type)
    .sort();
}

function hasGrantOption(rows, grantee) {
  return rows.some((row) => row.grantee === grantee && row.is_grantable);
}

const ALL_TABLE_PRIVILEGES = [
  "SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER",
];

function tablePrivilegeContract(manifest, tableName) {
  const override = manifest.tablePrivilegeOverrides.find(
    (candidate) => candidate.table === tableName,
  );
  return override ?? {
    table: tableName,
    tablePrivileges: manifest.requiredTablePrivileges,
    columnPrivileges: [],
  };
}

function columnPrivilegeKeys(grants) {
  return grants.flatMap((grant) => grant.columns.map(
    (column) => `${grant.privilege}:${column}`,
  ));
}

function normalizedSearchPath(value) {
  return value.replaceAll('"', "").replaceAll(/\s/g, "");
}

function authorityDigest(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function canonicalSqlDeparse(value) {
  if (typeof value !== "string") return null;
  let output = "";
  let pendingSpace = false;
  let state = "normal";
  let dollarTag = "";
  let escapeString = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const next = value[index + 1];

    if (state === "single") {
      output += character;
      if (escapeString && character === "\\" && next !== undefined) {
        output += next;
        index += 1;
      } else if (character === "'" && next === "'") {
        output += next;
        index += 1;
      } else if (character === "'") {
        state = "normal";
        escapeString = false;
      }
      continue;
    }
    if (state === "double") {
      output += character;
      if (character === '"' && next === '"') {
        output += next;
        index += 1;
      } else if (character === '"') {
        state = "normal";
      }
      continue;
    }
    if (state === "dollar") {
      if (value.startsWith(dollarTag, index)) {
        output += dollarTag;
        index += dollarTag.length - 1;
        state = "normal";
        dollarTag = "";
      } else {
        output += character;
      }
      continue;
    }

    if (/\s/u.test(character)) {
      pendingSpace = output.length > 0;
      continue;
    }
    if (pendingSpace) {
      output += " ";
      pendingSpace = false;
    }
    if (character === "'") {
      escapeString = /(?:^|[^A-Za-z0-9_])E$/u.test(output);
      state = "single";
      output += character;
      continue;
    }
    if (character === '"') {
      state = "double";
      output += character;
      continue;
    }
    if (character === "$") {
      const tag = value.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u)?.[0];
      if (tag) {
        state = "dollar";
        dollarTag = tag;
        output += tag;
        index += tag.length - 1;
        continue;
      }
    }
    output += character;
  }
  return output;
}

/** Exact semantic inventory of every user function and non-internal trigger. */
export async function applicationAuthoritySnapshot(
  client,
  schemaName,
  { includeInventory = false } = {},
) {
  const { rows: rawFunctions } = await client.query(
    `SELECT routine.proname,
            pg_catalog.oidvectortypes(routine.proargtypes) AS identity_arguments,
            pg_catalog.pg_get_function_result(routine.oid) AS result_type,
            language.lanname AS language,
            routine.prokind,
            routine.prosecdef,
            routine.proleakproof,
            routine.proisstrict,
            routine.provolatile,
            routine.proparallel,
            routine.proconfig,
            routine.prosrc
       FROM pg_catalog.pg_proc AS routine
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
       JOIN pg_catalog.pg_language AS language ON language.oid = routine.prolang
      WHERE namespace.nspname = $1
      ORDER BY routine.proname COLLATE "C",
               pg_catalog.oidvectortypes(routine.proargtypes) COLLATE "C"`,
    [schemaName],
  );
  const functions = rawFunctions.map((routine) => ({
    signature: `${routine.proname}(${routine.identity_arguments.replaceAll(/\s/g, "")})`,
    resultType: routine.result_type,
    language: routine.language,
    kind: routine.prokind,
    securityDefiner: routine.prosecdef,
    leakproof: routine.proleakproof,
    strict: routine.proisstrict,
    volatility: routine.provolatile,
    parallel: routine.proparallel,
    configuration: [...(routine.proconfig ?? [])].sort(),
    sourceSha256: createHash("sha256").update(routine.prosrc, "utf8").digest("hex"),
  }));

  const { rows: rawTriggers } = await client.query(
    `SELECT trigger.tgname,
            relation.relname AS table_name,
            routine.proname AS function_name,
            pg_catalog.oidvectortypes(routine.proargtypes) AS function_arguments,
            trigger.tgenabled,
            trigger.tgtype::integer AS trigger_type,
            trigger.tgconstraint <> 0 AS is_constraint,
            trigger.tgdeferrable,
            trigger.tginitdeferred,
            pg_catalog.encode(trigger.tgargs, 'hex') AS arguments_hex,
            trigger.tgattr::text AS update_columns,
            pg_catalog.pg_get_triggerdef(trigger.oid, false) AS trigger_definition,
            constraint_relation.relname AS constraint_relation,
            trigger.tgoldtable,
            trigger.tgnewtable
       FROM pg_catalog.pg_trigger AS trigger
       JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       JOIN pg_catalog.pg_proc AS routine ON routine.oid = trigger.tgfoid
       LEFT JOIN pg_catalog.pg_class AS constraint_relation
         ON constraint_relation.oid = trigger.tgconstrrelid
      WHERE namespace.nspname = $1
        AND NOT trigger.tgisinternal
      ORDER BY relation.relname COLLATE "C", trigger.tgname COLLATE "C"`,
    [schemaName],
  );
  const triggers = rawTriggers.map((trigger) => ({
    table: trigger.table_name,
    name: trigger.tgname,
    functionSignature:
      `${trigger.function_name}(${trigger.function_arguments.replaceAll(/\s/g, "")})`,
    enabled: trigger.tgenabled,
    type: trigger.trigger_type,
    constraint: trigger.is_constraint,
    deferrable: trigger.tgdeferrable,
    initiallyDeferred: trigger.tginitdeferred,
    argumentsHex: trigger.arguments_hex,
    updateColumns: trigger.update_columns,
    definition: canonicalSqlDeparse(trigger.trigger_definition),
    constraintRelation: trigger.constraint_relation,
    oldTransitionTable: trigger.tgoldtable,
    newTransitionTable: trigger.tgnewtable,
  }));
  const { rows: rawInternalConstraintTriggers } = await client.query(
    `SELECT relation.relname AS table_name,
            constraint_definition.conname AS constraint_name,
            constraint_definition.contype AS constraint_type,
            routine.proname AS function_name,
            pg_catalog.oidvectortypes(routine.proargtypes) AS function_arguments,
            trigger.tgenabled,
            trigger.tgtype::integer AS trigger_type,
            trigger.tgdeferrable,
            trigger.tginitdeferred,
            trigger.tgattr::text AS update_columns,
            constraint_namespace.nspname AS constraint_schema,
            constraint_relation.relname AS constraint_relation
       FROM pg_catalog.pg_trigger AS trigger
       JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       JOIN pg_catalog.pg_constraint AS constraint_definition
         ON constraint_definition.oid = trigger.tgconstraint
       JOIN pg_catalog.pg_proc AS routine ON routine.oid = trigger.tgfoid
       LEFT JOIN pg_catalog.pg_class AS constraint_relation
         ON constraint_relation.oid = trigger.tgconstrrelid
       LEFT JOIN pg_catalog.pg_namespace AS constraint_namespace
         ON constraint_namespace.oid = constraint_relation.relnamespace
      WHERE namespace.nspname = $1
        AND trigger.tgisinternal
        AND trigger.tgconstraint <> 0
      ORDER BY relation.relname COLLATE "C",
               constraint_definition.conname COLLATE "C",
               routine.proname COLLATE "C",
               trigger.tgtype`,
    [schemaName],
  );
  const internalConstraintTriggers = rawInternalConstraintTriggers.map((trigger) => ({
    table: trigger.table_name,
    constraint: trigger.constraint_name,
    constraintType: trigger.constraint_type,
    functionSignature:
      `${trigger.function_name}(${trigger.function_arguments.replaceAll(/\s/g, "")})`,
    enabled: trigger.tgenabled,
    type: trigger.trigger_type,
    deferrable: trigger.tgdeferrable,
    initiallyDeferred: trigger.tginitdeferred,
    updateColumns: trigger.update_columns,
    constraintRelation: trigger.constraint_relation === null
      ? null
      : `${trigger.constraint_schema}.${trigger.constraint_relation}`,
  }));

  const { rows: rawRelations } = await client.query(
    `SELECT relation.relname,
            relation.relkind,
            relation.relpersistence,
            relation.relrowsecurity,
            relation.relforcerowsecurity,
            relation.relreplident,
            relation.relispartition,
            access_method.amname AS access_method,
            pg_catalog.pg_get_expr(relation.relpartbound, relation.oid, false) AS partition_bound
       FROM pg_catalog.pg_class AS relation
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       LEFT JOIN pg_catalog.pg_am AS access_method ON access_method.oid = relation.relam
      WHERE namespace.nspname = $1
        AND relation.relkind IN ('r', 'p')
      ORDER BY relation.relname COLLATE "C"`,
    [schemaName],
  );
  const relations = rawRelations.map((relation) => ({
    name: relation.relname,
    kind: relation.relkind,
    persistence: relation.relpersistence,
    rowSecurity: relation.relrowsecurity,
    forceRowSecurity: relation.relforcerowsecurity,
    replicaIdentity: relation.relreplident,
    partition: relation.relispartition,
    accessMethod: relation.access_method,
    partitionBound: canonicalSqlDeparse(relation.partition_bound),
  }));
  const { rows: rawInheritance } = await client.query(
    `SELECT child.relname AS child_table,
            parent_namespace.nspname AS parent_schema,
            parent.relname AS parent_table,
            inheritance.inhseqno,
            inheritance.inhdetachpending
       FROM pg_catalog.pg_inherits AS inheritance
       JOIN pg_catalog.pg_class AS child ON child.oid = inheritance.inhrelid
       JOIN pg_catalog.pg_namespace AS child_namespace
         ON child_namespace.oid = child.relnamespace
       JOIN pg_catalog.pg_class AS parent ON parent.oid = inheritance.inhparent
       JOIN pg_catalog.pg_namespace AS parent_namespace
         ON parent_namespace.oid = parent.relnamespace
      WHERE child_namespace.nspname = $1
        AND child.relkind IN ('r', 'p')
      ORDER BY child.relname COLLATE "C", inheritance.inhseqno`,
    [schemaName],
  );
  const inheritance = rawInheritance.map((edge) => ({
    child: edge.child_table,
    parent: `${edge.parent_schema}.${edge.parent_table}`,
    sequence: edge.inhseqno,
    detachPending: edge.inhdetachpending,
  }));

  const { rows: rawColumns } = await client.query(
    `SELECT relation.relname AS table_name,
            column_definition.attnum,
            column_definition.attname,
            pg_catalog.format_type(column_definition.atttypid, column_definition.atttypmod) AS data_type,
            column_definition.attnotnull,
            column_definition.attidentity,
            column_definition.attgenerated,
            column_definition.attstorage,
            column_definition.attcompression,
            column_collation.collname AS collation_name,
            pg_catalog.pg_get_expr(attribute_default.adbin, attribute_default.adrelid, false)
              AS default_expression
       FROM pg_catalog.pg_attribute AS column_definition
       JOIN pg_catalog.pg_class AS relation ON relation.oid = column_definition.attrelid
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       LEFT JOIN pg_catalog.pg_attrdef AS attribute_default
         ON attribute_default.adrelid = column_definition.attrelid
        AND attribute_default.adnum = column_definition.attnum
       LEFT JOIN pg_catalog.pg_collation AS column_collation
         ON column_collation.oid = column_definition.attcollation
        AND column_definition.attcollation <> 0
      WHERE namespace.nspname = $1
        AND relation.relkind IN ('r', 'p')
        AND column_definition.attnum > 0
        AND NOT column_definition.attisdropped
      ORDER BY relation.relname COLLATE "C", column_definition.attnum`,
    [schemaName],
  );
  const columns = rawColumns.map((column) => ({
    table: column.table_name,
    position: column.attnum,
    name: column.attname,
    dataType: column.data_type,
    notNull: column.attnotnull,
    identity: column.attidentity,
    generated: column.attgenerated,
    storage: column.attstorage,
    compression: column.attcompression,
    collation: column.collation_name,
    default: canonicalSqlDeparse(column.default_expression),
  }));

  const { rows: rawConstraints } = await client.query(
    `SELECT relation.relname AS table_name,
            constraint_definition.conname,
            constraint_definition.contype,
            constraint_definition.condeferrable,
            constraint_definition.condeferred,
            constraint_definition.convalidated,
            constraint_definition.connoinherit,
            pg_catalog.pg_get_constraintdef(constraint_definition.oid, false) AS definition
       FROM pg_catalog.pg_constraint AS constraint_definition
       JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_definition.conrelid
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relkind IN ('r', 'p')
      ORDER BY relation.relname COLLATE "C", constraint_definition.conname COLLATE "C"`,
    [schemaName],
  );
  const constraints = rawConstraints.map((constraint) => ({
    table: constraint.table_name,
    name: constraint.conname,
    type: constraint.contype,
    deferrable: constraint.condeferrable,
    initiallyDeferred: constraint.condeferred,
    validated: constraint.convalidated,
    noInherit: constraint.connoinherit,
    definition: canonicalSqlDeparse(constraint.definition),
  }));

  const { rows: rawIndexes } = await client.query(
    `SELECT relation.relname AS table_name,
            index_relation.relname AS index_name,
            index_definition.indisunique,
            index_definition.indisprimary,
            index_definition.indisexclusion,
            index_definition.indimmediate,
            index_definition.indisclustered,
            index_definition.indisvalid,
            index_definition.indcheckxmin,
            index_definition.indisready,
            index_definition.indislive,
            index_definition.indisreplident,
            pg_catalog.pg_get_indexdef(index_definition.indexrelid, 0, false) AS definition,
            pg_catalog.pg_get_expr(index_definition.indpred, index_definition.indrelid, false)
              AS predicate,
            pg_catalog.pg_get_expr(index_definition.indexprs, index_definition.indrelid, false)
              AS expressions
       FROM pg_catalog.pg_index AS index_definition
       JOIN pg_catalog.pg_class AS relation ON relation.oid = index_definition.indrelid
       JOIN pg_catalog.pg_class AS index_relation
         ON index_relation.oid = index_definition.indexrelid
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relkind IN ('r', 'p')
      ORDER BY relation.relname COLLATE "C", index_relation.relname COLLATE "C"`,
    [schemaName],
  );
  const indexes = rawIndexes.map((index) => ({
    table: index.table_name,
    name: index.index_name,
    unique: index.indisunique,
    primary: index.indisprimary,
    exclusion: index.indisexclusion,
    immediate: index.indimmediate,
    clustered: index.indisclustered,
    valid: index.indisvalid,
    checkXmin: index.indcheckxmin,
    ready: index.indisready,
    live: index.indislive,
    replicaIdentity: index.indisreplident,
    definition: canonicalSqlDeparse(index.definition),
    predicate: canonicalSqlDeparse(index.predicate),
    expressions: canonicalSqlDeparse(index.expressions),
  }));

  const { rows: rawPolicies } = await client.query(
    `SELECT relation.relname AS table_name,
            policy.polname,
            policy.polpermissive,
            policy.polcmd,
            ARRAY(
              SELECT coalesce(role.rolname, 'PUBLIC')
              FROM unnest(policy.polroles) AS policy_role(role_oid)
              LEFT JOIN pg_catalog.pg_roles AS role ON role.oid = policy_role.role_oid
              ORDER BY coalesce(role.rolname, 'PUBLIC') COLLATE "C"
            ) AS roles,
            pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) AS using_expression,
            pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) AS check_expression
       FROM pg_catalog.pg_policy AS policy
       JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relkind IN ('r', 'p')
      ORDER BY relation.relname COLLATE "C", policy.polname COLLATE "C"`,
    [schemaName],
  );
  const policies = rawPolicies.map((policy) => ({
    table: policy.table_name,
    name: policy.polname,
    permissive: policy.polpermissive,
    command: policy.polcmd,
    roles: policy.roles,
    using: canonicalSqlDeparse(policy.using_expression),
    check: canonicalSqlDeparse(policy.check_expression),
  }));
  const { rows: rawRules } = await client.query(
    `SELECT relation.relname AS table_name,
            rewrite_rule.rulename,
            rewrite_rule.ev_type,
            rewrite_rule.ev_enabled,
            rewrite_rule.is_instead,
            pg_catalog.pg_get_ruledef(rewrite_rule.oid, false) AS definition
       FROM pg_catalog.pg_rewrite AS rewrite_rule
       JOIN pg_catalog.pg_class AS relation ON relation.oid = rewrite_rule.ev_class
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relkind IN ('r', 'p')
      ORDER BY relation.relname COLLATE "C", rewrite_rule.rulename COLLATE "C"`,
    [schemaName],
  );
  const rules = rawRules.map((rule) => ({
    table: rule.table_name,
    name: rule.rulename,
    event: rule.ev_type,
    enabled: rule.ev_enabled,
    instead: rule.is_instead,
    definition: canonicalSqlDeparse(rule.definition),
  }));
  const { rows: rawTypes } = await client.query(
    `SELECT type_definition.typname,
            type_definition.typtype,
            type_definition.typcategory,
            type_definition.typispreferred,
            type_definition.typnotnull,
            type_definition.typalign,
            type_definition.typstorage,
            type_definition.typbyval,
            composite_relation.relkind AS composite_relation_kind,
            CASE WHEN type_definition.typbasetype = 0 THEN NULL
                 ELSE pg_catalog.format_type(
                   type_definition.typbasetype,
                   type_definition.typtypmod
                 )
            END AS base_type,
            CASE WHEN type_definition.typelem = 0 THEN NULL
                 ELSE pg_catalog.format_type(type_definition.typelem, NULL)
            END AS element_type,
            type_definition.typdefault,
            CASE WHEN type_definition.typcollation = 0 THEN NULL
                 ELSE format('%I.%I', collation_namespace.nspname, type_collation.collname)
            END AS collation
       FROM pg_catalog.pg_type AS type_definition
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = type_definition.typnamespace
       LEFT JOIN pg_catalog.pg_class AS composite_relation
         ON composite_relation.oid = type_definition.typrelid
       LEFT JOIN pg_catalog.pg_collation AS type_collation
         ON type_collation.oid = type_definition.typcollation
       LEFT JOIN pg_catalog.pg_namespace AS collation_namespace
         ON collation_namespace.oid = type_collation.collnamespace
      WHERE namespace.nspname = $1
        AND type_definition.typisdefined
        AND (type_definition.typrelid = 0 OR composite_relation.relkind = 'c')
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_type AS element_type
          WHERE element_type.typarray = type_definition.oid
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_range AS range_type
          WHERE range_type.rngmultitypid = type_definition.oid
        )
      ORDER BY type_definition.typname COLLATE "C"`,
    [schemaName],
  );
  const types = rawTypes.map((type) => ({
    name: type.typname,
    kind: type.typtype,
    category: type.typcategory,
    preferred: type.typispreferred,
    notNull: type.typnotnull,
    alignment: type.typalign,
    storage: type.typstorage,
    byValue: type.typbyval,
    compositeRelationKind: type.composite_relation_kind,
    baseType: type.base_type,
    elementType: type.element_type,
    default: canonicalSqlDeparse(type.typdefault),
    collation: type.collation,
  }));
  const { rows: rawEnumValues } = await client.query(
    `SELECT type_definition.typname AS type_name,
            enum_value.enumlabel,
            enum_value.enumsortorder::text AS sort_order
       FROM pg_catalog.pg_enum AS enum_value
       JOIN pg_catalog.pg_type AS type_definition ON type_definition.oid = enum_value.enumtypid
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = type_definition.typnamespace
      WHERE namespace.nspname = $1
      ORDER BY type_definition.typname COLLATE "C", enum_value.enumsortorder`,
    [schemaName],
  );
  const enumValues = rawEnumValues.map((value) => ({
    type: value.type_name,
    label: value.enumlabel,
    sortOrder: value.sort_order,
  }));
  const { rows: rawCompositeAttributes } = await client.query(
    `SELECT type_definition.typname AS type_name,
            column_definition.attnum,
            column_definition.attname,
            pg_catalog.format_type(
              column_definition.atttypid,
              column_definition.atttypmod
            ) AS data_type,
            column_definition.attnotnull,
            CASE WHEN column_definition.attcollation = 0 THEN NULL
                 ELSE format('%I.%I', collation_namespace.nspname, attribute_collation.collname)
            END AS collation
       FROM pg_catalog.pg_type AS type_definition
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = type_definition.typnamespace
       JOIN pg_catalog.pg_class AS composite_relation
         ON composite_relation.oid = type_definition.typrelid
        AND composite_relation.relkind = 'c'
       JOIN pg_catalog.pg_attribute AS column_definition
         ON column_definition.attrelid = composite_relation.oid
       LEFT JOIN pg_catalog.pg_collation AS attribute_collation
         ON attribute_collation.oid = column_definition.attcollation
       LEFT JOIN pg_catalog.pg_namespace AS collation_namespace
         ON collation_namespace.oid = attribute_collation.collnamespace
      WHERE namespace.nspname = $1
        AND column_definition.attnum > 0
        AND NOT column_definition.attisdropped
      ORDER BY type_definition.typname COLLATE "C", column_definition.attnum`,
    [schemaName],
  );
  const compositeAttributes = rawCompositeAttributes.map((attribute) => ({
    type: attribute.type_name,
    position: attribute.attnum,
    name: attribute.attname,
    dataType: attribute.data_type,
    notNull: attribute.attnotnull,
    collation: attribute.collation,
  }));
  const { rows: rawRanges } = await client.query(
    `SELECT range_type_definition.typname AS type_name,
            pg_catalog.format_type(range_definition.rngsubtype, NULL) AS subtype,
            operator_class.opcname AS operator_class,
            CASE WHEN range_definition.rngcollation = 0 THEN NULL
                 ELSE format('%I.%I', collation_namespace.nspname, range_collation.collname)
            END AS collation,
            range_definition.rngcanonical::regprocedure::text AS canonical_function,
            range_definition.rngsubdiff::regprocedure::text AS subtype_difference_function,
            CASE WHEN range_definition.rngmultitypid = 0 THEN NULL
                 ELSE pg_catalog.format_type(range_definition.rngmultitypid, NULL)
            END AS multirange_type
       FROM pg_catalog.pg_range AS range_definition
       JOIN pg_catalog.pg_type AS range_type_definition
         ON range_type_definition.oid = range_definition.rngtypid
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = range_type_definition.typnamespace
       JOIN pg_catalog.pg_opclass AS operator_class
         ON operator_class.oid = range_definition.rngsubopc
       LEFT JOIN pg_catalog.pg_collation AS range_collation
         ON range_collation.oid = range_definition.rngcollation
       LEFT JOIN pg_catalog.pg_namespace AS collation_namespace
         ON collation_namespace.oid = range_collation.collnamespace
      WHERE namespace.nspname = $1
      ORDER BY range_type_definition.typname COLLATE "C"`,
    [schemaName],
  );
  const ranges = rawRanges.map((range) => ({
    type: range.type_name,
    subtype: range.subtype,
    operatorClass: range.operator_class,
    collation: range.collation,
    canonicalFunction: range.canonical_function,
    subtypeDifferenceFunction: range.subtype_difference_function,
    multirangeType: range.multirange_type,
  }));
  const { rows: rawTypeConstraints } = await client.query(
    `SELECT type_definition.typname AS type_name,
            constraint_definition.conname,
            constraint_definition.contype,
            constraint_definition.condeferrable,
            constraint_definition.condeferred,
            constraint_definition.convalidated,
            pg_catalog.pg_get_constraintdef(constraint_definition.oid, false) AS definition
       FROM pg_catalog.pg_constraint AS constraint_definition
       JOIN pg_catalog.pg_type AS type_definition
         ON type_definition.oid = constraint_definition.contypid
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = type_definition.typnamespace
      WHERE namespace.nspname = $1
      ORDER BY type_definition.typname COLLATE "C",
               constraint_definition.conname COLLATE "C"`,
    [schemaName],
  );
  const typeConstraints = rawTypeConstraints.map((constraint) => ({
    type: constraint.type_name,
    name: constraint.conname,
    kind: constraint.contype,
    deferrable: constraint.condeferrable,
    initiallyDeferred: constraint.condeferred,
    validated: constraint.convalidated,
    definition: canonicalSqlDeparse(constraint.definition),
  }));
  const schemaInventory = Object.freeze({
    relations: Object.freeze(relations),
    inheritance: Object.freeze(inheritance),
    columns: Object.freeze(columns),
    constraints: Object.freeze(constraints),
    indexes: Object.freeze(indexes),
    policies: Object.freeze(policies),
    rules: Object.freeze(rules),
    internalConstraintTriggers: Object.freeze(internalConstraintTriggers),
    types: Object.freeze(types),
    enumValues: Object.freeze(enumValues),
    compositeAttributes: Object.freeze(compositeAttributes),
    ranges: Object.freeze(ranges),
    typeConstraints: Object.freeze(typeConstraints),
  });

  return Object.freeze({
    snapshotVersion: AUTHORITY_SNAPSHOT_VERSION,
    functions: Object.freeze({
      count: functions.length,
      sha256: authorityDigest(functions),
      ...(includeInventory ? { inventory: Object.freeze(functions) } : {}),
    }),
    triggers: Object.freeze({
      count: triggers.length,
      sha256: authorityDigest(triggers),
      ...(includeInventory ? { inventory: Object.freeze(triggers) } : {}),
    }),
    schema: Object.freeze({
      count: relations.length,
      sha256: authorityDigest(schemaInventory),
      ...(includeInventory ? { inventory: schemaInventory } : {}),
    }),
  });
}

export async function auditRuntimeRole(client, manifest = loadRuntimeAccessManifest()) {
  const violations = [];
  const { rows: versionRows } = await client.query("SHOW server_version_num");
  const serverVersion = Number(versionRows[0]?.server_version_num);
  recordViolation(
    violations,
    Number.isSafeInteger(serverVersion) && serverVersion >= MINIMUM_POSTGRES_VERSION,
    "PostgreSQL 15 or newer is required to audit parameter-level trigger controls.",
  );

  const roleNames = [manifest.migrationOwnerRole, manifest.runtimeRole];
  const { rows: roles } = await client.query(
    `SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
            rolcanlogin, rolreplication, rolbypassrls, rolconfig
       FROM pg_catalog.pg_roles
      WHERE rolname = ANY($1::text[])
      ORDER BY rolname`,
    [roleNames],
  );
  recordViolation(violations, roles.length === 2, "Both PaperPilot database roles must exist.");
  const owner = roles.find((role) => role.rolname === manifest.migrationOwnerRole);
  const runtime = roles.find((role) => role.rolname === manifest.runtimeRole);

  for (const role of [owner, runtime].filter(Boolean)) {
    recordViolation(violations, !role.rolsuper, `${role.rolname} must be NOSUPERUSER.`);
    recordViolation(violations, !role.rolinherit, `${role.rolname} must be NOINHERIT.`);
    recordViolation(violations, !role.rolcreaterole, `${role.rolname} must be NOCREATEROLE.`);
    recordViolation(violations, !role.rolcreatedb, `${role.rolname} must be NOCREATEDB.`);
    recordViolation(violations, !role.rolreplication, `${role.rolname} must be NOREPLICATION.`);
    recordViolation(violations, !role.rolbypassrls, `${role.rolname} must be NOBYPASSRLS.`);
    const settings = role.rolconfig ?? [];
    const searchPath = settings.find((setting) => setting.startsWith("search_path="))?.slice(12);
    const rowSecurity = settings.find((setting) => setting.startsWith("row_security="))?.slice(13);
    const expectedSearchPath = role.rolname === manifest.migrationOwnerRole
      ? "public,pg_catalog"
      : "pg_catalog,public";
    recordViolation(
      violations,
      typeof searchPath === "string" && normalizedSearchPath(searchPath) === expectedSearchPath,
      `${role.rolname} must use the exact reviewed search_path.`,
    );
    recordViolation(
      violations,
      rowSecurity?.toLowerCase() === "on",
      `${role.rolname} must default row_security to on.`,
    );
    recordViolation(
      violations,
      settings.length === 2
        && settings.every((setting) => setting.startsWith("search_path=")
          || setting.startsWith("row_security=")),
      `${role.rolname} must have no unreviewed global role setting.`,
    );
  }
  if (owner) recordViolation(violations, !owner.rolcanlogin, "The migration owner must be NOLOGIN.");
  if (runtime) recordViolation(violations, runtime.rolcanlogin, "The runtime role must be LOGIN.");

  const { rows: memberships } = await client.query(
    `SELECT granted.rolname AS granted_role, member.rolname AS member_role
      FROM pg_catalog.pg_auth_members AS membership
       JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
       JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
      WHERE member.rolname = ANY($1::text[])
         OR granted.rolname = ANY($1::text[])`,
    [roleNames],
  );
  recordViolation(
    violations,
    memberships.length === 0,
    "Owner/runtime role memberships must be empty after deployment.",
  );

  const { rows: databasePrivileges } = await client.query(
    `SELECT current_database() AS database_name,
            owner.rolname AS owner,
            has_database_privilege($1, current_database(), 'CONNECT') AS can_connect,
            has_database_privilege($1, current_database(), 'CREATE') AS can_create,
            has_database_privilege($1, current_database(), 'TEMPORARY') AS can_temporary
       FROM pg_catalog.pg_database AS database
       JOIN pg_catalog.pg_roles AS owner ON owner.oid = database.datdba
      WHERE database.datname = current_database()`,
    [manifest.runtimeRole],
  );
  const databasePrivilege = databasePrivileges[0] ?? {};
  const currentDatabaseName = databasePrivilege.database_name;
  recordViolation(
    violations,
    databasePrivilege.owner !== manifest.runtimeRole,
    "The runtime role must not own the application database.",
  );
  recordViolation(violations, databasePrivilege.can_connect, "The runtime role requires CONNECT.");
  recordViolation(violations, !databasePrivilege.can_create, "The runtime role must not CREATE database objects.");
  recordViolation(violations, !databasePrivilege.can_temporary, "The runtime role must not create temporary tables.");

  const { rows: clusterDatabases } = await client.query(
    `SELECT database.datname,
            database.datistemplate,
            database.datallowconn,
            has_database_privilege($1, database.oid, 'CONNECT') AS can_connect,
            has_database_privilege($1, database.oid, 'CREATE') AS can_create,
            has_database_privilege($1, database.oid, 'TEMPORARY') AS can_temporary
       FROM pg_catalog.pg_database AS database
      ORDER BY database.datname`,
    [manifest.runtimeRole],
  );
  recordViolation(
    violations,
    clusterDatabases.some((database) => database.datname === currentDatabaseName),
    "The connected PaperPilot database must appear in the cluster inventory.",
  );
  recordViolation(
    violations,
    clusterDatabases
      .filter((database) => !database.datistemplate)
      .every((database) => database.datname === currentDatabaseName
        || database.datname === "postgres"),
    "PaperPilot requires a dedicated cluster with no peer application database.",
  );
  for (const database of clusterDatabases) {
    if (database.datname === currentDatabaseName) continue;
    recordViolation(
      violations,
      !database.can_connect && !database.can_create && !database.can_temporary,
      `The runtime role must have no authority on peer database ${database.datname}.`,
    );
  }

  const { rows: databaseAcl } = await client.query(
    `SELECT database_owner.rolname AS owner,
            coalesce(grantee.rolname, 'PUBLIC') AS grantee,
            expanded.privilege_type,
            expanded.is_grantable
       FROM pg_catalog.pg_database AS database
       JOIN pg_catalog.pg_roles AS database_owner ON database_owner.oid = database.datdba
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         coalesce(database.datacl, pg_catalog.acldefault('d', database.datdba))
       ) AS expanded
       LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = expanded.grantee
      WHERE database.datname = current_database()`,
  );
  recordViolation(
    violations,
    exactSet(aclPrivileges(databaseAcl, manifest.runtimeRole), ["CONNECT"]),
    "The runtime role must receive exactly direct CONNECT on the application database.",
  );
  recordViolation(
    violations,
    !hasGrantOption(databaseAcl, manifest.runtimeRole),
    "The runtime database grant must not include GRANT OPTION.",
  );
  recordViolation(
    violations,
    aclPrivileges(databaseAcl, "PUBLIC").length === 0,
    "PUBLIC must have no application-database privilege.",
  );
  recordViolation(
    violations,
    databaseAcl.every((entry) => entry.grantee === entry.owner
      || entry.grantee === manifest.runtimeRole),
    "The application database has an unreviewed direct ACL grantee.",
  );

  const { rows: schemaPrivileges } = await client.query(
    `SELECT owner.rolname AS owner,
            has_schema_privilege($1, namespace.oid, 'USAGE') AS can_use,
            has_schema_privilege($1, namespace.oid, 'CREATE') AS can_create
       FROM pg_catalog.pg_namespace AS namespace
       JOIN pg_catalog.pg_roles AS owner ON owner.oid = namespace.nspowner
      WHERE namespace.nspname = $2`,
    [manifest.runtimeRole, manifest.databaseSchema],
  );
  const schemaPrivilege = schemaPrivileges[0];
  recordViolation(violations, Boolean(schemaPrivilege), "The PaperPilot application schema must exist.");
  if (schemaPrivilege) {
    recordViolation(
      violations,
      schemaPrivilege.owner === manifest.migrationOwnerRole,
      "The migration owner must own the application schema.",
    );
    recordViolation(violations, schemaPrivilege.can_use, "The runtime role requires schema USAGE.");
    recordViolation(violations, !schemaPrivilege.can_create, "The runtime role must not CREATE in the application schema.");
  }

  const { rows: schemaAcl } = await client.query(
    `SELECT owner.rolname AS owner,
            coalesce(grantee.rolname, 'PUBLIC') AS grantee,
            expanded.privilege_type,
            expanded.is_grantable
       FROM pg_catalog.pg_namespace AS namespace
       JOIN pg_catalog.pg_roles AS owner ON owner.oid = namespace.nspowner
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         coalesce(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
       ) AS expanded
       LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = expanded.grantee
      WHERE namespace.nspname = $1`,
    [manifest.databaseSchema],
  );
  recordViolation(
    violations,
    exactSet(aclPrivileges(schemaAcl, manifest.runtimeRole), ["USAGE"]),
    "The runtime role must receive exactly direct USAGE on the application schema.",
  );
  recordViolation(
    violations,
    !hasGrantOption(schemaAcl, manifest.runtimeRole),
    "The runtime schema grant must not include GRANT OPTION.",
  );
  recordViolation(
    violations,
    aclPrivileges(schemaAcl, "PUBLIC").length === 0,
    "PUBLIC must have no application-schema privilege.",
  );
  recordViolation(
    violations,
    schemaAcl.every((entry) => entry.grantee === entry.owner
      || entry.grantee === manifest.runtimeRole),
    "The application schema has an unreviewed direct ACL grantee.",
  );

  const { rows: unexpectedSchemas } = await client.query(
    `SELECT namespace.nspname
       FROM pg_catalog.pg_namespace AS namespace
      WHERE namespace.nspname <> $1
        AND namespace.nspname <> 'information_schema'
        AND namespace.nspname !~ '^pg_'
      ORDER BY namespace.nspname`,
    [manifest.databaseSchema],
  );
  recordViolation(
    violations,
    unexpectedSchemas.length === 0,
    "PaperPilot's dedicated database must not contain an unreviewed user schema.",
  );

  const { rows: runtimeOwnershipRows } = await client.query(
    `SELECT count(*)::integer AS owned_object_count
       FROM pg_catalog.pg_shdepend AS dependency
      WHERE dependency.refclassid = 'pg_catalog.pg_authid'::regclass
        AND dependency.refobjid = (
          SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1
        )
        AND dependency.deptype = 'o'`,
    [manifest.runtimeRole],
  );
  recordViolation(
    violations,
    runtimeOwnershipRows[0]?.owned_object_count === 0,
    "The runtime role must not own any database object.",
  );

  const { rows: tableRows } = await client.query(
    `SELECT relation.relname,
            relation.relkind,
            owner.rolname AS owner,
            has_table_privilege($1, relation.oid, 'SELECT') AS can_select,
            has_table_privilege($1, relation.oid, 'INSERT') AS can_insert,
            has_table_privilege($1, relation.oid, 'UPDATE') AS can_update,
            has_table_privilege($1, relation.oid, 'DELETE') AS can_delete,
            has_table_privilege($1, relation.oid, 'TRUNCATE') AS can_truncate,
            has_table_privilege($1, relation.oid, 'REFERENCES') AS can_reference,
            has_table_privilege($1, relation.oid, 'TRIGGER') AS can_trigger
       FROM pg_catalog.pg_class AS relation
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
      WHERE namespace.nspname = $2
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      ORDER BY relation.relname`,
    [manifest.runtimeRole, manifest.databaseSchema],
  );
  const applicationRows = tableRows.filter((row) => row.relname !== "_prisma_migrations");
  recordViolation(
    violations,
    exactSet(applicationRows.map((row) => row.relname), manifest.applicationTables),
    "The deployed application table set differs from the reviewed runtime allowlist.",
  );
  for (const table of applicationRows) {
    const privilegeContract = tablePrivilegeContract(manifest, table.relname);
    recordViolation(
      violations,
      table.owner === manifest.migrationOwnerRole,
      `${table.relname} must be owned by the migration owner.`,
    );
    recordViolation(violations, table.relkind === "r" || table.relkind === "p", `${table.relname} is an unreviewed view.`);
    for (const privilege of ALL_TABLE_PRIVILEGES) {
      const property = privilege === "REFERENCES" ? "can_reference" : `can_${privilege.toLowerCase()}`;
      const expected = privilegeContract.tablePrivileges.includes(privilege);
      recordViolation(
        violations,
        table[property] === expected,
        `${manifest.runtimeRole} has incorrect table-level ${privilege} authority on ${table.relname}.`,
      );
    }
  }

  const { rows: tableAclRows } = await client.query(
    `SELECT relation.relname,
            owner.rolname AS owner,
            coalesce(grantee.rolname, 'PUBLIC') AS grantee,
            expanded.privilege_type,
            expanded.is_grantable
       FROM pg_catalog.pg_class AS relation
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
       ) AS expanded
       LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = expanded.grantee
      WHERE namespace.nspname = $1
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')`,
    [manifest.databaseSchema],
  );
  for (const table of tableRows) {
    const acl = tableAclRows.filter((row) => row.relname === table.relname);
    const expectedRuntime = table.relname === "_prisma_migrations"
      ? []
      : tablePrivilegeContract(manifest, table.relname).tablePrivileges;
    recordViolation(
      violations,
      exactSet(aclPrivileges(acl, manifest.runtimeRole), expectedRuntime),
      `${table.relname} has a direct runtime ACL outside its reviewed privilege set.`,
    );
    recordViolation(
      violations,
      !hasGrantOption(acl, manifest.runtimeRole),
      `${table.relname} must not give the runtime role GRANT OPTION.`,
    );
    recordViolation(
      violations,
      aclPrivileges(acl, "PUBLIC").length === 0,
      `PUBLIC must have no privilege on ${table.relname}.`,
    );
    recordViolation(
      violations,
      acl.every((entry) => entry.grantee === entry.owner
        || entry.grantee === manifest.runtimeRole),
      `${table.relname} has an unreviewed direct ACL grantee.`,
    );
  }

  const { rows: columnAclRows } = await client.query(
    `SELECT relation.relname,
            attribute.attname,
            owner.rolname AS owner,
            coalesce(grantee.rolname, 'PUBLIC') AS grantee,
            expanded.privilege_type,
            expanded.is_grantable
       FROM pg_catalog.pg_attribute AS attribute
       JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
       CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS expanded
       LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = expanded.grantee
      WHERE namespace.nspname = $1
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped`,
    [manifest.databaseSchema],
  );
  for (const table of tableRows) {
    const acl = columnAclRows.filter((row) => row.relname === table.relname);
    const expectedRuntime = table.relname === "_prisma_migrations"
      ? []
      : columnPrivilegeKeys(
          tablePrivilegeContract(manifest, table.relname).columnPrivileges,
        );
    const actualRuntime = acl
      .filter((entry) => entry.grantee === manifest.runtimeRole)
      .map((entry) => `${entry.privilege_type}:${entry.attname}`);
    recordViolation(
      violations,
      exactSet(actualRuntime, expectedRuntime),
      `${table.relname} has a direct runtime column ACL outside its reviewed set.`,
    );
    recordViolation(
      violations,
      !hasGrantOption(acl, manifest.runtimeRole),
      `${table.relname} must not give runtime a column GRANT OPTION.`,
    );
    recordViolation(
      violations,
      aclPrivileges(acl, "PUBLIC").length === 0,
      `PUBLIC must have no column privilege on ${table.relname}.`,
    );
    recordViolation(
      violations,
      acl.every((entry) => entry.grantee === entry.owner
        || entry.grantee === manifest.runtimeRole),
      `${table.relname} has an unreviewed direct column ACL grantee.`,
    );
  }

  const migrationLedger = tableRows.find((row) => row.relname === "_prisma_migrations");
  recordViolation(violations, Boolean(migrationLedger), "The Prisma migration ledger must exist.");
  if (migrationLedger) {
    recordViolation(
      violations,
      migrationLedger.relkind === "r",
      "The Prisma migration ledger must be an ordinary table.",
    );
    recordViolation(
      violations,
      migrationLedger.owner === manifest.migrationOwnerRole,
      "The migration owner must own the Prisma migration ledger.",
    );
    const ledgerPrivileges = [
      migrationLedger.can_select,
      migrationLedger.can_insert,
      migrationLedger.can_update,
      migrationLedger.can_delete,
      migrationLedger.can_truncate,
      migrationLedger.can_reference,
      migrationLedger.can_trigger,
    ];
    recordViolation(
      violations,
      ledgerPrivileges.every((privilege) => !privilege),
      "The runtime role must have no privilege on _prisma_migrations.",
    );
    const { rows: ledgerColumnPrivileges } = await client.query(
      `SELECT has_any_column_privilege($1, $2, 'SELECT') AS can_select,
              has_any_column_privilege($1, $2, 'INSERT') AS can_insert,
              has_any_column_privilege($1, $2, 'UPDATE') AS can_update,
              has_any_column_privilege($1, $2, 'REFERENCES') AS can_reference`,
      [manifest.runtimeRole, `${manifest.databaseSchema}._prisma_migrations`],
    );
    recordViolation(
      violations,
      ledgerColumnPrivileges.length === 1
        && Object.values(ledgerColumnPrivileges[0]).every((privilege) => !privilege),
      "The runtime role must have no column privilege on _prisma_migrations.",
    );
  }

  const { rows: sequences } = await client.query(
    `SELECT relation.relname,
            owner.rolname AS owner,
            has_sequence_privilege($1, relation.oid, 'USAGE') AS can_use,
            has_sequence_privilege($1, relation.oid, 'SELECT') AS can_select,
            has_sequence_privilege($1, relation.oid, 'UPDATE') AS can_update
       FROM pg_catalog.pg_class AS relation
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
      WHERE namespace.nspname = $2
        AND relation.relkind = 'S'`,
    [manifest.runtimeRole, manifest.databaseSchema],
  );
  recordViolation(
    violations,
    sequences.length === 0,
    "The reviewed Prisma schema requires no sequences; any new sequence needs an explicit grant review.",
  );

  const { rows: functions } = await client.query(
    `SELECT routine.oid,
            routine.proname,
            pg_catalog.oidvectortypes(routine.proargtypes) AS identity_arguments,
            owner.rolname AS owner,
            has_function_privilege($1, routine.oid, 'EXECUTE') AS can_execute
       FROM pg_catalog.pg_proc AS routine
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
       JOIN pg_catalog.pg_roles AS owner ON owner.oid = routine.proowner
      WHERE namespace.nspname = $2`,
    [manifest.runtimeRole, manifest.databaseSchema],
  );
  const foundExecutableFunctions = [];
  for (const routine of functions) {
    const identityArguments = routine.identity_arguments.replaceAll(/\s/g, "");
    const signature = `${routine.proname}(${identityArguments})`;
    const requiresExecute = manifest.requiredFunctionExecute.includes(signature);
    recordViolation(
      violations,
      routine.owner === manifest.migrationOwnerRole,
      `Function ${routine.proname} must be owned by the migration owner.`,
    );
    recordViolation(
      violations,
      routine.can_execute === requiresExecute,
      requiresExecute
        ? `The runtime role requires EXECUTE on helper ${signature}.`
        : `The runtime role must not directly EXECUTE function ${signature}.`,
    );
    if (requiresExecute) foundExecutableFunctions.push(signature);
  }
  recordViolation(
    violations,
    exactSet(foundExecutableFunctions, manifest.requiredFunctionExecute),
    "The required trigger-helper function set is missing or has signature drift.",
  );

  const { rows: forbiddenSystemFunctions } = await client.query(
    `SELECT requested.signature,
            routine.oid IS NOT NULL AS exists,
            CASE WHEN routine.oid IS NULL THEN NULL
              ELSE has_function_privilege($1, routine.oid, 'EXECUTE')
            END AS runtime_can_execute,
            CASE WHEN routine.oid IS NULL THEN NULL
              ELSE EXISTS (
                SELECT 1
                FROM pg_catalog.aclexplode(
                  coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
                ) AS expanded
                WHERE expanded.grantee = 0
                  AND expanded.privilege_type = 'EXECUTE'
              )
            END AS public_can_execute
       FROM unnest($2::text[]) AS requested(signature)
       LEFT JOIN pg_catalog.pg_proc AS routine
         ON routine.oid = pg_catalog.to_regprocedure(
           'pg_catalog.' || requested.signature
         )`,
    [manifest.runtimeRole, manifest.forbiddenSystemFunctionExecute],
  );
  for (const routine of forbiddenSystemFunctions) {
    recordViolation(
      violations,
      routine.exists,
      `Required large-object denial target ${routine.signature} is missing.`,
    );
    recordViolation(
      violations,
      routine.runtime_can_execute === false,
      `The runtime role must not execute pg_catalog.${routine.signature}.`,
    );
    recordViolation(
      violations,
      routine.public_can_execute === false,
      `PUBLIC must not execute pg_catalog.${routine.signature}.`,
    );
  }

  const { rows: functionAclRows } = await client.query(
    `SELECT routine.oid,
            routine.proname,
            pg_catalog.oidvectortypes(routine.proargtypes) AS identity_arguments,
            owner.rolname AS owner,
            coalesce(grantee.rolname, 'PUBLIC') AS grantee,
            expanded.privilege_type,
            expanded.is_grantable
       FROM pg_catalog.pg_proc AS routine
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
       JOIN pg_catalog.pg_roles AS owner ON owner.oid = routine.proowner
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
       ) AS expanded
       LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = expanded.grantee
      WHERE namespace.nspname = $1`,
    [manifest.databaseSchema],
  );
  for (const routine of functions) {
    const identityArguments = routine.identity_arguments.replaceAll(/\s/g, "");
    const signature = `${routine.proname}(${identityArguments})`;
    const acl = functionAclRows.filter((row) => row.oid === routine.oid);
    const expectedRuntime = manifest.requiredFunctionExecute.includes(signature)
      ? ["EXECUTE"]
      : [];
    recordViolation(
      violations,
      exactSet(aclPrivileges(acl, manifest.runtimeRole), expectedRuntime),
      `Function ${signature} has a direct runtime ACL outside its reviewed set.`,
    );
    recordViolation(
      violations,
      !hasGrantOption(acl, manifest.runtimeRole),
      `Function ${signature} must not give the runtime role GRANT OPTION.`,
    );
    recordViolation(
      violations,
      aclPrivileges(acl, "PUBLIC").length === 0,
      `PUBLIC must not execute function ${signature}.`,
    );
    recordViolation(
      violations,
      acl.every((entry) => entry.grantee === entry.owner
        || entry.grantee === manifest.runtimeRole),
      `Function ${signature} has an unreviewed direct ACL grantee.`,
    );
  }

  const { rows: ownedTypes } = await client.query(
    `SELECT type_definition.oid,
            type_definition.typname,
            owner.rolname AS owner
       FROM pg_catalog.pg_type AS type_definition
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_definition.typnamespace
       JOIN pg_catalog.pg_roles AS owner ON owner.oid = type_definition.typowner
      WHERE namespace.nspname = $1
        AND type_definition.typisdefined`,
    [manifest.databaseSchema],
  );
  for (const type of ownedTypes) {
    recordViolation(
      violations,
      type.owner === manifest.migrationOwnerRole,
      `Type ${type.typname} must be owned by the migration owner.`,
    );
  }

  // Table row types, true implicit arrays, and multiranges inherit authority
  // from their controlling relation/element/range and intentionally have no
  // independently manageable ACL. Keep them in the ownership inventory above,
  // but audit effective/direct USAGE only on independent privilege-bearing types.
  const { rows: types } = await client.query(
    `SELECT type_definition.oid,
            type_definition.typname,
            has_type_privilege($1, type_definition.oid, 'USAGE') AS can_use
       FROM pg_catalog.pg_type AS type_definition
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_definition.typnamespace
       LEFT JOIN pg_catalog.pg_class AS composite_relation
         ON composite_relation.oid = type_definition.typrelid
      WHERE namespace.nspname = $2
        AND type_definition.typisdefined
        AND (type_definition.typrelid = 0 OR composite_relation.relkind = 'c')
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_type AS element_type
          WHERE element_type.typarray = type_definition.oid
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_range AS range_type
          WHERE range_type.rngmultitypid = type_definition.oid
        )`,
    [manifest.runtimeRole, manifest.databaseSchema],
  );
  for (const type of types) {
    recordViolation(
      violations,
      !type.can_use,
      `The runtime role does not require USAGE on type ${type.typname}.`,
    );
  }

  const applicationAuthority = await applicationAuthoritySnapshot(
    client,
    manifest.databaseSchema,
  );
  recordViolation(
    violations,
    applicationAuthority.snapshotVersion === manifest.authoritySnapshotVersion
      && applicationAuthority.functions.count === manifest.applicationFunctionAuthority.count
      && applicationAuthority.functions.sha256 === manifest.applicationFunctionAuthority.sha256,
    "Application authority snapshot version, function inventory, security metadata, or body digest differs from the reviewed contract.",
  );
  recordViolation(
    violations,
    applicationAuthority.triggers.count === manifest.applicationTriggerAuthority.count
      && applicationAuthority.triggers.sha256 === manifest.applicationTriggerAuthority.sha256,
    "Application trigger inventory, enablement, events, arguments, or binding differs from the reviewed contract.",
  );
  recordViolation(
    violations,
    applicationAuthority.schema.count === manifest.applicationSchemaAuthority.count
      && applicationAuthority.schema.sha256 === manifest.applicationSchemaAuthority.sha256,
    "Application columns, defaults, constraints, indexes, RLS, policies, rewrite rules, or data types differ from the reviewed contract.",
  );

  const { rows: typeAclRows } = await client.query(
    `SELECT type_definition.oid,
            owner.rolname AS owner,
            coalesce(grantee.rolname, 'PUBLIC') AS grantee,
            expanded.privilege_type,
            expanded.is_grantable
       FROM pg_catalog.pg_type AS type_definition
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_definition.typnamespace
       JOIN pg_catalog.pg_roles AS owner ON owner.oid = type_definition.typowner
       LEFT JOIN pg_catalog.pg_class AS composite_relation
         ON composite_relation.oid = type_definition.typrelid
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         coalesce(type_definition.typacl, pg_catalog.acldefault('T', type_definition.typowner))
       ) AS expanded
       LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = expanded.grantee
      WHERE namespace.nspname = $1
        AND type_definition.typisdefined
        AND (type_definition.typrelid = 0 OR composite_relation.relkind = 'c')
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_type AS element_type
          WHERE element_type.typarray = type_definition.oid
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_range AS range_type
          WHERE range_type.rngmultitypid = type_definition.oid
        )`,
    [manifest.databaseSchema],
  );
  for (const type of types) {
    const acl = typeAclRows.filter((entry) => entry.oid === type.oid);
    recordViolation(
      violations,
      aclPrivileges(acl, manifest.runtimeRole).length === 0,
      `Type ${type.typname} must not directly grant runtime authority.`,
    );
    recordViolation(
      violations,
      aclPrivileges(acl, "PUBLIC").length === 0,
      `Type ${type.typname} must not grant PUBLIC authority.`,
    );
    recordViolation(
      violations,
      acl.every((entry) => entry.grantee === entry.owner),
      `Type ${type.typname} has an unreviewed direct ACL grantee.`,
    );
  }

  const { rows: defaultAclRows } = await client.query(
    `WITH requested(object_type) AS (
       VALUES ('r'::"char"), ('S'::"char"), ('f'::"char"), ('T'::"char"), ('n'::"char")
     ), owner_role AS (
       SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1
     )
     SELECT requested.object_type,
            coalesce(grantee.rolname, 'PUBLIC') AS grantee,
            expanded.privilege_type,
            expanded.is_grantable
       FROM requested
       CROSS JOIN owner_role
       LEFT JOIN pg_catalog.pg_default_acl AS defaults
         ON defaults.defaclrole = owner_role.oid
        AND defaults.defaclnamespace = 0
        AND defaults.defaclobjtype = requested.object_type
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         coalesce(
           defaults.defaclacl,
           pg_catalog.acldefault(requested.object_type, owner_role.oid)
         )
       ) AS expanded
       LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = expanded.grantee`,
    [manifest.migrationOwnerRole],
  );
  for (const objectType of ["r", "S", "f", "T", "n"]) {
    const acl = defaultAclRows.filter((row) => row.object_type === objectType);
    recordViolation(
      violations,
      acl.length > 0 && acl.every(
        (entry) => entry.grantee === manifest.migrationOwnerRole,
      ),
      `The migration owner's global default ACL for ${objectType} must be exact owner-only.`,
    );
  }
  const { rows: additiveDefaultAclRows } = await client.query(
    `SELECT defaults.defaclobjtype AS object_type,
            namespace.nspname AS schema_name,
            coalesce(grantee.rolname, 'PUBLIC') AS grantee,
            expanded.privilege_type,
            expanded.is_grantable
       FROM pg_catalog.pg_default_acl AS defaults
       LEFT JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = defaults.defaclnamespace
       CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) AS expanded
       LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = expanded.grantee
      WHERE defaults.defaclrole = (
        SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1
      )`,
    [manifest.migrationOwnerRole],
  );
  recordViolation(
    violations,
    additiveDefaultAclRows.every(
      (entry) => entry.grantee === manifest.migrationOwnerRole,
    ),
    "Every global or schema-scoped migration-owner default ACL must be exact owner-only.",
  );

  if (Number.isSafeInteger(serverVersion) && serverVersion >= MINIMUM_POSTGRES_VERSION) {
    const { rows: parameterPrivileges } = await client.query(
      `SELECT has_parameter_privilege($1, 'session_replication_role', 'SET') AS can_set_replication_role,
              has_parameter_privilege($1, 'session_replication_role', 'ALTER SYSTEM') AS can_alter_system_replication_role`,
      [manifest.runtimeRole],
    );
    recordViolation(
      violations,
      !parameterPrivileges[0]?.can_set_replication_role,
      "The runtime role must not SET session_replication_role.",
    );
    recordViolation(
      violations,
      !parameterPrivileges[0]?.can_alter_system_replication_role,
      "The runtime role must not ALTER SYSTEM session_replication_role.",
    );
    const { rows: parameterAcl } = await client.query(
      `SELECT parameter.parname,
              coalesce(grantee.rolname, 'PUBLIC') AS grantee,
              expanded.privilege_type,
              expanded.is_grantable
         FROM pg_catalog.pg_parameter_acl AS parameter
         CROSS JOIN LATERAL pg_catalog.aclexplode(parameter.paracl) AS expanded
         LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = expanded.grantee
        ORDER BY parameter.parname COLLATE "C",
                 coalesce(grantee.rolname, 'PUBLIC') COLLATE "C",
                 expanded.privilege_type COLLATE "C"`,
    );
    recordViolation(
      violations,
      parameterAcl.every((entry) => ![
        "PUBLIC",
        manifest.migrationOwnerRole,
        manifest.runtimeRole,
      ].includes(entry.grantee)),
      "No parameter may directly grant PUBLIC, migration-owner, or runtime authority.",
    );
  }

  const { rows: roleSettings } = await client.query(
    `SELECT coalesce(database.datname, '*') AS database_scope,
            setting
       FROM pg_catalog.pg_db_role_setting AS role_setting
       LEFT JOIN pg_catalog.pg_database AS database ON database.oid = role_setting.setdatabase
       CROSS JOIN LATERAL unnest(role_setting.setconfig) AS setting
      WHERE role_setting.setdatabase <> 0
        AND role_setting.setrole IN (
        SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])
      )`,
    [[manifest.migrationOwnerRole, manifest.runtimeRole]],
  );
  recordViolation(
    violations,
    roleSettings.length === 0,
    "Owner/runtime roles must have no database-specific settings.",
  );

  if (violations.length > 0) {
    throw new Error(`PostgreSQL least-privilege audit failed:\n- ${violations.join("\n- ")}`);
  }
  return Object.freeze({
    serverVersion,
    applicationTableCount: applicationRows.length,
    applicationFunctionCount: functions.length,
    applicationTypeCount: types.length,
  });
}

export async function main() {
  const connectionString = validatedAuditUrl(process.env[AUDIT_URL_ENV]);
  const client = new Client({
    connectionString,
    application_name: "paperpilot-role-audit",
    connectionTimeoutMillis: 5_000,
    query_timeout: 20_000,
  });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    const result = await auditRuntimeRole(client);
    await client.query("ROLLBACK");
    process.stdout.write(
      `PostgreSQL role audit passed: ${result.applicationTableCount} application tables, `
      + `${result.applicationFunctionCount} protected functions, ${result.applicationTypeCount} protected types.\n`,
    );
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original audit/transport error is authoritative.
    }
    throw error;
  } finally {
    await client.end();
  }
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : "";
if (currentFile === invokedFile) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "PostgreSQL role audit failed."}\n`);
    process.exitCode = 1;
  });
}
