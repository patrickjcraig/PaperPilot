import { isIP } from "node:net";
import ts from "typescript";
import { createReleaseFingerprint, versionDemoAssetReferences } from "./package-webmcp-pages.mjs";

export const RELEASE_TOOL_NAMES = Object.freeze([
  "paperpilot.read_focus", "paperpilot.read_graph", "paperpilot.stage_explain",
  "paperpilot.apply_graph", "paperpilot.apply_annotation", "paperpilot.focus_source",
]);
export const READINESS_GROUPS = Object.freeze(["technical", "human-accessibility", "submission"]);
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const RUN_STATUS = new Set(["pass", "limited", "rejected", "not_run"]);
const CLIENT_KEYS = Object.freeze(["name", "os", "observedOn", "browserVersion", "agentVersion", "versionNote"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, max = 400) => typeof value === "string" && value.trim().length > 0
  && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const closed = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));

/** Syntactic public-address eligibility, not an online reachability/DNS assertion. */
export function isPublicHttpsUrl(value) {
  if (!text(value, 2_048) || value !== value.trim()) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password
      && !url.port && !host.endsWith(".") && !isIP(host) && !host.includes(":")
      && !host.startsWith("[") && host.includes(".")
      && !/(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/u.test(host)
      && host.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(part));
  } catch { return false; }
}

export function isYouTubeUrl(value) {
  if (!isPublicHttpsUrl(value)) return false;
  const url = new URL(value);
  if (url.hostname === "youtu.be") return /^\/[A-Za-z0-9_-]{11}$/u.test(url.pathname);
  if (!["youtube.com", "www.youtube.com"].includes(url.hostname)) return false;
  return (url.pathname === "/watch" && /^[A-Za-z0-9_-]{11}$/u.test(url.searchParams.get("v") || ""))
    || /^\/(?:shorts|embed)\/[A-Za-z0-9_-]{11}$/u.test(url.pathname);
}

export function isRepositoryRelativePath(value) {
  return text(value, 240) && !value.includes("\\") && !value.includes(":")
    && !value.startsWith("/") && value.split("/").every((part) => part && part !== "." && part !== "..");
}

export function parseReadinessPhase(args = []) {
  if (!args.length) return "full";
  const value = args.length === 2 && args[0] === "--phase" ? args[1]
    : args.length === 1 && args[0].startsWith("--phase=") ? args[0].slice(8) : null;
  if (!["full", "technical"].includes(value)) throw new Error("Use --phase technical or --phase full (the default).");
  return value;
}

/** Technical success never implies that the human or submission groups passed. */
export function summarizeReadiness(results, phase = "full") {
  if (!["full", "technical"].includes(phase)) throw new Error("Unsupported readiness phase.");
  if (!Array.isArray(results) || results.some((result) => !READINESS_GROUPS.includes(result.group) || typeof result.passed !== "boolean")) {
    throw new Error("Invalid readiness result group.");
  }
  const groups = Object.fromEntries(READINESS_GROUPS.map((group) => {
    const controls = results.filter((result) => result.group === group);
    return [group, { total: controls.length, passed: controls.filter((result) => result.passed).length,
      open: controls.filter((result) => !result.passed).length }];
  }));
  const selected = phase === "full" ? results : results.filter((result) => result.group === "technical");
  return { phase, groups, total: results.length, passed: results.filter((result) => result.passed).length,
    open: results.filter((result) => !result.passed).length,
    selectedOpen: selected.filter((result) => !result.passed).length,
    exitCode: selected.length === 0 || selected.some((result) => !result.passed) ? 1 : 0,
    overallReady: results.length > 0 && results.every((result) => result.passed) };
}

function releaseClientErrors(client, { today } = {}) {
  if (!closed(client, CLIENT_KEYS)) return ["release_client_shape"];
  const errors = [];
  if (!text(client.name, 160) || !text(client.os, 80)) errors.push("release_client_identity_missing");
  const day = typeof client.observedOn === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(client.observedOn)
    && Number.isFinite(Date.parse(`${client.observedOn}T00:00:00.000Z`))
    && new Date(`${client.observedOn}T00:00:00.000Z`).toISOString().slice(0, 10) === client.observedOn;
  if (!day || (today && client.observedOn > today)) errors.push("release_client_date_invalid");
  if (!(client.browserVersion === null || text(client.browserVersion, 100))
    || !(client.agentVersion === null || text(client.agentVersion, 100)) || !text(client.versionNote, 500)) errors.push("release_client_versions_invalid");
  return errors;
}

/** The current schema records one current client; historical clients stay in historical proof. */
export function matchesRecordedReleaseClient(testedClients, recordedClient, options = {}) {
  if (!Array.isArray(testedClients) || testedClients.length !== 1 || releaseClientErrors(recordedClient, options).length > 0) return false;
  const client = testedClients[0];
  return releaseClientErrors(client, options).length === 0 && CLIENT_KEYS.every((key) => client[key] === recordedClient[key]);
}

