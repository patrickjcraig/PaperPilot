import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";

import {
  canonicalPublicHttpsOrigin,
  dockerComposeArguments,
  inspectComposeConfiguration,
  inspectComposeRuntime,
  inspectHealthObservation,
  inspectPrivateReadinessObservation,
  inspectReleaseMetadata,
  parseArguments,
  parseComposePsOutput,
} from "./demo-preflight.mjs";

const PUBLIC_ORIGIN = "https://paperpilot.research.tools";
const RELEASE_ID = "gate0-20260829";
const STRONG_SECRET = "0123456789abcdefABCDEFghijklmnop0123456789abcdefABCDEFghijklmnop";
const DIGEST = "a".repeat(64);
const DATABASE_PROFILE = "supabase-avmcmmayvnjxrhrmgsdx-direct-v1";
const DATABASE_HOST = "db.avmcmmayvnjxrhrmgsdx.supabase.co";
const DATABASE_CA_PATH = "/etc/paperpilot/supabase/database-ca.pem";
const DATABASE_URL = `postgresql://paperpilot_runtime:${STRONG_SECRET}@${DATABASE_HOST}:5432/postgres?sslmode=verify-full`;

function healthcheck() {
  return { test: ["CMD", "true"], interval: "5s", timeout: "2s", retries: 5 };
}

function volume() {
  return [
    { type: "volume", source: "paperpilot-private-documents", target: "/private/paperpilot" },
    {
      type: "bind",
      source: "/host/secrets/supabase-database-ca.pem",
      target: DATABASE_CA_PATH,
      read_only: true,
    },
  ];
}

function databaseEnvironment() {
  return {
    DATABASE_URL,
    PAPERPILOT_ALLOW_LOCAL_PRISMA_DEV: "0",
    PAPERPILOT_DATABASE_CA_CERT_PATH: DATABASE_CA_PATH,
    PAPERPILOT_DATABASE_PROFILE: DATABASE_PROFILE,
  };
}

function validComposeConfiguration() {
  return {
    services: {
      caddy: {
        image: `caddy@sha256:${"c".repeat(64)}`,
        healthcheck: healthcheck(),
        ports: [
          { target: 80, published: "80", protocol: "tcp" },
          { target: 443, published: "443", protocol: "tcp" },
          { target: 443, published: "443", protocol: "udp" },
        ],
        networks: { app: {}, edge: {}, extraction: {}, validation: {} },
      },
      web: {
        build: { args: { NODE_IMAGE: `node@sha256:${"f".repeat(64)}` } },
        healthcheck: healthcheck(),
        environment: {
          ...databaseEnvironment(),
          NODE_ENV: "production",
          BETTER_AUTH_URL: PUBLIC_ORIGIN,
          BETTER_AUTH_SECRET: STRONG_SECRET,
          PAPERPILOT_RELEASE_ID: RELEASE_ID,
          PAPERPILOT_ALLOW_INSECURE_ORIGIN: "false",
          PAPERPILOT_UPLOAD_MAX_BYTES: "26214400",
        },
        volumes: volume(),
        networks: { app: {}, database_egress: {}, web_egress: {} },
      },
      validator: {
        build: { args: { NODE_IMAGE: `node@sha256:${"1".repeat(64)}` } },
        healthcheck: healthcheck(),
        environment: { PAPERPILOT_VALIDATOR_MAX_BODY_BYTES: "26214400" },
        networks: { scan: {}, validation: {} },
      },
      clamav: {
        image: `clamav@sha256:${"e".repeat(64)}`,
        healthcheck: healthcheck(),
        networks: { scan: {}, signature_updates: {} },
      },
      "validation-worker": {
        restart: "unless-stopped",
        labels: {
          "io.paperpilot.role": "worker",
          "io.paperpilot.worker.kind": "validation",
        },
        environment: {
          ...databaseEnvironment(),
          PAPERPILOT_VALIDATION_SERVICE_ENDPOINT: "https://validator.paperpilot.internal:8443/v1/validate-pdf",
          PAPERPILOT_VALIDATION_SERVICE_READINESS_ENDPOINT: "https://validator.paperpilot.internal:8443/readyz",
          PAPERPILOT_VALIDATION_SERVICE_BEARER_SECRET: STRONG_SECRET,
          PAPERPILOT_VALIDATION_WORKER_ID: "paperpilot-validation-1",
        },
        volumes: volume(),
        networks: { database_egress: {}, validation: {} },
      },
      extractor: {
        build: { args: { NODE_IMAGE: `node@sha256:${"2".repeat(64)}` } },
        healthcheck: healthcheck(),
        environment: {
          PAPERPILOT_EXTRACTOR_MAX_BODY_BYTES: "26214400",
          PAPERPILOT_EXTRACTOR_MAX_PAGES: "2000",
        },
        networks: { extraction: {} },
      },
      "extraction-worker": {
        restart: "unless-stopped",
        labels: {
          "io.paperpilot.role": "worker",
          "io.paperpilot.worker.kind": "extraction",
        },
        environment: {
          ...databaseEnvironment(),
          PAPERPILOT_EXTRACTION_SERVICE_ENDPOINT: "https://extractor.paperpilot.internal:8443/v1/extract-pdf",
          PAPERPILOT_EXTRACTION_SERVICE_READINESS_ENDPOINT: "https://extractor.paperpilot.internal:8443/readyz",
          PAPERPILOT_EXTRACTION_SERVICE_BEARER_SECRET: STRONG_SECRET,
          PAPERPILOT_EXTRACTION_WORKER_ID: "paperpilot-extraction-1",
        },
        volumes: volume(),
        networks: { database_egress: {}, extraction: {} },
      },
    },
    networks: {
      app: { internal: true },
      validation: { internal: true },
      extraction: { internal: true },
      scan: { internal: true },
      edge: { internal: false },
      database_egress: { internal: false },
      web_egress: { internal: false },
      signature_updates: { internal: false },
    },
    volumes: {
      "paperpilot-private-documents": {},
    },
  };
}

