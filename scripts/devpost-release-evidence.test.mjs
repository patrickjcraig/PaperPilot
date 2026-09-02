import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  inspectReleaseSources, isPublicHttpsUrl, isRepositoryRelativePath, isYouTubeUrl, matchesRecordedReleaseClient, packagedDemoFiles,
  parseReadinessPhase, RELEASE_TOOL_NAMES, summarizeReadiness, validateReleaseArtifact, validateReleaseEvidence,
} from "./devpost-release-evidence.mjs";
import { createReleaseFingerprint, versionDemoAssetReferences } from "./package-webmcp-pages.mjs";

function releaseFixture() {
  const run = (id, documentClass, origin = "public") => ({
    id, origin, documentClass, documentSha256: id === "first" ? "a".repeat(64) : id === "second" ? "b".repeat(64) : "c".repeat(64),
    pages: documentClass === "born_digital" ? 15 : 4,
    callbacks: documentClass === "born_digital" ? RELEASE_TOOL_NAMES.map((toolName, index) => ({ toolName, receiptId: `callback:${id}-receipt-${index}` })) : [],
    source: "pass", graph: documentClass === "weak_text" ? "limited" : "pass", annotation: "pass", undoRedo: documentClass === "born_digital" ? "pass" : "not_run",
  });
  const evidence = {
    schemaVersion: 1, sourceCommit: "1".repeat(40), artifactFingerprint: "2".repeat(64),
    liveUrl: "https://patrickjcraig.github.io/PaperPilot/webmcp/",
    proofPath: "docs/release/PUBLIC-RELEASE-PROOF-2026-09-02.md",
    client: { name: "Codex in-app browser", os: "Windows", observedOn: "2026-09-02", browserVersion: null, agentVersion: null,
      versionNote: "Exact browser and agent build strings were not exposed; none are invented." },
    runs: [run("first", "born_digital"), run("second", "born_digital"), run("weak", "weak_text"),
      { ...run("unsupported", "unsupported", "local"), documentSha256: null, pages: null, source: "rejected", graph: "not_run", annotation: "not_run", undoRedo: "not_run" }],
  };
  const manifest = { publicArtifacts: { releaseCommit: evidence.sourceCommit, releaseProofPath: evidence.proofPath, liveUrl: evidence.liveUrl } };
  const proofText = `# Current public release\n${evidence.sourceCommit}\n${evidence.artifactFingerprint}\n${evidence.liveUrl}\nHuman review remains open.`;
  return { evidence, context: { manifest, proofText, today: "2026-09-02" } };
}

test("closed release evidence validates complete metadata without inventing unavailable client versions", () => {
  const { evidence, context } = releaseFixture();
  const original = JSON.stringify(evidence);
  const result = validateReleaseEvidence(evidence, context);
  assert.equal(result.valid, true);
  assert.deepEqual(result.matrix, { publicBornDigitalPapers: 2, publicWeakText: true, unsupportedRejection: true });
  assert.equal(JSON.stringify(evidence), original);
  assert.equal(evidence.client.browserVersion, null);
});

test("current tested client matches closed recorded metadata independent of key order and accepts explicitly unavailable versions", () => {
  const { evidence } = releaseFixture();
  const recorded = evidence.client;
  const reordered = Object.fromEntries(Object.entries(recorded).reverse());
  assert.equal(matchesRecordedReleaseClient([reordered], recorded), true);
  assert.equal(reordered.browserVersion, null);
  assert.equal(reordered.agentVersion, null);
  for (const clients of [
    [], null, ["historical client version"], [{}], [recorded, recorded],
    [{ ...recorded, observedOn: "2026-08-30" }], [{ ...recorded, browserVersion: "invented-build" }],
    [{ ...recorded, versionNote: "" }], [{ ...recorded, os: {} }], [{ ...recorded, extra: "unknown" }],
    [{ ...recorded, name: "Different client" }],
  ]) assert.equal(matchesRecordedReleaseClient(clients, recorded), false);
  assert.equal(matchesRecordedReleaseClient([{ ...recorded, browserVersion: {} }], { ...recorded, browserVersion: {} }), false);
  assert.equal(matchesRecordedReleaseClient([recorded], recorded, { today: "2026-09-01" }), false);
  const knownVersions = { ...recorded, browserVersion: "observed-browser-build", agentVersion: "observed-agent-build", versionNote: "Recorded directly for this release." };
  assert.equal(matchesRecordedReleaseClient([knownVersions], knownVersions), true);
});