/** Closed, bounded, sanitized evidence metadata. This verifies recorded claims, not live behavior. */
export function validateReleaseEvidence(evidence, { manifest, proofText = "", today } = {}) {
  const errors = [];
  const reject = (condition, code) => { if (!condition) errors.push(code); };
  const keys = ["schemaVersion", "sourceCommit", "artifactFingerprint", "liveUrl", "proofPath", "client", "runs"];
  if (!closed(evidence, keys)) return { valid: false, errors: ["release_evidence_shape"], matrix: null };
  reject(evidence.schemaVersion === 1, "release_evidence_version");
  reject(typeof evidence.sourceCommit === "string" && COMMIT.test(evidence.sourceCommit), "release_commit_invalid");
  reject(typeof evidence.artifactFingerprint === "string" && SHA256.test(evidence.artifactFingerprint), "release_fingerprint_invalid");
  reject(isPublicHttpsUrl(evidence.liveUrl), "release_url_invalid");
  reject(isRepositoryRelativePath(evidence.proofPath) && /^docs\/release\/[^/]+\.md$/u.test(evidence.proofPath)
    && !/(?:^|\/)WEBMCP-LIVE-PROOF\.md$/iu.test(evidence.proofPath), "release_proof_path_invalid");
  if (manifest) {
    reject(manifest.publicArtifacts?.releaseCommit === evidence.sourceCommit, "manifest_release_commit_mismatch");
    reject(manifest.publicArtifacts?.releaseProofPath === evidence.proofPath, "manifest_release_proof_mismatch");
    reject(manifest.publicArtifacts?.liveUrl === evidence.liveUrl, "manifest_release_url_mismatch");
  }
  reject(typeof proofText === "string" && proofText.trim().length > 0 && proofText.length <= 256 * 1024 && proofText.includes(evidence.sourceCommit)
    && proofText.includes(evidence.artifactFingerprint) && proofText.includes(evidence.liveUrl)
    && !/^#\s+Historical\b/imu.test(proofText.slice(0, 500)), "release_proof_missing_or_unbound");
  errors.push(...releaseClientErrors(evidence.client, { today }));
  if (!Array.isArray(evidence.runs) || evidence.runs.length < 1 || evidence.runs.length > 40) {
    return { valid: false, errors: [...errors, "release_runs_invalid"], matrix: null };
  }
  const runIds = new Set(), receiptIds = new Set(), validRuns = [];
  const runKeys = ["id", "origin", "documentClass", "documentSha256", "pages", "callbacks", "source", "graph", "annotation", "undoRedo"];
  for (const run of evidence.runs) {
    if (!closed(run, runKeys)) { errors.push("release_run_shape"); continue; }
    const errorCount = errors.length;
    reject(text(run.id, 100) && !runIds.has(run.id), "release_run_identity_invalid"); runIds.add(run.id);
    reject(["public", "local"].includes(run.origin), "release_run_origin_invalid");
    reject(["born_digital", "weak_text", "unsupported"].includes(run.documentClass), "release_run_class_invalid");
    reject((typeof run.documentSha256 === "string" && SHA256.test(run.documentSha256))
      || (run.documentClass === "unsupported" && run.documentSha256 === null), "release_run_document_invalid");
    reject((Number.isInteger(run.pages) && run.pages >= 1 && run.pages <= 200)
      || (run.documentClass === "unsupported" && run.pages === null), "release_run_pages_invalid");
    reject([run.source, run.graph, run.annotation, run.undoRedo].every((status) => RUN_STATUS.has(status)), "release_run_status_invalid");
    if (!Array.isArray(run.callbacks) || run.callbacks.length > 120) errors.push("release_callbacks_invalid");
    else for (const callback of run.callbacks) {
      if (!closed(callback, ["toolName", "receiptId"])) { errors.push("release_callback_shape"); continue; }
      reject(RELEASE_TOOL_NAMES.includes(callback.toolName), "release_callback_tool_invalid");
      reject(typeof callback.receiptId === "string" && /^callback:[A-Za-z0-9_-]{8,120}$/u.test(callback.receiptId)
        && !receiptIds.has(callback.receiptId), "release_callback_receipt_invalid");
      receiptIds.add(callback.receiptId);
    }
    if (errors.length === errorCount) validRuns.push(run);
  }
  const completed = validRuns.filter((run) => run.origin === "public" && run.documentClass === "born_digital"
    && [run.source, run.graph, run.annotation, run.undoRedo].every((status) => status === "pass")
    && RELEASE_TOOL_NAMES.every((name) => run.callbacks.some((callback) => callback.toolName === name)));
  const matrix = {
    publicBornDigitalPapers: new Set(completed.map((run) => run.documentSha256)).size,
    publicWeakText: validRuns.some((run) => run.origin === "public" && run.documentClass === "weak_text"
      && run.source === "pass" && run.annotation === "pass" && ["pass", "limited"].includes(run.graph)),
    unsupportedRejection: validRuns.some((run) => run.documentClass === "unsupported" && run.source === "rejected"),
  };
  return { valid: errors.length === 0, errors: [...new Set(errors)], matrix };
}

/** Extract only the existing literal packaging allowlist, never evaluate repository source. */
export function packagedDemoFiles(packagerSource) {
  const body = /const demoFiles = Object\.freeze\(\[([\s\S]*?)\]\);/u.exec(packagerSource)?.[1];
  if (!body || !/^(?:\s*"[a-z0-9-]+\.(?:mjs|html|css)"\s*,?\s*)+$/u.test(body)) return null;
  const files = [...body.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  if (new Set(files).size !== files.length || !["index.html", "app.mjs", "contracts.mjs", "pdf-viewer.mjs"].every((file) => files.includes(file))) return null;
  return files;
}

/** Check exact offline commit/artifact equality. No Git, network, writes, or shell calls. */
export function validateReleaseArtifact({ evidence, committedSources, authoredSources, packagedSources }) {
  const errors = [];
  const packagerPath = "scripts/package-webmcp-pages.mjs";
  const committedPackager = committedSources.get(packagerPath);
  const files = committedPackager && packagedDemoFiles(committedPackager.toString("utf8"));
  if (!files) return { valid: false, errors: ["release_packager_manifest_invalid"] };
  const records = [...files.map((file) => `spikes/webmcp-contract/${file}`), "package.json", "package-lock.json", packagerPath];
  if (records.some((file) => !committedSources.has(file))) return { valid: false, errors: ["release_committed_source_missing"] };
  const fingerprint = createReleaseFingerprint(records.map((file) => ({ file, bytes: committedSources.get(file) })));
  if (fingerprint !== evidence.artifactFingerprint) errors.push("release_commit_fingerprint_mismatch");
  const currentPackager = authoredSources.get(packagerPath);
  if (!currentPackager?.equals(committedPackager)) errors.push("release_packager_changed");
  // npm scripts/docs may evolve after publication, but runtime pins and lockfile may not.
  if (!authoredSources.get("package-lock.json")?.equals(committedSources.get("package-lock.json"))) errors.push("release_lockfile_changed");
  try {
    const currentPackage = JSON.parse(authoredSources.get("package.json").toString("utf8"));
    const releasePackage = JSON.parse(committedSources.get("package.json").toString("utf8"));
    for (const key of ["dependencies", "devDependencies", "overrides"]) {
      if (JSON.stringify(currentPackage[key]) !== JSON.stringify(releasePackage[key])) errors.push("release_dependency_manifest_changed");
    }
  } catch { errors.push("release_package_invalid"); }
  for (const file of files) {
    const key = `spikes/webmcp-contract/${file}`;
    const committed = committedSources.get(key);
    if (!authoredSources.get(key)?.equals(committed)) errors.push("release_runtime_source_changed");
    const expected = versionDemoAssetReferences(committed.toString("utf8"), file, fingerprint);
    if (packagedSources.get(file) !== expected) errors.push("release_packaged_source_mismatch");
  }
  if (packagedSources.size !== files.length || [...packagedSources.keys()].some((file) => !files.includes(file))) errors.push("release_packaged_inventory_mismatch");
  return { valid: errors.length === 0, errors: [...new Set(errors)], fingerprint };
}

/** Static wiring/safety checks supplement, never replace, native callback evidence. */
export function inspectReleaseSources(sources, packageJson, packageLock = {}) {
  const app = sources.get("app.mjs") || "", contracts = sources.get("contracts.mjs") || "";
  const index = sources.get("index.html") || "", all = [...sources.values()].join("\n");
  const names = [];
  const syntax = ts.createSourceFile("contracts.mjs", contracts, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "toolDefinition") {
      names.push(node.arguments[0] && ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : null);
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  const exactTools = syntax.parseDiagnostics.length === 0 && names.length === RELEASE_TOOL_NAMES.length && new Set(names).size === names.length
    && RELEASE_TOOL_NAMES.every((name) => names.includes(name));
  const registration = /\bcreateToolSuite\s*\(/u.test(app) && /\bmountToolSuite\s*\(/u.test(app)
    && /modelContext\.registerTool\.bind\(modelContext\)/u.test(contracts)
    && /\bregisterTool\(tool,\s*\{\s*signal:/u.test(contracts);
  const dependencyNames = Object.keys({ ...packageJson?.dependencies, ...packageJson?.devDependencies });
  const noWriter = !dependencyNames.includes("annotpdf")
    && !Object.keys(packageLock?.packages || {}).some((key) => /(?:^|\/)node_modules\/annotpdf$/u.test(key))
    && !/\bAnnotationFactory\b|(?:from|import)\s*["']annotpdf["']|\b(?:export|download|write|rewrite)AnnotatedPdf\b|\bdownload\s*=\s*[^\n;]*\.pdf\b/u.test(all);
  const noExportUi = !/(?:id|data-testid)=["'][^"']*(?:export|download)[^"']*pdf|>\s*(?:export|download)\s+(?:annotated\s+)?pdf\s*</iu.test(all);
  const noTranscript = !/(?:id|class)=["'][^"']*transcript|Page\s+\d+\s+transcript|selectable transcript/iu.test(index);
  return { exactTools, registration, noWriter, noExportUi, noTranscript };
}