test("public origin validation rejects local, placeholder, credentialed, and path-scoped URLs", () => {
  assert.equal(canonicalPublicHttpsOrigin(PUBLIC_ORIGIN), PUBLIC_ORIGIN);
  for (const value of [
    "http://paperpilot.research.tools",
    "https://localhost",
    "https://[::1]",
    "https://paperpilot.example.com",
    "https://user:password@paperpilot.research.tools",
    "https://paperpilot.research.tools/app",
    "https://paperpilot.research.tools?source=private",
  ]) assert.equal(canonicalPublicHttpsOrigin(value), null, value);
});

test("CLI phases are closed and infrastructure is explicit", () => {
  assert.equal(parseArguments(["--phase", "infrastructure"]).phase, "infrastructure");
  assert.equal(parseArguments([]).phase, "release");
  assert.throws(() => parseArguments(["--phase", "native"]), /infrastructure or release/u);
  assert.throws(() => parseArguments(["--skip-public"]), /Unknown option/u);
});

test("Compose resolves build contexts and bind mounts from the compose file directory", () => {
  const composeFile = resolve("deploy/app/compose.yaml");
  assert.deepEqual(dockerComposeArguments(composeFile, ["config", "--format", "json"]), [
    "compose",
    "--project-directory",
    dirname(composeFile),
    "-f",
    composeFile,
    "config",
    "--format",
    "json",
  ]);
});