test("missing, unknown, malformed and mismatched evidence fields fail closed with safe codes", () => {
  for (const mutate of [
    (evidence) => { evidence.schemaVersion = 2; },
    (evidence) => { evidence.sourceCommit = "not-a-commit"; },
    (evidence) => { evidence.artifactFingerprint = "unbound"; },
    (evidence) => { evidence.extra = "not accepted"; },
    (evidence) => { delete evidence.runs; },
    (evidence) => { evidence.runs = []; },
    (evidence) => { evidence.runs[0].pages = 201; },
    (evidence) => { evidence.runs[0].documentSha256 = null; },
    (evidence) => { evidence.runs[0].origin = "pretend-public"; },
    (evidence) => { evidence.runs[0].source = "verified"; },
    (evidence) => { evidence.runs[0].rawPdf = "forbidden"; },
    (evidence) => { evidence.client = {}; },
    (evidence) => { evidence.client.browserVersion = {}; },
    (evidence) => { evidence.client.versionNote = ""; },
    (evidence) => { evidence.client.observedOn = "2026-09-03"; },
    (evidence) => { evidence.client.observedOn = "2026-02-30"; },
  ]) {
    const { evidence, context } = releaseFixture(); mutate(evidence);
    const result = validateReleaseEvidence(evidence, context);
    assert.equal(result.valid, false);
    assert.ok(result.errors.every((code) => /^[a-z_]+$/u.test(code)));
  }
  for (const input of [null, [], true, "text"]) assert.equal(validateReleaseEvidence(input).valid, false);
  for (const key of ["releaseCommit", "releaseProofPath", "liveUrl"]) {
    const { evidence, context } = releaseFixture(); context.manifest.publicArtifacts[key] = "different";
    assert.equal(validateReleaseEvidence(evidence, context).valid, false);
  }
});

test("historical, absent and identity-unbound prose cannot satisfy new release evidence", () => {
  const { evidence, context } = releaseFixture();
  for (const proofText of ["", "# A proof without the release identifiers", `# Historical two-tool WebMCP live proof\n${context.proofText}`]) {
    assert.equal(validateReleaseEvidence(evidence, { ...context, proofText }).valid, false);
  }
  for (const proofPath of ["docs/release/WEBMCP-LIVE-PROOF.md", "../outside.md", "C:/private/proof.md", "https://example.com/proof.md"]) {
    assert.equal(validateReleaseEvidence({ ...evidence, proofPath }, context).valid, false);
  }
});

test("callback records reject unknown authority, missing receipts, duplication and oversized inventories", () => {
  for (const mutate of [
    (run) => { run.callbacks[0].toolName = "paperpilot.undo"; },
    (run) => { run.callbacks[0].receiptId = ""; },
    (run) => { run.callbacks[0].receiptId = "C:\\private\\secret"; },
    (run) => { run.callbacks[0].hiddenReasoning = "not evidence"; },
    (run) => { run.callbacks.push({ ...run.callbacks[0] }); },
    (run) => { run.callbacks = Array.from({ length: 121 }, () => ({})); },
  ]) {
    const { evidence, context } = releaseFixture(); mutate(evidence.runs[0]);
    assert.equal(validateReleaseEvidence(evidence, context).valid, false);
  }
  const { evidence, context } = releaseFixture();
  evidence.runs[1].callbacks[0].receiptId = evidence.runs[0].callbacks[0].receiptId;
  assert.equal(validateReleaseEvidence(evidence, context).valid, false);
});

test("matrix retains pending work: local runs, repeated paper, incomplete tools and limits are not public completion", () => {
  for (const mutate of [
    (evidence) => { evidence.runs[1].origin = "local"; },
    (evidence) => { evidence.runs[1].documentSha256 = evidence.runs[0].documentSha256; },
    (evidence) => { evidence.runs[1].callbacks.pop(); },
    (evidence) => { evidence.runs[1].undoRedo = "not_run"; },
    (evidence) => { evidence.runs[1].graph = "limited"; },
  ]) {
    const { evidence, context } = releaseFixture(); mutate(evidence);
    const result = validateReleaseEvidence(evidence, context);
    assert.equal(result.valid, true, "honest incomplete evidence is valid metadata, not a completed matrix");
    assert.equal(result.matrix.publicBornDigitalPapers, 1);
  }
  const { evidence, context } = releaseFixture(); evidence.runs[2].origin = "local";
  assert.equal(validateReleaseEvidence(evidence, context).matrix.publicWeakText, false);
});

