#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";

import {
  PAPERPILOT_SUPABASE_DIRECT_DATABASE_PROFILE,
  validatedPaperPilotApplicationDatabaseUrl,
} from "../src/lib/postgres-connection-url.mjs";

const SUPPORTED_PHASES = new Set(["infrastructure", "release"]);
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/u;
const IMMUTABLE_IMAGE_PATTERN = /@sha256:[a-f0-9]{64}$/u;
const PLACEHOLDER_PATTERN = /(?:change[-_ ]?me|development|example|placeholder|replace[-_ ]?me|todo|tbd)/iu;
const DEFAULT_TIMEOUT_MS = 8_000;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;
const MAX_HEALTH_BODY_BYTES = 1_024;
const MAX_RELEASE_MANIFEST_BYTES = 262_144;

const REQUIRED_RUNTIME_SERVICES = Object.freeze([
  "caddy",
  "web",
  "validator",
  "clamav",
  "validation-worker",
  "extractor",
  "extraction-worker",
]);
const WORKER_SERVICES = Object.freeze([
  "validation-worker",
  "extraction-worker",
]);
const REQUIRED_COMPLETED_SERVICES = Object.freeze([
  "internal-ca-export",
  "storage-init",
]);
const CONFIG_HEALTHCHECKED_SERVICES = Object.freeze([
  "caddy",
  "validator",
  "extractor",
]);
const REQUIRED_INTERNAL_NETWORKS = Object.freeze([
  "app",
  "validation",
  "extraction",
  "scan",
]);
const REQUIRED_EGRESS_NETWORKS = Object.freeze([
  "edge",
  "database_egress",
  "web_egress",
  "signature_updates",
]);
const DATABASE_USING_SERVICES = Object.freeze([
  "web",
  "validation-worker",
  "extraction-worker",
]);
const FORBIDDEN_SELF_HOSTED_DATABASE_VOLUMES = Object.freeze([
  "postgres_data",
  "postgres_tls",
]);
const SERVICE_NETWORK_CONTRACT = Object.freeze({
  caddy: Object.freeze(["app", "edge", "extraction", "validation"]),
  web: Object.freeze(["app", "database_egress", "web_egress"]),
  validator: Object.freeze(["scan", "validation"]),
  clamav: Object.freeze(["scan", "signature_updates"]),
  "validation-worker": Object.freeze(["database_egress", "validation"]),
  extractor: Object.freeze(["extraction"]),
  "extraction-worker": Object.freeze(["database_egress", "extraction"]),
});
const RUNTIME_HEALTHCHECKED_SERVICES = Object.freeze([
  "caddy",
  "web",
  "validator",
  "clamav",
  "extractor",
]);
const REQUIRED_DEPLOYMENT_FILES = Object.freeze([
  ".dockerignore",
  "Dockerfile",
  "deploy/app/compose.yaml",
  "deploy/app/Caddyfile",
  "deploy/app/compose.env.example",
  "deploy/app/README.md",
  ".env.example",
  "src/app/livez/route.ts",
  "src/app/readyz/route.ts",
]);
const REQUIRED_RELEASE_EVIDENCE_FILES = Object.freeze([
  "upload-flow.webm",
  "webmcp-native-text.webm",
  "webmcp-native-figure.webm",
  "webmcp-region-a.webm",
  "webmcp-region-b.webm",
  "persistence-refresh.webm",
  "keyboard-screen-reader.webm",
  "playwright-trace.zip",
  "sanitized-request-events.json",
  "accessibility-checklist.md",
]);

const LOCAL_WEB_PROBE_SOURCE = String.raw`
const maximumBytes = 1024;
const probe = async (url) => {
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json", "Cache-Control": "no-store" },
    redirect: "manual",
    cache: "no-store",
    credentials: "omit",
    signal: AbortSignal.timeout(5000),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes) throw new Error("health_body_too_large");
  return {
    requestedUrl: url,
    finalUrl: response.url,
    redirected: response.redirected,
    status: response.status,
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    nosniff: response.headers.get("x-content-type-options"),
    bodyText: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  };
};
const observations = await Promise.all([
  probe("http://127.0.0.1:3000/livez"),
  probe("http://127.0.0.1:3000/readyz"),
]);
process.stdout.write(JSON.stringify(observations));
`;

const PRIVATE_READINESS_PROBE_SOURCE = String.raw`
const maximumBytes = 4096;
const serviceKind = process.env.PAPERPILOT_PREFLIGHT_SERVICE_KIND;
const definitions = {
  validation: {
    endpointName: "PAPERPILOT_VALIDATION_SERVICE_READINESS_ENDPOINT",
    secretName: "PAPERPILOT_VALIDATION_SERVICE_BEARER_SECRET",
  },
  extraction: {
    endpointName: "PAPERPILOT_EXTRACTION_SERVICE_READINESS_ENDPOINT",
    secretName: "PAPERPILOT_EXTRACTION_SERVICE_BEARER_SECRET",
  },
};
const definition = definitions[serviceKind];
if (!definition) throw new Error("unknown_service_kind");
const endpoint = process.env[definition.endpointName];
const secret = process.env[definition.secretName];
if (!endpoint || !secret) throw new Error("readiness_configuration_missing");
const request = async (authenticated) => {
  const headers = { Accept: "application/json", "Cache-Control": "no-store" };
  if (authenticated) headers.Authorization = "Bearer " + secret;
  const response = await fetch(endpoint, {
    method: "GET",
    headers,
    redirect: "manual",
    cache: "no-store",
    credentials: "omit",
    signal: AbortSignal.timeout(5000),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes) throw new Error("readiness_body_too_large");
  return {
    urlMatches: response.url === endpoint,
    redirected: response.redirected,
    status: response.status,
    contentType: response.headers.get("content-type"),
    bodyText: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  };
};
const [authenticated, anonymous] = await Promise.all([request(true), request(false)]);
let identityMatches = true;
if (serviceKind === "extraction") {
  try {
    const identity = JSON.parse(authenticated.bodyText);
    identityMatches = identity.policyVersion === process.env.PAPERPILOT_EXTRACTION_POLICY_VERSION
      && identity.toolchainDigest === process.env.PAPERPILOT_EXTRACTION_EXPECTED_TOOLCHAIN_DIGEST;
  } catch {
    identityMatches = false;
  }
}
process.stdout.write(JSON.stringify({ serviceKind, authenticated, anonymous, identityMatches }));
`;

function plainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedPath(value) {
  return resolve(value).replaceAll("\\", "/").toLocaleLowerCase();
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function pathInside(root, candidate) {
  const relation = relative(root, candidate);
  return relation === ""
    || (relation !== ".." && !relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(relation));
}

function safeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= MIN_TIMEOUT_MS && parsed <= MAX_TIMEOUT_MS
    ? parsed
    : fallback;
}

function result(status, id, summary, remediation = "") {
  return Object.freeze({ status, id, summary, remediation });
}

function pass(id, summary) {
  return result("pass", id, summary);
}

function fail(id, summary, remediation) {
  return result("fail", id, summary, remediation);
}

function blocked(id, summary) {
  return result("blocked", id, summary);
}

function recorded(id, summary) {
  return result("recorded", id, summary);
}

function notChecked(id, summary) {
  return result("not_checked", id, summary);
}

function rejectPublicHostname(hostname) {
  const lower = hostname.toLocaleLowerCase();
  const address = lower.startsWith("[") && lower.endsWith("]")
    ? lower.slice(1, -1)
    : lower;
  if (
    lower === "localhost"
    || lower.endsWith(".localhost")
    || lower.endsWith(".local")
    || lower.endsWith(".internal")
    || lower.endsWith(".test")
    || lower.endsWith(".invalid")
    || lower === "example.com"
    || lower.endsWith(".example.com")
  ) return true;

  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    return octets[0] === 0
      || octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || octets[0] >= 224;
  }
  if (isIP(address) === 6) {
    return address === "::1"
      || address === "::"
      || address.startsWith("fc")
      || address.startsWith("fd")
      || address.startsWith("fe8")
      || address.startsWith("fe9")
      || address.startsWith("fea")
      || address.startsWith("feb");
  }
  return false;
}