test("Compose configuration proves only the declared Supabase topology and supervision contract", () => {
  const valid = inspectComposeConfiguration(validComposeConfiguration(), {
    publicOrigin: PUBLIC_ORIGIN,
    releaseId: RELEASE_ID,
  });
  assert.equal(valid.ok, true, valid.issues.join("; "));
  assert.equal(valid.facts.configuredSharedVolume, true);
  assert.equal(valid.facts.configuredSharedVolumeBehaviorProven, false);
  assert.equal(valid.facts.configuredSupabaseDatabaseContract, true);

  const exposed = structuredClone(validComposeConfiguration());
  exposed.services.validator.ports = [{ target: 4010, published: "4010" }];
  const exposedResult = inspectComposeConfiguration(exposed, {
    publicOrigin: PUBLIC_ORIGIN,
    releaseId: RELEASE_ID,
  });
  assert.equal(exposedResult.ok, false);
  assert.match(exposedResult.issues.join(" "), /only caddy may publish ports/u);

  const extraEdgePort = structuredClone(validComposeConfiguration());
  extraEdgePort.services.caddy.ports.push({ target: 8443, published: "8443", protocol: "tcp" });
  const extraEdgePortResult = inspectComposeConfiguration(extraEdgePort, {
    publicOrigin: PUBLIC_ORIGIN,
    releaseId: RELEASE_ID,
  });
  assert.equal(extraEdgePortResult.ok, false);
  assert.match(extraEdgePortResult.issues.join(" "), /exactly 80\/tcp and 443\/tcp\+udp/u);

  const movingInfrastructureImage = structuredClone(validComposeConfiguration());
  movingInfrastructureImage.services.clamav.image = "clamav:latest";
  const movingInfrastructureImageResult = inspectComposeConfiguration(movingInfrastructureImage, {
    publicOrigin: PUBLIC_ORIGIN,
    releaseId: RELEASE_ID,
  });
  assert.equal(movingInfrastructureImageResult.ok, false);
  assert.match(movingInfrastructureImageResult.issues.join(" "), /clamav must use an immutable/u);

  const movingBuildBase = structuredClone(validComposeConfiguration());
  movingBuildBase.services.web.build.args.NODE_IMAGE = "node:latest";
  const movingBuildBaseResult = inspectComposeConfiguration(movingBuildBase, {
    publicOrigin: PUBLIC_ORIGIN,
    releaseId: RELEASE_ID,
  });
  assert.equal(movingBuildBaseResult.ok, false);
  assert.match(movingBuildBaseResult.issues.join(" "), /web build must pin NODE_IMAGE/u);

  const routedWorker = structuredClone(validComposeConfiguration());
  routedWorker.networks.validation.internal = false;
  routedWorker.services["validation-worker"].networks.web_egress = {};
  const routedWorkerResult = inspectComposeConfiguration(routedWorker, {
    publicOrigin: PUBLIC_ORIGIN,
    releaseId: RELEASE_ID,
  });
  assert.equal(routedWorkerResult.ok, false);
  assert.match(routedWorkerResult.issues.join(" "), /validation must be an internal network/u);
  assert.match(routedWorkerResult.issues.join(" "), /validation-worker network membership/u);

  const mismatchedStorage = structuredClone(validComposeConfiguration());
  mismatchedStorage.services["extraction-worker"].volumes[0].target = "/different/private/root";
  const mismatchedStorageResult = inspectComposeConfiguration(mismatchedStorage, {
    publicOrigin: PUBLIC_ORIGIN,
    releaseId: RELEASE_ID,
  });
  assert.equal(mismatchedStorageResult.ok, false);
  assert.equal(mismatchedStorageResult.facts.configuredSharedVolume, false);
  assert.match(mismatchedStorageResult.issues.join(" "), /do not share/u);

  const unsupervised = structuredClone(validComposeConfiguration());
  unsupervised.services["validation-worker"].restart = "no";
  const unsupervisedResult = inspectComposeConfiguration(unsupervised, {
    publicOrigin: PUBLIC_ORIGIN,
    releaseId: RELEASE_ID,
  });
  assert.equal(unsupervisedResult.ok, false);
  assert.match(unsupervisedResult.issues.join(" "), /restart: unless-stopped/u);
});

test("Compose rejects every retired self-hosted PostgreSQL topology primitive", () => {
  const selfHosted = structuredClone(validComposeConfiguration());
  selfHosted.services.postgres = {
    image: `postgres@sha256:${"d".repeat(64)}`,
    healthcheck: healthcheck(),
    networks: { database: {} },
  };
  selfHosted.networks.database = { internal: true };
  selfHosted.volumes.postgres_data = {};
  selfHosted.volumes.postgres_tls = {};

  const inspected = inspectComposeConfiguration(selfHosted, {
    publicOrigin: PUBLIC_ORIGIN,
    releaseId: RELEASE_ID,
  });
  const issues = inspected.issues.join(" ");
  assert.equal(inspected.ok, false);
  assert.match(issues, /self-hosted postgres service is forbidden/u);
  assert.match(issues, /internal database network must not be declared/u);
  assert.match(issues, /database volume postgres_data must not be declared/u);
  assert.match(issues, /database volume postgres_tls must not be declared/u);
});