test("public URLs reject credentialed, loopback, numeric, local, malformed and non-HTTPS destinations", () => {
  for (const url of [
    "http://github.com/project", "ftp://youtube.com/not-a-video", "https://user:pass@github.com/project",
    "https://localhost/", "https://127.0.0.2/", "https://2130706433/", "https://0x7f000001/", "https://[::1]/",
    "https://192.168.1.1/", "https://internal/", "https://host.internal/", "https://host.local/", "https://host.test/",
    "https://github.com:8443/", " https://github.com/", "https://github.com./", "javascript:alert(1)",
  ]) assert.equal(isPublicHttpsUrl(url), false, url);
  assert.equal(isPublicHttpsUrl("https://patrickjcraig.github.io/PaperPilot/webmcp/"), true);
  assert.equal(isPublicHttpsUrl("https://github.com/patrickjcraig/PaperPilot"), true);
  assert.equal(isRepositoryRelativePath("docs/release/proof.md"), true);
  for (const path of ["/absolute.md", "../parent.md", "docs/../parent.md", "C:\\private.md", "docs//proof.md"]) assert.equal(isRepositoryRelativePath(path), false);
});

test("video eligibility requires a public HTTPS YouTube video identifier, not only its hostname", () => {
  for (const url of ["https://youtu.be/abcdEFGh123", "https://www.youtube.com/watch?v=abcdEFGh123", "https://youtube.com/shorts/abcdEFGh123"]) assert.equal(isYouTubeUrl(url), true);
  for (const url of ["ftp://youtube.com/not-a-video", "https://youtube.com/", "https://youtube.com/watch", "https://youtu.be/short", "https://user:pass@youtu.be/abcdEFGh123", "https://youtube.com.evil.org/watch?v=abcdEFGh123"]) assert.equal(isYouTubeUrl(url), false);
});

function artifactFixture() {
  const files = ["index.html", "app.mjs", "contracts.mjs", "pdf-viewer.mjs"];
  const packager = Buffer.from(`const demoFiles = Object.freeze([${files.map((file) => JSON.stringify(file)).join(",")}]);`);
  const packageJson = { scripts: { test: "node --test" }, dependencies: { graphology: "0.26.0" }, devDependencies: {}, overrides: {} };
  const committedSources = new Map([
    ["scripts/package-webmcp-pages.mjs", packager], ["package.json", Buffer.from(JSON.stringify(packageJson))],
    ["package-lock.json", Buffer.from('{"lockfileVersion":3}')],
    ...files.map((file) => [`spikes/webmcp-contract/${file}`, Buffer.from(file === "index.html" ? '<script type="module" src="./app.mjs"></script>' : 'import "./contracts.mjs";')]),
  ]);
  const artifactFingerprint = createReleaseFingerprint([...committedSources].map(([file, bytes]) => ({ file, bytes })));
  const packagedSources = new Map(files.map((file) => [file, versionDemoAssetReferences(committedSources.get(`spikes/webmcp-contract/${file}`).toString("utf8"), file, artifactFingerprint)]));
  return { evidence: { artifactFingerprint }, committedSources, authoredSources: new Map(committedSources), packagedSources };
}

test("artifact identity binds commit bytes, packaging recipe, lockfile and every generated application module", () => {
  const fixture = artifactFixture();
  assert.equal(validateReleaseArtifact(fixture).valid, true);
  for (const mutate of [
    (data) => { data.evidence.artifactFingerprint = "f".repeat(64); },
    (data) => { data.committedSources.delete("spikes/webmcp-contract/app.mjs"); },
    (data) => { data.authoredSources.set("spikes/webmcp-contract/app.mjs", Buffer.from("changed")); },
    (data) => { data.authoredSources.set("package-lock.json", Buffer.from("changed")); },
    (data) => { data.authoredSources.set("scripts/package-webmcp-pages.mjs", Buffer.from("changed")); },
    (data) => { data.packagedSources.set("app.mjs", "stale"); },
    (data) => { data.packagedSources.delete("app.mjs"); },
    (data) => { data.packagedSources.set("extra.mjs", "unexpected"); },
  ]) {
    const data = artifactFixture(); mutate(data);
    assert.equal(validateReleaseArtifact(data).valid, false);
  }
});

test("later script-only package changes are allowed but dependency changes invalidate the release", () => {
  const data = artifactFixture();
  const current = JSON.parse(data.authoredSources.get("package.json").toString("utf8"));
  current.scripts.readiness = "node --test scripts/devpost-release-evidence.test.mjs";
  data.authoredSources.set("package.json", Buffer.from(JSON.stringify(current)));
  assert.equal(validateReleaseArtifact(data).valid, true);
  current.dependencies.graphology = "0.27.0";
  data.authoredSources.set("package.json", Buffer.from(JSON.stringify(current)));
  assert.equal(validateReleaseArtifact(data).valid, false);
});