export function canonicalPublicHttpsOrigin(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = new URL(value.trim());
    if (
      parsed.protocol !== "https:"
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.search !== ""
      || parsed.hash !== ""
      || (parsed.pathname !== "" && parsed.pathname !== "/")
      || rejectPublicHostname(parsed.hostname)
    ) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function canonicalPrivateHttpsEndpoint(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = new URL(value.trim());
    if (
      parsed.protocol !== "https:"
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.search !== ""
      || parsed.hash !== ""
    ) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function strongSecret(value) {
  return typeof value === "string"
    && value.length >= 32
    && !PLACEHOLDER_PATTERN.test(value)
    && new Set(value).size >= 12;
}

export function parseArguments(argv) {
  const parsed = {
    phase: "release",
    composeFile: "deploy/app/compose.yaml",
    envFile: "deploy/app/.env",
    publicOrigin: "",
    releaseId: "",
    releaseManifest: "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    help: false,
  };
  const valueOptions = new Set([
    "--phase",
    "--compose-file",
    "--env-file",
    "--public-origin",
    "--release-id",
    "--release-manifest",
    "--timeout-ms",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      parsed.json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    if (!valueOptions.has(argument)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Option ${argument} requires a value.`);
    }
    index += 1;
    switch (argument) {
      case "--phase": parsed.phase = value; break;
      case "--compose-file": parsed.composeFile = value; break;
      case "--env-file": parsed.envFile = value; break;
      case "--public-origin": parsed.publicOrigin = value; break;
      case "--release-id": parsed.releaseId = value; break;
      case "--release-manifest": parsed.releaseManifest = value; break;
      case "--timeout-ms": parsed.timeoutMs = safeInteger(value, Number.NaN); break;
      default: break;
    }
  }
  if (!SUPPORTED_PHASES.has(parsed.phase)) {
    throw new Error("--phase must be infrastructure or release.");
  }
  if (!Number.isSafeInteger(parsed.timeoutMs)) {
    throw new Error(`--timeout-ms must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}.`);
  }
  return Object.freeze(parsed);
}

function serviceEnvironment(service) {
  const environment = service?.environment;
  if (plainObject(environment)) {
    return Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, value == null ? "" : String(value)]));
  }
  if (Array.isArray(environment)) {
    const entries = environment.map((entry) => {
      const text = String(entry);
      const separator = text.indexOf("=");
      return separator < 0 ? [text, ""] : [text.slice(0, separator), text.slice(separator + 1)];
    });
    return Object.fromEntries(entries);
  }
  return {};
}

function serviceLabels(service) {
  const labels = service?.labels;
  if (plainObject(labels)) return Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, String(value)]));
  if (Array.isArray(labels)) {
    return Object.fromEntries(labels.map((entry) => {
      const text = String(entry);
      const separator = text.indexOf("=");
      return separator < 0 ? [text, ""] : [text.slice(0, separator), text.slice(separator + 1)];
    }));
  }
  return {};
}

function publishedPorts(service) {
  if (!Array.isArray(service?.ports)) return [];
  return service.ports.flatMap((port) => {
    if (plainObject(port)) {
      return port.published == null ? [] : [{
        target: Number(port.target),
        published: Number(port.published),
        protocol: String(port.protocol ?? "tcp").toLowerCase(),
      }];
    }
    const text = String(port);
    const segments = text.split(":");
    if (segments.length < 2) return [];
    const [targetText, protocol = "tcp"] = String(segments.at(-1)).split("/");
    const target = Number(targetText);
    const published = Number(segments.at(-2));
    return Number.isFinite(target) && Number.isFinite(published)
      ? [{ target, published, protocol: protocol.toLowerCase() }]
      : [];
  });
}

function serviceNetworkNames(service) {
  const networks = service?.networks;
  if (Array.isArray(networks)) return networks.map(String).sort();
  if (plainObject(networks)) return Object.keys(networks).sort();
  return [];
}

function exactStringSet(actual, expected) {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function namedVolumeMounts(service) {
  if (!Array.isArray(service?.volumes)) return [];
  return service.volumes.flatMap((volume) => {
    if (plainObject(volume)) {
      return volume.type === "volume" && typeof volume.source === "string"
        ? [{ source: volume.source, target: String(volume.target ?? "") }]
        : [];
    }
    const text = String(volume);
    const [source, target] = text.split(":");
    return source && target && !source.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(source)
      ? [{ source, target }]
      : [];
  });
}

function canonicalContainerFilePath(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.length > 1_024
    || /[\u0000-\u001f\u007f]/u.test(value)
    || !posix.isAbsolute(value)
    || value.endsWith("/")
    || posix.normalize(value) !== value
  ) return null;
  return value;
}

/**
 * Return container targets whose Compose declaration makes them read-only.
 * `docker compose config --format json` normally expands short volume syntax
 * to objects, but retaining the string branch keeps direct fixture inspection
 * fail-closed and deterministic.
 */
function readOnlyMountedTargets(service) {
  const targets = [];
  if (Array.isArray(service?.volumes)) {
    for (const volume of service.volumes) {
      if (plainObject(volume)) {
        if (volume.read_only === true && typeof volume.target === "string") {
          targets.push(volume.target);
        }
        continue;
      }
      const segments = String(volume).split(":");
      const options = segments.length >= 3 ? segments.at(-1).split(",") : [];
      if (options.includes("ro") && segments.length >= 3) {
        targets.push(segments.at(-2));
      }
    }
  }
  // Compose configs and secrets are mounted read-only by the container
  // runtime. Only explicit targets can cover the configured CA path.
  for (const collectionName of ["configs", "secrets"]) {
    const collection = service?.[collectionName];
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      if (plainObject(item) && typeof item.target === "string") {
        targets.push(item.target);
      }
    }
  }
  return [...new Set(targets)];
}

function approvedSupabaseRuntimeDatabaseUrl(environment) {
  if (
    environment.PAPERPILOT_DATABASE_PROFILE
      !== PAPERPILOT_SUPABASE_DIRECT_DATABASE_PROFILE
  ) return false;
  try {
    const connection = validatedPaperPilotApplicationDatabaseUrl(
      environment.DATABASE_URL,
      { databaseProfile: environment.PAPERPILOT_DATABASE_PROFILE },
    );
    const encodedPassword = new URL(connection.connectionString).password;
    const password = decodeURIComponent(encodedPassword);
    return strongSecret(password);
  } catch {
    return false;
  }
}

function configuredSupabaseDatabaseIssues(services) {
  const issues = [];
  for (const serviceName of DATABASE_USING_SERVICES) {
    const service = services[serviceName];
    const environment = serviceEnvironment(service);
    if (
      environment.PAPERPILOT_DATABASE_PROFILE
        !== PAPERPILOT_SUPABASE_DIRECT_DATABASE_PROFILE
    ) {
      issues.push(`${serviceName} does not select the exact approved Supabase database profile`);
    }
    if (!approvedSupabaseRuntimeDatabaseUrl(environment)) {
      issues.push(`${serviceName} DATABASE_URL is not the approved password-bearing Supabase direct runtime URL`);
    }
    if (environment.PAPERPILOT_ALLOW_LOCAL_PRISMA_DEV === "1") {
      issues.push(`${serviceName} permits retired local Prisma development mode`);
    }
    if (environment.SHADOW_DATABASE_URL?.trim()) {
      issues.push(`${serviceName} exposes a forbidden runtime shadow database URL`);
    }

    const caPath = canonicalContainerFilePath(
      environment.PAPERPILOT_DATABASE_CA_CERT_PATH,
    );
    if (!caPath) {
      issues.push(`${serviceName} Supabase CA path is not one canonical absolute container file path`);
    } else if (!readOnlyMountedTargets(service).includes(caPath)) {
      issues.push(`${serviceName} Supabase CA path is not covered by an exact read-only mount`);
    }

    if (!serviceNetworkNames(service).includes("database_egress")) {
      issues.push(`${serviceName} has no external Supabase database egress network`);
    }
  }
  return issues;
}

function healthcheckEnabled(service) {
  if (!plainObject(service?.healthcheck) || service.healthcheck.disable === true) return false;
  const test = service.healthcheck.test;
  if (Array.isArray(test)) {
    return test.length > 0 && String(test[0]).toUpperCase() !== "NONE";
  }
  return typeof test === "string" && test.trim() !== "";
}

function immutableImageReference(service) {
  return typeof service?.image === "string" && IMMUTABLE_IMAGE_PATTERN.test(service.image);
}

function immutableNodeBuildBase(service) {
  return plainObject(service?.build)
    && plainObject(service.build.args)
    && typeof service.build.args.NODE_IMAGE === "string"
    && IMMUTABLE_IMAGE_PATTERN.test(service.build.args.NODE_IMAGE);
}

function configuredLimitIssues(services) {
  const web = serviceEnvironment(services.web);
  const validator = serviceEnvironment(services.validator);
  const extractor = serviceEnvironment(services.extractor);
  const uploadBytes = Number(web.PAPERPILOT_UPLOAD_MAX_BYTES);
  const validatorBytes = Number(validator.PAPERPILOT_VALIDATOR_MAX_BODY_BYTES);
  const extractorBytes = Number(extractor.PAPERPILOT_EXTRACTOR_MAX_BODY_BYTES);
  const pageLimit = Number(extractor.PAPERPILOT_EXTRACTOR_MAX_PAGES);
  const issues = [];
  if (!Number.isSafeInteger(uploadBytes) || uploadBytes <= 0) issues.push("web PDF-byte limit is missing or invalid");
  if (validatorBytes !== uploadBytes) issues.push("validator PDF-byte limit does not match the web upload limit");
  if (extractorBytes !== uploadBytes) issues.push("extractor PDF-byte limit does not match the web upload limit");
  if (!Number.isSafeInteger(pageLimit) || pageLimit <= 0 || pageLimit > 2_000) {
    issues.push("extractor page limit is missing, invalid, or exceeds 2,000");
  }
  return issues;
}

export function inspectComposeConfiguration(configuration, expectations) {
  const issues = [];
  if (!plainObject(configuration) || !plainObject(configuration.services)) {
    return Object.freeze({ ok: false, issues: ["Compose JSON has no services object."], facts: {} });
  }
  const services = configuration.services;
  if (Object.hasOwn(services, "postgres")) {
    issues.push("self-hosted postgres service is forbidden by the Supabase-only deployment contract");
  }
  const missingServices = [];
  for (const name of REQUIRED_RUNTIME_SERVICES) {
    if (!plainObject(services[name])) {
      missingServices.push(name);
      issues.push(`required service ${name} is missing`);
    }
  }
  if (missingServices.length > 0) {
    return Object.freeze({ ok: false, issues, facts: {} });
  }

  for (const name of WORKER_SERVICES) {
    if (services[name].restart !== "unless-stopped") {
      issues.push(`${name} must use restart: unless-stopped`);
    }
  }
  for (const name of CONFIG_HEALTHCHECKED_SERVICES) {
    if (!healthcheckEnabled(services[name])) issues.push(`${name} has no enabled healthcheck`);
  }
  for (const name of ["caddy", "clamav"]) {
    if (!immutableImageReference(services[name])) {
      issues.push(`${name} must use an immutable sha256 image reference`);
    }
  }
  for (const name of ["web", "validator", "extractor"]) {
    if (!immutableNodeBuildBase(services[name])) {
      issues.push(`${name} build must pin NODE_IMAGE by sha256`);
    }
  }

  const caddyPorts = publishedPorts(services.caddy);
  const caddyPortContract = caddyPorts.map(
    (port) => `${port.published}:${port.target}/${port.protocol}`,
  );
  if (
    caddyPorts.length !== 3
    || !exactStringSet(caddyPortContract, ["80:80/tcp", "443:443/tcp", "443:443/udp"])
  ) {
    issues.push("caddy must publish exactly 80/tcp and 443/tcp+udp");
  }
  for (const [name, service] of Object.entries(services)) {
    if (name !== "caddy" && publishedPorts(service).length > 0) {
      issues.push(`${name} publishes a host port; only caddy may publish ports`);
    }
  }

  if (!plainObject(configuration.networks)) {
    issues.push("Compose JSON has no networks object");
  } else {
    if (Object.hasOwn(configuration.networks, "database")) {
      issues.push("retired internal database network must not be declared");
    }
    for (const name of REQUIRED_INTERNAL_NETWORKS) {
      if (!plainObject(configuration.networks[name]) || configuration.networks[name].internal !== true) {
        issues.push(`${name} must be an internal network`);
      }
    }
    for (const name of REQUIRED_EGRESS_NETWORKS) {
      if (!plainObject(configuration.networks[name]) || configuration.networks[name].internal === true) {
        issues.push(`${name} must be a declared non-internal network`);
      }
    }
  }
  if (plainObject(configuration.volumes)) {
    for (const name of FORBIDDEN_SELF_HOSTED_DATABASE_VOLUMES) {
      if (Object.hasOwn(configuration.volumes, name)) {
        issues.push(`retired self-hosted database volume ${name} must not be declared`);
      }
    }
  }
  for (const [serviceName, expectedNetworks] of Object.entries(SERVICE_NETWORK_CONTRACT)) {
    if (!exactStringSet(serviceNetworkNames(services[serviceName]), expectedNetworks)) {
      issues.push(`${serviceName} network membership differs from the private topology contract`);
    }
  }

  const sharedMounts = ["web", ...WORKER_SERVICES].map((name) => namedVolumeMounts(services[name]));
  const commonSources = sharedMounts[0]
    .map((mount) => mount.source)
    .filter((source) => sharedMounts.every((mounts) => mounts.some(
      (mount) => mount.source === source && mount.target === "/private/paperpilot",
    )));
  if (commonSources.length === 0) {
    issues.push("web and both workers do not share a named private document volume");
  }

  const webEnvironment = serviceEnvironment(services.web);
  if (webEnvironment.NODE_ENV !== "production") issues.push("web NODE_ENV is not production");
  if (webEnvironment.BETTER_AUTH_URL !== expectations.publicOrigin) {
    issues.push("web BETTER_AUTH_URL does not equal the configured public origin");
  }
  if (webEnvironment.PAPERPILOT_RELEASE_ID !== expectations.releaseId) {
    issues.push("web PAPERPILOT_RELEASE_ID does not equal the preflight release ID");
  }
  if (webEnvironment.PAPERPILOT_ALLOW_INSECURE_ORIGIN === "true") {
    issues.push("web permits an insecure origin");
  }
  if (!strongSecret(webEnvironment.BETTER_AUTH_SECRET)) {
    issues.push("web BETTER_AUTH_SECRET is missing, weak, or a placeholder");
  }
  const supabaseDatabaseIssues = configuredSupabaseDatabaseIssues(services);
  issues.push(...supabaseDatabaseIssues);

  const readinessContracts = [
    {
      service: "validation-worker",
      endpoint: "PAPERPILOT_VALIDATION_SERVICE_ENDPOINT",
      readiness: "PAPERPILOT_VALIDATION_SERVICE_READINESS_ENDPOINT",
      secret: "PAPERPILOT_VALIDATION_SERVICE_BEARER_SECRET",
      workerId: "PAPERPILOT_VALIDATION_WORKER_ID",
      expectedWorkerId: "paperpilot-validation-1",
      expectedKind: "validation",
    },
    {
      service: "extraction-worker",
      endpoint: "PAPERPILOT_EXTRACTION_SERVICE_ENDPOINT",
      readiness: "PAPERPILOT_EXTRACTION_SERVICE_READINESS_ENDPOINT",
      secret: "PAPERPILOT_EXTRACTION_SERVICE_BEARER_SECRET",
      workerId: "PAPERPILOT_EXTRACTION_WORKER_ID",
      expectedWorkerId: "paperpilot-extraction-1",
      expectedKind: "extraction",
    },
  ];
  for (const contract of readinessContracts) {
    const environment = serviceEnvironment(services[contract.service]);
    const endpoint = canonicalPrivateHttpsEndpoint(environment[contract.endpoint]);
    const readiness = canonicalPrivateHttpsEndpoint(environment[contract.readiness]);
    if (!endpoint) issues.push(`${contract.service} private service endpoint is not canonical HTTPS`);
    if (!readiness) issues.push(`${contract.service} private readiness endpoint is not canonical HTTPS`);
    if (endpoint && readiness && new URL(endpoint).origin !== new URL(readiness).origin) {
      issues.push(`${contract.service} service and readiness endpoints do not share an origin`);
    }
    if (!strongSecret(environment[contract.secret])) {
      issues.push(`${contract.service} bearer secret is missing, weak, or a placeholder`);
    }
    if (environment[contract.workerId] !== contract.expectedWorkerId) {
      issues.push(`${contract.service} does not use the expected stable worker ID`);
    }
    const labels = serviceLabels(services[contract.service]);
    if (
      labels["io.paperpilot.role"] !== "worker"
      || labels["io.paperpilot.worker.kind"] !== contract.expectedKind
    ) {
      issues.push(`${contract.service} supervision labels are missing or incorrect`);
    }
  }

  issues.push(...configuredLimitIssues(services));
  return Object.freeze({
    ok: issues.length === 0,
    issues,
    facts: Object.freeze({
      requiredServiceCount: REQUIRED_RUNTIME_SERVICES.length,
      configuredSharedVolume: commonSources.length > 0,
      configuredSharedVolumeBehaviorProven: false,
      configuredSupabaseDatabaseContract: supabaseDatabaseIssues.length === 0,
    }),
  });
}

export function parseComposePsOutput(output) {
  const text = String(output ?? "").trim();
  if (text === "") return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  }
}

function runtimeRowService(row) {
  return String(row?.Service ?? row?.service ?? "");
}

function runtimeRowState(row) {
  return String(row?.State ?? row?.state ?? "").toLocaleLowerCase();
}

function runtimeRowHealth(row) {
  return String(row?.Health ?? row?.health ?? "").toLocaleLowerCase();
}

export function inspectComposeRuntime(rows) {
  const issues = [];
  if (rows.some((row) => runtimeRowService(row) === "postgres")) {
    issues.push("a retired self-hosted postgres runtime container is still present");
  }
  for (const service of REQUIRED_RUNTIME_SERVICES) {
    const matches = rows.filter((row) => runtimeRowService(row) === service);
    if (matches.length !== 1) {
      issues.push(`${service} has ${matches.length} runtime containers; expected exactly one`);
      continue;
    }
    const row = matches[0];
    if (runtimeRowState(row) !== "running") issues.push(`${service} is not running`);
    if (RUNTIME_HEALTHCHECKED_SERVICES.includes(service) && runtimeRowHealth(row) !== "healthy") {
      issues.push(`${service} is not healthy`);
    }
  }
  for (const service of REQUIRED_COMPLETED_SERVICES) {
    const matches = rows.filter((row) => runtimeRowService(row) === service);
    if (matches.length !== 1) {
      issues.push(`${service} has ${matches.length} runtime containers; expected one completed container`);
      continue;
    }
    const row = matches[0];
    const exitCode = Number(row?.ExitCode ?? row?.exitCode);
    if (runtimeRowState(row) !== "exited" || exitCode !== 0) {
      issues.push(`${service} did not complete successfully`);
    }
  }
  for (const row of rows) {
    if (runtimeRowService(row) === "caddy") continue;
    const publishers = Array.isArray(row?.Publishers) ? row.Publishers : [];
    if (publishers.some((publisher) => Number(publisher?.PublishedPort) > 0)) {
      issues.push(`${runtimeRowService(row) || "an unnamed service"} has a published runtime port`);
    }
  }
  return Object.freeze({ ok: issues.length === 0, issues });
}

function exactJsonStatus(bodyText, expectedStatus) {
  try {
    const body = JSON.parse(bodyText);
    return plainObject(body)
      && Object.keys(body).length === 1
      && body.status === expectedStatus;
  } catch {
    return false;
  }
}

export function inspectHealthObservation(observation, expectedUrl, expectedStatus) {
  const issues = [];
  if (!plainObject(observation)) return Object.freeze({ ok: false, issues: ["health observation is missing"] });
  if (observation.status !== 200) issues.push(`HTTP status is ${observation.status}, expected 200`);
  if (observation.redirected === true || observation.finalUrl !== expectedUrl) issues.push("health request redirected or changed URL");
  if (!String(observation.contentType ?? "").toLocaleLowerCase().startsWith("application/json")) {
    issues.push("health response is not JSON");
  }
  if (!String(observation.cacheControl ?? "").toLocaleLowerCase().includes("no-store")) {
    issues.push("health response is cacheable");
  }
  if (String(observation.nosniff ?? "").toLocaleLowerCase() !== "nosniff") {
    issues.push("health response lacks nosniff");
  }
  if (!exactJsonStatus(String(observation.bodyText ?? ""), expectedStatus)) {
    issues.push(`health body is not the exact ${expectedStatus} contract`);
  }
  return Object.freeze({ ok: issues.length === 0, issues });
}

export function inspectPrivateReadinessObservation(observation, serviceKind) {
  const issues = [];
  if (!plainObject(observation) || observation.serviceKind !== serviceKind) {
    return Object.freeze({ ok: false, issues: ["private readiness observation is missing or mislabeled"] });
  }
  const authenticated = observation.authenticated;
  const anonymous = observation.anonymous;
  if (!plainObject(authenticated) || !plainObject(anonymous)) {
    return Object.freeze({ ok: false, issues: ["private readiness result is incomplete"] });
  }
  if (authenticated.redirected === true) issues.push("authenticated readiness redirected");
  if (authenticated.urlMatches !== true) issues.push("authenticated readiness changed endpoint");
  if (![200, 204].includes(authenticated.status)) issues.push("authenticated readiness did not return 200/204");
  if (anonymous.urlMatches !== true) issues.push("anonymous readiness changed endpoint");
  if (![401, 403].includes(anonymous.status)) issues.push("anonymous readiness was not denied");
  if (serviceKind === "extraction") {
    if (observation.identityMatches !== true) issues.push("extractor readiness identity does not match the worker's pinned policy/toolchain");
    if (authenticated.status !== 200 || authenticated.contentType !== "application/json") {
      issues.push("extractor readiness lacks its exact JSON response boundary");
    } else {
      try {
        const body = JSON.parse(authenticated.bodyText);
        const keys = ["schemaVersion", "status", "policyVersion", "toolchainDigest", "engine", "engineVersion"];
        if (
          !plainObject(body)
          || Object.keys(body).length !== keys.length
          || !keys.every((key) => Object.hasOwn(body, key))
          || body.schemaVersion !== 1
          || body.status !== "ready"
          || body.engine !== "poppler"
          || typeof body.engineVersion !== "string"
          || typeof body.policyVersion !== "string"
          || !SHA256_PATTERN.test(String(body.toolchainDigest ?? ""))
        ) issues.push("extractor readiness identity is malformed");
      } catch {
        issues.push("extractor readiness body is not valid JSON");
      }
    }
  }
  return Object.freeze({ ok: issues.length === 0, issues });
}

function parseJsonOutput(commandResult) {
  if (commandResult?.status !== 0 || typeof commandResult.stdout !== "string") return null;
  try {
    return JSON.parse(commandResult.stdout.trim());
  } catch {
    return null;
  }
}

function defaultCommandRunner(command, arguments_, options) {
  return spawnSync(command, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.environment,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    timeout: options.timeoutMs,
    windowsHide: true,
  });
}

async function fetchHealthObservation(fetchImpl, requestedUrl, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(requestedUrl, {
      method: "GET",
      headers: { Accept: "application/json", "Cache-Control": "no-store" },
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_HEALTH_BODY_BYTES) return null;
    return {
      requestedUrl,
      finalUrl: response.url,
      redirected: response.redirected,
      status: response.status,
      contentType: response.headers.get("content-type"),
      cacheControl: response.headers.get("cache-control"),
      nosniff: response.headers.get("x-content-type-options"),
      bodyText: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    return null;
  }
}

function readBoundedJson(path, maximumBytes) {
  try {
    const metadata = statSync(path);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maximumBytes) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function meaningfulRecordedValue(value) {
  if (typeof value === "string") return value.trim() !== "" && !PLACEHOLDER_PATTERN.test(value);
  if (!plainObject(value) || Object.keys(value).length === 0) return false;
  return Object.values(value).every((entry) => (
    typeof entry === "string" ? meaningfulRecordedValue(entry) : entry !== null && entry !== undefined
  ));
}

function gateStatus(value) {
  if (typeof value === "string") return value.toLocaleLowerCase();
  if (plainObject(value) && typeof value.status === "string") return value.status.toLocaleLowerCase();
  if (value === true) return "pass";
  if (value === false) return "fail";
  return "invalid";
}

export function inspectReleaseMetadata(metadata, expectations) {
  const issues = [];
  if (!plainObject(metadata)) return Object.freeze({ ok: false, issues: ["release metadata is not an object"] });
  if (metadata.schemaVersion !== 1) issues.push("schemaVersion must be 1");
  if (metadata.releaseId !== expectations.releaseId) issues.push("releaseId does not match preflight");
  if (metadata.publicUrl !== expectations.publicOrigin) issues.push("publicUrl does not match preflight");
  if (metadata.commit !== expectations.commit || !COMMIT_PATTERN.test(String(metadata.commit ?? ""))) {
    issues.push("commit is missing or does not match HEAD");
  }
  if (
    typeof metadata.testedAt !== "string"
    || !metadata.testedAt.endsWith("Z")
    || Number.isNaN(Date.parse(metadata.testedAt))
  ) issues.push("testedAt is not a valid UTC timestamp");
  if (!meaningfulRecordedValue(metadata.textClientTuple)) issues.push("textClientTuple is missing or placeholder");
  if (!meaningfulRecordedValue(metadata.visualClientTuple)) issues.push("visualClientTuple is missing or placeholder");
  if (!["chatgpt_behavioral_ab", "devtools_screenshot_trace"].includes(metadata.visualEvidenceMode)) {
    issues.push("visualEvidenceMode is missing or unsupported");
  }
  if (!plainObject(metadata.configuredLimits) || Object.keys(metadata.configuredLimits).length === 0) {
    issues.push("configuredLimits is missing");
  }
  if (!SHA256_PATTERN.test(String(metadata.sealedAbGroundTruthDigest ?? ""))) {
    issues.push("sealedAbGroundTruthDigest is missing or invalid");
  }
  if (!plainObject(metadata.gates) || Object.keys(metadata.gates).length === 0) {
    issues.push("gates is missing");
  } else {
    const nonPassing = Object.entries(metadata.gates)
      .filter(([, value]) => gateStatus(value) !== "pass")
      .map(([name]) => name);
    if (nonPassing.length > 0) issues.push(`recorded gates are not passing: ${nonPassing.join(", ")}`);
  }
  return Object.freeze({
    ok: issues.length === 0,
    issues,
    recordedOnly: Object.freeze([
      "native WebMCP client behavior",
      "visual A/B behavior",
      "keyboard/NVDA behavior",
    ]),
  });
}

function optionsFrom(parsed, environment, repositoryRoot) {
  const publicOrigin = canonicalPublicHttpsOrigin(
    parsed.publicOrigin || environment.PAPERPILOT_PUBLIC_ORIGIN || "",
  );
  const releaseId = (parsed.releaseId || environment.PAPERPILOT_RELEASE_ID || "").trim();
  const effectiveEnvironment = { ...environment };
  if (publicOrigin) effectiveEnvironment.PAPERPILOT_PUBLIC_ORIGIN = publicOrigin;
  if (releaseId) effectiveEnvironment.PAPERPILOT_RELEASE_ID = releaseId;
  const composeFile = resolve(repositoryRoot, parsed.composeFile);
  const releaseManifest = resolve(
    repositoryRoot,
    parsed.releaseManifest || `demo-preflight/${releaseId || "missing-release-id"}/release.json`,
  );
  return Object.freeze({
    phase: parsed.phase,
    composeFile,
    environment: effectiveEnvironment,
    publicOrigin,
    releaseId,
    releaseManifest,
    repositoryRoot,
    timeoutMs: parsed.timeoutMs,
  });
}

function commandSucceeded(commandResult) {
  return commandResult?.status === 0 && typeof commandResult.stdout === "string";
}

function formatIssues(issues) {
  return issues.slice(0, 6).join("; ");
}

export function dockerComposeArguments(composeFile, arguments_) {
  return [
    "compose",
    "--project-directory",
    dirname(composeFile),
    "-f",
    composeFile,
    ...arguments_,
  ];
}

export async function runDemoPreflight(options, dependencies = {}) {
  const results = [];
  const commandRunner = dependencies.commandRunner ?? defaultCommandRunner;
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const run = (command, arguments_) => commandRunner(command, arguments_, {
    cwd: options.repositoryRoot,
    environment: options.environment,
    timeoutMs: Math.max(options.timeoutMs, 15_000),
  });
  const compose = (arguments_) => run(
    "docker",
    dockerComposeArguments(options.composeFile, arguments_),
  );

  const gitRootResult = run("git", ["rev-parse", "--show-toplevel"]);
  const gitRoot = commandSucceeded(gitRootResult) ? gitRootResult.stdout.trim() : "";
  results.push(
    gitRoot && samePath(gitRoot, options.repositoryRoot)
      ? pass("repository.boundary", "PaperPilot is an isolated Git repository root.")
      : fail("repository.boundary", "The repository boundary could not be proven.", "Run from the isolated PaperPilot Git root; do not deploy from an enclosing worktree."),
  );

  const missingFiles = REQUIRED_DEPLOYMENT_FILES.filter((path) => !existsSync(resolve(options.repositoryRoot, path)));
  results.push(
    missingFiles.length === 0
      ? pass("deployment.files", "Required deployment, health-route, and environment-contract files exist.")
      : fail("deployment.files", `Required files are missing: ${missingFiles.join(", ")}.`, "Finish the Gate 0 deployment skeleton before rerunning preflight."),
  );

  if (!options.publicOrigin) {
    results.push(fail("release.public_origin", "No canonical public HTTPS origin is configured.", "Set PAPERPILOT_PUBLIC_ORIGIN to the deployed root HTTPS origin or pass --public-origin."));
  } else {
    results.push(pass("release.public_origin", "A non-placeholder public HTTPS origin is configured."));
  }
  if (!RELEASE_ID_PATTERN.test(options.releaseId) || PLACEHOLDER_PATTERN.test(options.releaseId)) {
    results.push(fail("release.id", "PAPERPILOT_RELEASE_ID is missing, invalid, or a placeholder.", "Set a stable Gate 0 or release identifier (1-128 safe characters)."));
  } else {
    results.push(pass("release.id", "A bounded non-placeholder release identifier is configured."));
  }

  let composeConfiguration = null;
  if (!existsSync(options.composeFile)) {
    results.push(blocked("compose.configuration", "Compose configuration is blocked because the file is missing."));
  } else {
    const composeConfigurationResult = compose(["config", "--format", "json"]);
    if (!commandSucceeded(composeConfigurationResult)) {
      results.push(fail("compose.configuration", "Docker Compose could not render the deployment configuration.", "Install Docker Compose v2, provide all required environment values, and run docker compose config directly for details."));
    } else {
      try {
        composeConfiguration = JSON.parse(composeConfigurationResult.stdout);
      } catch {
        results.push(fail("compose.configuration", "Docker Compose did not return parseable JSON.", "Use a current Docker Compose v2 release that supports config --format json."));
      }
      if (composeConfiguration) {
        const inspection = inspectComposeConfiguration(composeConfiguration, {
          publicOrigin: options.publicOrigin,
          releaseId: options.releaseId,
        });
        results.push(
          inspection.ok
            ? pass("compose.configuration", "Compose declares the exact Supabase runtime profile and CA mounts, database egress, required private topology, supervised workers, health checks, aligned PDF limits, and Caddy-only public ports.")
            : fail("compose.configuration", `Compose contract failed: ${formatIssues(inspection.issues)}.`, "Correct the deployment configuration; path or volume-name equality alone is not operational proof."),
        );
        if (inspection.facts.configuredSharedVolume) {
          results.push(pass("storage.topology", "A common named private document volume is configured for web and both workers (configuration only)."));
        }
      }
    }
  }

  if (composeConfiguration) {
    const runtimeResult = compose(["ps", "--all", "--format", "json"]);
    if (!commandSucceeded(runtimeResult)) {
      results.push(fail("compose.runtime", "The local Compose runtime could not be inspected.", "Run this phase on the deployed host with the Gate 0 stack started."));
    } else {
      try {
        const runtimeInspection = inspectComposeRuntime(parseComposePsOutput(runtimeResult.stdout));
        results.push(
          runtimeInspection.ok
            ? pass("compose.runtime", "All required runtime services are running; healthchecked services are healthy; only Caddy publishes ports.")
            : fail("compose.runtime", `Compose runtime failed: ${formatIssues(runtimeInspection.issues)}.`, "Restore the named service and health states before preflight."),
        );
      } catch {
        results.push(fail("compose.runtime", "Compose runtime output was not parseable.", "Use a current Docker Compose v2 release that supports ps --format json."));
      }
    }

    const localProbeResult = compose(["exec", "-T", "web", "node", "--input-type=module", "-e", LOCAL_WEB_PROBE_SOURCE]);
    const localObservations = parseJsonOutput(localProbeResult);
    if (!Array.isArray(localObservations) || localObservations.length !== 2) {
      results.push(fail("health.local_web", "The web container's local health endpoints could not be observed.", "Ensure the web service is running Node and exposes /livez and /readyz on port 3000."));
    } else {
      const live = inspectHealthObservation(localObservations[0], "http://127.0.0.1:3000/livez", "live");
      const ready = inspectHealthObservation(localObservations[1], "http://127.0.0.1:3000/readyz", "ready");
      results.push(
        live.ok && ready.ok
          ? pass("health.local_web", "The in-container web liveness and database-backed readiness contracts are exact and healthy.")
          : fail("health.local_web", `Local web health failed: ${formatIssues([...live.issues, ...ready.issues])}.`, "Repair web/database readiness before testing the public edge."),
      );
    }

    for (const probe of [
      { service: "validation-worker", kind: "validation" },
      { service: "extraction-worker", kind: "extraction" },
    ]) {
      const environment = { ...options.environment, PAPERPILOT_PREFLIGHT_SERVICE_KIND: probe.kind };
      const probeResult = commandRunner("docker", dockerComposeArguments(options.composeFile, [
        "exec",
        "-T",
        "-e",
        `PAPERPILOT_PREFLIGHT_SERVICE_KIND=${probe.kind}`,
        probe.service,
        "node",
        "--input-type=module",
        "-e",
        PRIVATE_READINESS_PROBE_SOURCE,
      ]), {
        cwd: options.repositoryRoot,
        environment,
        timeoutMs: Math.max(options.timeoutMs, 15_000),
      });
      const observation = parseJsonOutput(probeResult);
      const inspection = inspectPrivateReadinessObservation(observation, probe.kind);
      results.push(
        inspection.ok
          ? pass(`health.${probe.kind}`, `${probe.kind === "validation" ? "Validation" : "Extraction"} worker reached its authenticated private readiness endpoint, and anonymous access was denied.`)
          : fail(`health.${probe.kind}`, `${probe.kind === "validation" ? "Validation" : "Extraction"} readiness failed: ${formatIssues(inspection.issues)}.`, "Repair worker-to-service TLS, bearer authentication, policy/toolchain readiness, or service health."),
      );
    }
  } else {
    results.push(blocked("compose.runtime", "Runtime inspection is blocked by Compose configuration."));
    results.push(blocked("health.local_web", "Local web health is blocked by Compose configuration."));
    results.push(blocked("health.validation", "Authenticated validator readiness is blocked by Compose configuration."));
    results.push(blocked("health.extraction", "Authenticated extractor readiness is blocked by Compose configuration."));
  }

  if (!options.publicOrigin) {
    results.push(blocked("health.public", "Public health is blocked because no public HTTPS origin is configured."));
  } else {
    const liveUrl = `${options.publicOrigin}/livez`;
    const readyUrl = `${options.publicOrigin}/readyz`;
    const [liveObservation, readyObservation] = await Promise.all([
      fetchHealthObservation(fetchImpl, liveUrl, options.timeoutMs),
      fetchHealthObservation(fetchImpl, readyUrl, options.timeoutMs),
    ]);
    const live = inspectHealthObservation(liveObservation, liveUrl, "live");
    const ready = inspectHealthObservation(readyObservation, readyUrl, "ready");
    results.push(
      live.ok && ready.ok
        ? pass("health.public", "The public HTTPS origin serves exact liveness and database-backed readiness responses without redirects.")
        : fail("health.public", `Public health failed: ${formatIssues([...live.issues, ...ready.issues])}.`, "Deploy the release at the configured HTTPS origin with a trusted certificate and healthy database migration sentinel."),
    );
  }

  const headResult = run("git", ["rev-parse", "--verify", "HEAD"]);
  const commit = commandSucceeded(headResult) ? headResult.stdout.trim().toLocaleLowerCase() : "";
  if (options.phase === "release") {
    if (!COMMIT_PATTERN.test(commit)) {
      results.push(fail("release.commit", "No immutable Git release commit can be resolved.", "Create and deploy the exact release commit before final preflight."));
    } else {
      results.push(pass("release.commit", "An immutable Git commit identifies the candidate."));
    }
    if (!pathInside(options.repositoryRoot, options.releaseManifest)) {
      results.push(fail("release.metadata", "The release manifest path is outside the repository.", "Keep release evidence under demo-preflight/<release-id>/."));
    } else {
      const metadata = readBoundedJson(options.releaseManifest, MAX_RELEASE_MANIFEST_BYTES);
      const inspection = inspectReleaseMetadata(metadata, {
        publicOrigin: options.publicOrigin,
        releaseId: options.releaseId,
        commit,
      });
      results.push(
        inspection.ok
          ? recorded("release.metadata", "Release metadata records passing client, visual, accessibility, and other gates; the script validated the record but did not perform those human/client checks.")
          : fail("release.metadata", `Release metadata failed: ${formatIssues(inspection.issues)}.`, "Complete and sanitize demo-preflight/<release-id>/release.json with real recorded evidence."),
      );
      const evidenceDirectory = dirname(options.releaseManifest);
      const missingEvidence = REQUIRED_RELEASE_EVIDENCE_FILES.filter((name) => {
        try {
          const metadata_ = statSync(resolve(evidenceDirectory, name));
          return !metadata_.isFile() || metadata_.size <= 0;
        } catch {
          return true;
        }
      });
      results.push(
        missingEvidence.length === 0
          ? recorded("release.evidence_files", "Every required evidence filename exists and is nonempty; content validity remains a human review gate.")
          : fail("release.evidence_files", `Required evidence files are missing or empty: ${missingEvidence.join(", ")}.`, "Record the real release flows; do not generate placeholder evidence."),
      );
    }
  } else {
    results.push(notChecked("release.commit", "An immutable final release commit is not required by the infrastructure phase."));
    results.push(notChecked("release.metadata", "Named-client and accessibility evidence metadata is not evaluated in the infrastructure phase."));
  }

  results.push(notChecked(
    "manual.public_upload",
    "A fresh authenticated public-origin upload, admitted-byte binding, first-page render, and shared-volume behavior require the checklist's recorded user flow; this script does not claim them.",
  ));
  results.push(notChecked(
    "manual.native_client",
    "ChatGPT desktop registration, autonomous read/stage, visual A/B pixel use, and hidden model behavior are never performed or inferred by this script.",
  ));
  results.push(notChecked(
    "manual.accessibility",
    "Keyboard and NVDA walkthroughs remain human-observed release gates; metadata or files do not make the script a screen-reader operator.",
  ));

  const failures = results.filter((entry) => entry.status === "fail");
  return Object.freeze({
    schemaVersion: 1,
    phase: options.phase,
    ok: failures.length === 0,
    results: Object.freeze(results),
    summary: Object.freeze({
      passed: results.filter((entry) => entry.status === "pass").length,
      failed: failures.length,
      blocked: results.filter((entry) => entry.status === "blocked").length,
      recorded: results.filter((entry) => entry.status === "recorded").length,
      notChecked: results.filter((entry) => entry.status === "not_checked").length,
    }),
  });
}

function usage() {
  return `Usage: npm run demo:preflight -- [options]

Options:
  --phase infrastructure|release   Machine infrastructure checks or final recorded-evidence checks (default: release)
  --compose-file <path>            Compose file (default: deploy/app/compose.yaml)
  --env-file <path>                Dotenv file to load without overriding shell values (default: deploy/app/.env)
  --public-origin <https-origin>   Public deployed root origin (or PAPERPILOT_PUBLIC_ORIGIN)
  --release-id <id>                Release identifier (or PAPERPILOT_RELEASE_ID)
  --release-manifest <path>        Final release.json path
  --timeout-ms <500..30000>        HTTP/command probe timeout (default: 8000)
  --json                           Emit the bounded machine report as JSON
  --help                           Show this help

The infrastructure phase never claims a public upload, shared-volume behavior, native WebMCP invocation, visual pixel use, or NVDA pass. Those require separately recorded human/client evidence.`;
}

function printReport(report) {
  process.stdout.write(`PaperPilot demo preflight — ${report.phase} phase\n`);
  for (const entry of report.results) {
    const label = entry.status.replaceAll("_", " ").toLocaleUpperCase();
    process.stdout.write(`${label.padEnd(11)} ${entry.id}: ${entry.summary}\n`);
    if (entry.remediation) process.stdout.write(`            Remediation: ${entry.remediation}\n`);
  }
  process.stdout.write(
    `Summary: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.blocked} blocked, ${report.summary.recorded} recorded-only, ${report.summary.notChecked} not checked.\n`,
  );
  process.stdout.write(
    report.ok
      ? "Machine preflight is green within the stated claim boundary. Manual/client gates remain separate.\n"
      : "Machine preflight is red. No public-deployment or native-client pass is implied.\n",
  );
}

async function main() {
  let parsed;
  try {
    parsed = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Invalid arguments."}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const repositoryRoot = resolve(process.cwd());
  const environment = { ...process.env };
  const envPath = resolve(repositoryRoot, parsed.envFile);
  if (existsSync(envPath)) {
    const loaded = loadDotenv({ path: envPath, processEnv: environment, override: false, quiet: true });
    if (loaded.error) {
      process.stderr.write("The selected environment file could not be parsed.\n");
      process.exitCode = 2;
      return;
    }
  }
  const options = optionsFrom(parsed, environment, repositoryRoot);
  const report = await runDemoPreflight(options);
  if (parsed.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printReport(report);
  process.exitCode = report.ok ? 0 : 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && samePath(fileURLToPath(import.meta.url), invokedPath)) {
  await main();
}