test("Compose binds web and workers to the exact password-bearing Supabase URL without leaking it", () => {
  const invalidUrls = [
    `postgresql://paperpilot_runtime:${STRONG_SECRET}@db.otherprojectref.supabase.co:5432/postgres?sslmode=verify-full`,
    `postgresql://paperpilot_runtime:${STRONG_SECRET}@${DATABASE_HOST}:6543/postgres?sslmode=verify-full`,
    `postgresql://paperpilot_runtime:${STRONG_SECRET}@${DATABASE_HOST}:5432/paperpilot?sslmode=verify-full`,
    `postgresql://postgres:${STRONG_SECRET}@${DATABASE_HOST}:5432/postgres?sslmode=verify-full`,
    `postgresql://paperpilot_runtime:${STRONG_SECRET}@${DATABASE_HOST}:5432/postgres?sslmode=require`,
  ];
  for (const databaseUrl of invalidUrls) {
    const configured = structuredClone(validComposeConfiguration());
    configured.services.web.environment.DATABASE_URL = databaseUrl;
    const inspected = inspectComposeConfiguration(configured, {
      publicOrigin: PUBLIC_ORIGIN,
      releaseId: RELEASE_ID,
    });
    const issues = inspected.issues.join(" ");
    assert.equal(inspected.ok, false, databaseUrl);
    assert.match(issues, /web DATABASE_URL is not the approved/u);
    assert.equal(issues.includes(STRONG_SECRET), false);
    assert.equal(issues.includes(databaseUrl), false);
  }

  const wrongWorkerProfile = structuredClone(validComposeConfiguration());
  wrongWorkerProfile.services["validation-worker"].environment.PAPERPILOT_DATABASE_PROFILE = "";
  const profileInspection = inspectComposeConfiguration(wrongWorkerProfile, {
    publicOrigin: PUBLIC_ORIGIN,
    releaseId: RELEASE_ID,
  });
  assert.equal(profileInspection.ok, false);
  assert.match(
    profileInspection.issues.join(" "),
    /validation-worker does not select the exact approved Supabase database profile/u,
  );
});

test("Compose requires an exact read-only CA mount and external database egress for every database client", () => {
  const unmountedCa = structuredClone(validComposeConfiguration());
  unmountedCa.services["extraction-worker"].volumes[1].read_only = false;
  const mountInspection = inspectComposeConfiguration(unmountedCa, {
    publicOrigin: PUBLIC_ORIGIN,
    releaseId: RELEASE_ID,
  });
  assert.equal(mountInspection.ok, false);
  assert.match(
    mountInspection.issues.join(" "),
    /extraction-worker Supabase CA path is not covered by an exact read-only mount/u,
  );

  const relativeCa = structuredClone(validComposeConfiguration());
  relativeCa.services.web.environment.PAPERPILOT_DATABASE_CA_CERT_PATH = "relative/ca.pem";
  const relativeInspection = inspectComposeConfiguration(relativeCa, {
    publicOrigin: PUBLIC_ORIGIN,
    releaseId: RELEASE_ID,
  });
  assert.equal(relativeInspection.ok, false);
  assert.match(
    relativeInspection.issues.join(" "),
    /web Supabase CA path is not one canonical absolute container file path/u,
  );

  const isolatedWorker = structuredClone(validComposeConfiguration());
  delete isolatedWorker.services["validation-worker"].networks.database_egress;
  const egressInspection = inspectComposeConfiguration(isolatedWorker, {
    publicOrigin: PUBLIC_ORIGIN,
    releaseId: RELEASE_ID,
  });
  assert.equal(egressInspection.ok, false);
  assert.match(
    egressInspection.issues.join(" "),
    /validation-worker has no external Supabase database egress network/u,
  );
});

test("Compose runtime requires one running container and real health for healthchecked services", () => {
  const rows = [
    "caddy", "web", "validator", "clamav", "validation-worker", "extractor", "extraction-worker",
  ].map((Service) => ({
    Service,
    State: "running",
    Health: Service.endsWith("worker") ? "" : "healthy",
    Publishers: Service === "caddy" ? [{ PublishedPort: 443 }] : [],
  }));
  rows.push(
    { Service: "internal-ca-export", State: "exited", ExitCode: 0, Health: "", Publishers: [] },
    { Service: "storage-init", State: "exited", ExitCode: 0, Health: "", Publishers: [] },
  );
  assert.equal(inspectComposeRuntime(rows).ok, true);

  const stalePostgres = inspectComposeRuntime([
    ...rows,
    { Service: "postgres", State: "running", Health: "healthy", Publishers: [] },
  ]);
  assert.equal(stalePostgres.ok, false);
  assert.match(stalePostgres.issues.join(" "), /self-hosted postgres runtime container/u);

  rows.find((row) => row.Service === "extraction-worker").State = "exited";
  const failed = inspectComposeRuntime(rows);
  assert.equal(failed.ok, false);
  assert.match(failed.issues.join(" "), /extraction-worker is not running/u);
});