test("packaging allowlist parsing cannot evaluate expressions or escape the source root", () => {
  assert.deepEqual(packagedDemoFiles('const demoFiles = Object.freeze(["index.html","app.mjs","contracts.mjs","pdf-viewer.mjs",]);'), ["index.html", "app.mjs", "contracts.mjs", "pdf-viewer.mjs"]);
  for (const source of ["", "const demoFiles = compute();", 'const demoFiles = Object.freeze(["../secret.mjs"]);', 'const demoFiles = Object.freeze([getSecret()]);']) assert.equal(packagedDemoFiles(source), null);
});

test("active multi-module source wiring is recognized while forbidden tools, writer imports and transcript fail", async () => {
  const files = ["app.mjs", "contracts.mjs", "index.html", "pdf-viewer.mjs"];
  const sources = new Map(await Promise.all(files.map(async (file) => [file, await readFile(new URL(`../spikes/webmcp-contract/${file}`, import.meta.url), "utf8")])));
  const baseline = inspectReleaseSources(sources, { dependencies: {} });
  assert.deepEqual(baseline, { exactTools: true, registration: true, noWriter: true, noExportUi: true, noTranscript: true });
  const forbidden = new Map(sources); forbidden.set("contracts.mjs", `${sources.get("contracts.mjs")}\ntoolDefinition("paperpilot.undo", () => {});`);
  assert.equal(inspectReleaseSources(forbidden, {}).exactTools, false);
  const writer = new Map(sources); writer.set("additional-module.mjs", 'import {AnnotationFactory} from "annotpdf";');
  assert.equal(inspectReleaseSources(writer, {}).noWriter, false);
  writer.set("additional-module.mjs", 'link.download = "annotated.pdf";');
  assert.equal(inspectReleaseSources(writer, {}).noWriter, false);
  assert.equal(inspectReleaseSources(sources, { dependencies: { annotpdf: "1.0.15" } }).noWriter, false);
  assert.equal(inspectReleaseSources(sources, {}, { packages: { "node_modules/other/node_modules/annotpdf": {} } }).noWriter, false);
  const fakeTools = new Map(sources);
  fakeTools.set("contracts.mjs", RELEASE_TOOL_NAMES.map((name) => `// toolDefinition("${name}", () => {});`).join("\n"));
  assert.equal(inspectReleaseSources(fakeTools, {}).exactTools, false, "comments are not executable registrations");
  const legacy = new Map(sources); legacy.set("index.html", '<label>Page 1 transcript</label>');
  assert.equal(inspectReleaseSources(legacy, {}).noTranscript, false);
  const exporting = new Map(sources); exporting.set("additional-module.mjs", '<button id="download-pdf">Download PDF</button>');
  assert.equal(inspectReleaseSources(exporting, {}).noExportUi, false);
});

test("technical phase leaves human and submission failures visible without claiming overall readiness", () => {
  const results = [
    { group: "technical", passed: true }, { group: "human-accessibility", passed: false }, { group: "submission", passed: false },
  ];
  const technical = summarizeReadiness(results, "technical");
  assert.equal(technical.exitCode, 0); assert.equal(technical.selectedOpen, 0);
  assert.equal(technical.overallReady, false); assert.equal(technical.open, 2);
  assert.equal(technical.groups["human-accessibility"].open, 1);
  assert.equal(summarizeReadiness(results, "full").exitCode, 1);
  assert.equal(summarizeReadiness([], "technical").exitCode, 1, "an empty control set cannot pass");
  results[0].passed = false;
  assert.equal(summarizeReadiness(results, "technical").exitCode, 1);
  assert.throws(() => summarizeReadiness([{ group: "invented", passed: true }], "technical"));
  assert.equal(parseReadinessPhase([]), "full");
  assert.equal(parseReadinessPhase(["--phase", "technical"]), "technical");
  assert.equal(parseReadinessPhase(["--phase=full"]), "full");
  for (const args of [["--phase"], ["--phase", "submission"], ["--skip-human"], ["--phase", "technical", "--ignore-failures"]]) assert.throws(() => parseReadinessPhase(args));
});

test("CLI rejects unknown phases safely instead of silently choosing a weaker gate", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./check-devpost-readiness.mjs", import.meta.url)), "--phase", "submission"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Use --phase technical or --phase full/u);
  assert.doesNotMatch(result.stderr, /at file:|stack/iu);
});