test("Compose ps parser accepts both arrays and newline-delimited JSON", () => {
  const rows = [{ Service: "web", State: "running" }, { Service: "validation-worker", State: "running" }];
  assert.deepEqual(parseComposePsOutput(JSON.stringify(rows)), rows);
  assert.deepEqual(parseComposePsOutput(rows.map((row) => JSON.stringify(row)).join("\n")), rows);
});

test("health checks require exact status bodies, non-cacheable JSON, nosniff, and no redirect", () => {
  const observation = {
    status: 200,
    redirected: false,
    finalUrl: `${PUBLIC_ORIGIN}/readyz`,
    contentType: "application/json; charset=utf-8",
    cacheControl: "no-store",
    nosniff: "nosniff",
    bodyText: JSON.stringify({ status: "ready" }),
  };
  assert.equal(inspectHealthObservation(observation, `${PUBLIC_ORIGIN}/readyz`, "ready").ok, true);
  const redirected = { ...observation, redirected: true, finalUrl: `${PUBLIC_ORIGIN}/signin` };
  assert.equal(inspectHealthObservation(redirected, `${PUBLIC_ORIGIN}/readyz`, "ready").ok, false);
  const overclaim = { ...observation, bodyText: JSON.stringify({ status: "ready", nativeWebMcp: true }) };
  assert.equal(inspectHealthObservation(overclaim, `${PUBLIC_ORIGIN}/readyz`, "ready").ok, false);
});

test("private service readiness requires authenticated success and anonymous denial", () => {
  const validation = {
    serviceKind: "validation",
    identityMatches: true,
    authenticated: { status: 204, redirected: false, urlMatches: true, contentType: null, bodyText: "" },
    anonymous: { status: 401, redirected: false, urlMatches: true, contentType: "application/json", bodyText: "" },
  };
  assert.equal(inspectPrivateReadinessObservation(validation, "validation").ok, true);
  assert.equal(inspectPrivateReadinessObservation({
    ...validation,
    anonymous: { ...validation.anonymous, status: 204 },
  }, "validation").ok, false);

  const extraction = {
    serviceKind: "extraction",
    identityMatches: true,
    authenticated: {
      status: 200,
      redirected: false,
      urlMatches: true,
      contentType: "application/json",
      bodyText: JSON.stringify({
        schemaVersion: 1,
        status: "ready",
        policyVersion: "paperpilot-text-extraction-v1",
        toolchainDigest: DIGEST,
        engine: "poppler",
        engineVersion: "26.08.0",
      }),
    },
    anonymous: { status: 403, redirected: false, urlMatches: true, contentType: "application/json", bodyText: "" },
  };
  assert.equal(inspectPrivateReadinessObservation(extraction, "extraction").ok, true);
});

test("release metadata is only a recorded-evidence contract and any red gate fails", () => {
  const commit = "b".repeat(40);
  const metadata = {
    schemaVersion: 1,
    releaseId: RELEASE_ID,
    publicUrl: PUBLIC_ORIGIN,
    commit,
    testedAt: "2026-08-29T18:00:00.000Z",
    textClientTuple: { app: "ChatGPT desktop 1.2.3", browser: "built-in browser", model: "named model" },
    visualClientTuple: { app: "ChatGPT desktop 1.2.3", browser: "built-in browser", model: "named vision model" },
    visualEvidenceMode: "chatgpt_behavioral_ab",
    configuredLimits: { pdfBytes: 26214400, pdfPages: 2000 },
    sealedAbGroundTruthDigest: DIGEST,
    gates: { infrastructure: "pass", nativeText: { status: "pass" }, nativeVisual: true, accessibility: "pass" },
  };
  const valid = inspectReleaseMetadata(metadata, { publicOrigin: PUBLIC_ORIGIN, releaseId: RELEASE_ID, commit });
  assert.equal(valid.ok, true, valid.issues.join("; "));
  assert.deepEqual(valid.recordedOnly, [
    "native WebMCP client behavior",
    "visual A/B behavior",
    "keyboard/NVDA behavior",
  ]);
  const blocked = inspectReleaseMetadata({
    ...metadata,
    gates: { ...metadata.gates, nativeVisual: "blocked" },
  }, { publicOrigin: PUBLIC_ORIGIN, releaseId: RELEASE_ID, commit });
  assert.equal(blocked.ok, false);
  assert.match(blocked.issues.join(" "), /nativeVisual/u);
});
