import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  inspectReleaseSources, isPublicHttpsUrl, isRepositoryRelativePath, isYouTubeUrl, matchesRecordedReleaseClient,
  packagedDemoFiles, parseReadinessPhase, RELEASE_TOOL_NAMES, summarizeReadiness,
  validateReleaseArtifact, validateReleaseEvidence,
} from "./devpost-release-evidence.mjs";

const repositoryRoot = resolve(process.cwd());
const manifestPath = resolve(repositoryRoot, "devpost-requirements.json");
const results = [];
let phase;
try { phase = parseReadinessPhase(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exit(2); }

function addResult(passed, requirement, remediation = "", group = "technical") {
  results.push({ passed: Boolean(passed), requirement, remediation, group });
}

function safeFile(relativePath) {
  if (!isRepositoryRelativePath(relativePath)) return null;
  try {
    const absolute = realpathSync(resolve(repositoryRoot, relativePath));
    const root = `${realpathSync(repositoryRoot)}${process.platform === "win32" ? "\\" : "/"}`;
    if (!absolute.startsWith(root) || !statSync(absolute).isFile() || statSync(absolute).size > 8 * 1024 * 1024) return null;
    return absolute;
  } catch { return null; }
}

function readText(relativePath) {
  try {
    const file = safeFile(relativePath);
    return file ? readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
}

function isFile(relativePath) {
  return safeFile(relativePath) !== null;
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function samePath(left, right) {
  return resolve(left).toLocaleLowerCase() === resolve(right).toLocaleLowerCase();
}

function isSupportedRepositoryUrl(value) {
  if (!isPublicHttpsUrl(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      ["github.com", "gitlab.com", "bitbucket.org"].includes(
        url.hostname.toLocaleLowerCase(),
      )
    );
  } catch {
    return false;
  }
}

let manifest;
try {
  if (statSync(manifestPath).size > 256 * 1024) throw new Error("Manifest exceeds its size limit.");
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Manifest must be an object.");
  for (const key of ["event", "manualVerifications", "publicArtifacts", "judgeExperience", "project", "submissionAnswers"]) {
    if (!manifest[key] || typeof manifest[key] !== "object" || Array.isArray(manifest[key])) throw new Error("Manifest sections must be objects.");
  }
  addResult(true, "The machine-readable Devpost requirements manifest parses as JSON.");
} catch (error) {
  manifest = null;
  addResult(
    false,
    "The machine-readable Devpost requirements manifest parses as JSON.",
    `Repair devpost-requirements.json (${error instanceof Error ? error.message : "unknown error"}).`,
  );
}

if (manifest) {
  const manual = manifest.manualVerifications ?? {};
  const artifacts = manifest.publicArtifacts ?? {};
  const judge = manifest.judgeExperience ?? {};
  const project = manifest.project ?? {};
  const submission = manifest.submissionAnswers ?? {};
  let evidence = null;
  try { evidence = JSON.parse(readText(artifacts.releaseEvidencePath)); } catch { /* Closed evidence validation reports the safe failure. */ }
  const evidenceValidation = validateReleaseEvidence(evidence, {
    manifest, proofText: readText(artifacts.releaseProofPath), today: new Date().toISOString().slice(0, 10),
  });
  addResult(evidenceValidation.valid,
    "Versioned release evidence binds the recorded commit, public URL, proof document, client, and callback runs.",
    `Record factual release evidence under publicArtifacts.releaseEvidencePath. Open checks: ${evidenceValidation.errors.join(", ") || "none"}.`);
  const releaseCommit = typeof artifacts.releaseCommit === "string" && /^[a-f0-9]{40}$/u.test(artifacts.releaseCommit)
    ? artifacts.releaseCommit : null;
  const commitExists = releaseCommit && git(["rev-parse", "--verify", `${releaseCommit}^{commit}`]) === releaseCommit;
  addResult(commitExists, "The release source identity resolves to an exact local Git commit.", "Record the full reproduced release commit; historical or invalid IDs cannot establish current release proof.");
  const packagerPath = "scripts/package-webmcp-pages.mjs";
  const authoredFiles = packagedDemoFiles(readText(packagerPath)) || [];
  const releasedSources = new Map();
  const committedSources = new Map(), authoredSources = new Map();
  const gitBytes = (file) => {
    const response = spawnSync("git", ["show", `${releaseCommit}:${file}`], {
      cwd: repositoryRoot, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 10_000,
    });
    return response.status === 0 ? response.stdout : null;
  };
  let artifactValidation = { valid: false, errors: ["release_evidence_or_commit_missing"] };
  if (commitExists && evidenceValidation.valid) {
    const recordedPackager = gitBytes(packagerPath);
    const releasedFiles = recordedPackager && packagedDemoFiles(recordedPackager.toString("utf8"));
    if (releasedFiles) {
      for (const file of [...releasedFiles.map((name) => `spikes/webmcp-contract/${name}`), "package.json", "package-lock.json", packagerPath]) {
        const committed = gitBytes(file), current = safeFile(file);
        if (committed) committedSources.set(file, committed);
        if (current) authoredSources.set(file, readFileSync(current));
      }
      try {
        for (const entry of readdirSync(resolve(repositoryRoot, ".paperpilot-pages/webmcp"), { withFileTypes: true })) {
          if (entry.isFile()) releasedSources.set(entry.name, readText(`.paperpilot-pages/webmcp/${entry.name}`));
          else releasedSources.set(entry.name, ""); // Unexpected directories are not silently ignored.
        }
      } catch { /* Missing artifact fails the exact inventory check. */ }
      artifactValidation = validateReleaseArtifact({ evidence, committedSources, authoredSources, packagedSources: releasedSources });
    }
  }
  addResult(artifactValidation.valid,
    "The generated Pages artifact matches the recorded commit fingerprint and unchanged runtime sources.",
    `Build and verify the exact release; do not substitute the historical public directory. Open checks: ${artifactValidation.errors.join(", ")}.`);
  const matrix = evidenceValidation.valid ? evidenceValidation.matrix : null;
  addResult(matrix?.publicBornDigitalPapers >= 2 && matrix?.publicWeakText && matrix?.unsupportedRejection,
    "Recorded public release runs cover two unrelated born-digital PDFs, weak text, and an honest unsupported-input rejection.",
    "Record actual per-paper public callbacks, source/graph/annotation checks and Undo/Redo; local runs are never promoted to public proof.");
  const activeSources = new Map(authoredFiles.map((file) => [file, readText(`spikes/webmcp-contract/${file}`)]));
  let packageMetadata = {}, packageLock = {};
  try { packageMetadata = JSON.parse(readText("package.json")); } catch { /* Static checks fail closed where required. */ }
  try { packageLock = JSON.parse(readText("package-lock.json")); } catch { /* Artifact identity rejects an invalid lockfile. */ }
  const sourceChecks = inspectReleaseSources(activeSources, packageMetadata, packageLock);
  addResult(judge.readerEntryPath === "spikes/webmcp-contract/index.html"
    && judge.paperPilotToolIntegrationPath === "spikes/webmcp-contract/contracts.mjs"
    && authoredFiles.includes("index.html") && authoredFiles.includes("contracts.mjs"),
  "The manifest identifies the active authored Reader and tool contracts packaged by Pages.",
  "Use spikes/webmcp-contract/index.html and spikes/webmcp-contract/contracts.mjs; legacy public/webmcp files are historical evidence only.");

  addResult(
    manifest.schemaVersion === 2,
    "The machine-readable requirements manifest uses the redesigned PaperPilot contract.",
    "Set schemaVersion to 2 and restore the centered-PDF, graph, reversible-mutation, accessibility, and safety gates.",
  );

  addResult(
    manifest.event?.slug === "webmcp" &&
      manifest.event?.submissionDeadline === "2026-09-03T20:00:00.000Z",
    "The manifest targets The WebMCP Challenge and its recorded submission deadline.",
    "Restore the official event slug and deadline after re-checking the Devpost rules.",
  );
  addResult(
    project.appStatus === "Existing",
    "PaperPilot is disclosed as an existing application.",
    "Set project.appStatus to Existing and preserve the baseline/new-work disclosure.",
  );

  const requiredFiles = [
    ...new Set([
      "README.md",
      "package.json",
      "package-lock.json",
      "docs/DEVPOST-COMPLIANCE.md",
      judge.instructionsPath,
      judge.productScopePath,
      judge.productRequirementsPath,
      judge.technicalSpecificationPath,
      judge.readerEntryPath,
      "docs/hackathon-build/checklist.md",
      "docs/ADR-PDF-ANNOTATION-RUNTIME.md",
      project.newWorkDisclosure,
    ]),
  ].filter(Boolean);
  for (const file of requiredFiles) {
    addResult(
      isFile(file),
      `Required public artifact exists: ${file}.`,
      `Create and commit ${file}.`,
    );
  }

  addResult(
    isFile(project.licensePath) && /^[A-Za-z0-9][A-Za-z0-9-.+]*$/.test(project.licenseSpdxId ?? ""),
    "A root open-source license exists and has an SPDX identifier.",
    "Choose an open-source license, add it at LICENSE, and record its SPDX identifier in devpost-requirements.json.",
  );
  addResult(
    manual.licenseVisibleOnRepositoryHome === true,
    "The repository host visibly detects the root license.",
    "Verify the public repository home in an incognito session, then record the manual verification.",
  );

  const gitRoot = git(["rev-parse", "--show-toplevel"]);
  const origin = git(["config", "--get", "remote.origin.url"]);
  addResult(
    gitRoot.length > 0 && samePath(gitRoot, repositoryRoot),
    "PaperPilot is the root of its own Git repository.",
    `Create a PaperPilot-local Git repository. Current Git root: ${gitRoot || "none"}.`,
  );
  addResult(
    isSupportedRepositoryUrl(artifacts.repositoryUrl),
    "The requirements manifest contains a supported public repository URL.",
    "Set publicArtifacts.repositoryUrl to the public GitHub, GitLab, or Bitbucket repository.",
  );
  addResult(
    manual.repositoryPublicIncognitoVerified === true,
    "The source repository was verified without an owner session.",
    "Open the repository in an incognito session, confirm source/setup/license visibility, and record the manual verification.",
  );
  addResult(
    gitRoot.length > 0 &&
      samePath(gitRoot, repositoryRoot) &&
      origin.length > 0 &&
      /(?:github\.com|gitlab\.com|bitbucket\.org)/i.test(origin),
    "The local PaperPilot repository has a supported origin remote.",
    `Add the public PaperPilot origin remote. Current origin: ${origin || "none"}.`,
  );

  addResult(
    isPublicHttpsUrl(artifacts.liveUrl),
    "The manifest contains a public HTTPS live URL.",
    "Deploy the release to public HTTPS and set publicArtifacts.liveUrl.",
  );
  addResult(
    manual.liveUrlAnonymousOrCredentialsVerified === true,
    "Judge access to the live URL was verified.",
    "Verify an anonymous judge path or place credentials in Devpost's private field, then record the check.",
  );
  addResult(
    manual.liveUrlWebMcpVerified === true,
    "The historical live Reader's bounded PDF-source read and mentor-stage callbacks remain verified through WebMCP.",
    "Preserve or reproduce the historical public read/stage callback proof without relabeling it as the redesigned release.",
  );
  addResult(
    manual.redesignedWebMcpSuiteVerified === true,
    "The redesigned live Reader's focus, graph, navigation, explanation, and reversible-mutation capabilities were verified through WebMCP.",
    "Run the redesigned public flow in a supported WebMCP client, record every required observed callback, and then set redesignedWebMcpSuiteVerified.",
  );
  addResult(
    manual.paperAgnosticPdfFlowVerified === true,
    "The released flow was verified with replaceable, unrelated admitted PDFs through the shared pipeline without paper-specific configuration.",
    "Run the canonical born-digital, figure-rich, weak-text/scanned, and unsupported-PDF matrix without changing product code or configuration.",
  );
  addResult(
    manual.requiredSelectionKindsVerified === true,
    "Every required spatial source and whole-paper-map interaction was verified in the release.",
    "Verify spatial exact text, page region, whole figure, figure region, and whole-paper knowledge-map interaction against the redesigned Reader.",
  );
  addResult(
    manual.observableWebMcpActivityVerified === true,
    "The released activity trail was verified to stop at events PaperPilot actually observed.",
    "Record registration, focus/graph reads, navigation, explanation stage, mutation apply/reject, and failure states without claiming hidden agent activity.",
  );
  addResult(
    manual.accessibilityPrimaryFlowVerified === true,
    "The primary release flow has dated keyboard and screen-reader verification.",
    "Complete and record the centered PDF, annotations, accessible graph outline, mentor, Undo/Redo, source navigation, and evidence walkthroughs, including tested versions.",
    "human-accessibility",
  );
  addResult(
    manual.centeredPdfWorkspaceVerified === true,
    "The uploaded multi-page PDF was verified as the dominant middle workspace.",
    "Verify the released desktop and narrow-width layouts and record centeredPdfWorkspaceVerified.",
  );
  addResult(
    manual.noPersistentSourceTranscriptVerified === true,
    "The released Reader has no persistent visible source transcript.",
    "Verify that selection occurs on synchronized PDF text/region layers and record noPersistentSourceTranscriptVerified.",
  );
  addResult(
    manual.spatialAnnotationVerified === true,
    "Spatial text, page, figure, and figure-region anchors were verified against the rendered PDF.",
    "Verify PDF-space anchor round trips, overlay alignment, source reopening, and accessible annotation descriptions on unrelated PDFs.",
  );
  addResult(
    manual.wholePaperMapCoverageVerified === true,
    "The automatic paper map was verified to cover every page with honest structural or fallback authority.",
    "Verify total structural-map coverage and authority labels on outline-rich and outline-free papers.",
  );
  addResult(
    manual.graphNavigationVerified === true,
    "Bidirectional graph-to-PDF and annotation-to-graph navigation was verified.",
    "Verify every tested graph node reopens its exact PDF source and every mapped annotation selects the correct graph item.",
  );
  addResult(
    manual.reversibleAgentGraphMutationVerified === true,
    "A real agent graph mutation was atomically applied with revision, digest, source anchors, and a trusted inverse.",
    "Record a supported-client add/connect/tombstone sequence and its validated before/after graph evidence.",
  );
  addResult(
    manual.reversibleAgentAnnotationMutationVerified === true,
    "A real agent annotation mutation was atomically applied against trusted anchors with a retained inverse.",
    "Verify label/link/tombstone annotation changes, raw-coordinate rejection, revision evidence, and reversal.",
  );
  addResult(
    manual.undoRedoVerified === true,
    "Human-only Undo and Redo were verified over agent graph and annotation mutations.",
    "Verify apply, Undo, Redo, divergent-edit redo clearing, and digest restoration without exposing Undo/Redo as agent tools.",
  );
  addResult(
    manual.graphAccessibilityVerified === true,
    "The graph has a verified keyboard and screen-reader equivalent independent of Sigma.",
    "Test the accessible DOM graph outline, mutation announcements, focus movement, reduced motion, and graph/source navigation.",
    "human-accessibility",
  );
  addResult(manual.browser200PercentZoomVerified === true,
    "A human verified literal 200% browser zoom, separately from CSS viewport reflow.",
    "Record the actual browser-zoom walkthrough; 320/640px viewport checks cannot stand in for it.", "human-accessibility");
  addResult(manual.liveUrlAnotherMachineVerified === true,
    "A human opened the anonymous release from another machine.",
    "Record an actual second-machine check; a clean tab on the development machine is not equivalent.", "human-accessibility");
  addResult(
    manual.noPdfExportVerified === true,
    "The redesigned release keeps the immutable PDF inside PaperPilot and exposes no annotated-PDF export path.",
    "Inspect the UI, dependency graph, and bundle for PDF export/byte-writer behavior and record the no-export verification.",
  );
  addResult(
    manual.crossPaperRejectionVerified === true,
    "Foreign-paper graph keys and spatial anchors were verified to fail closed.",
    "Run graph, annotation, navigation, and read attempts with foreign document identifiers and record zero state disclosure or mutation.",
  );
  addResult(
    manual.truthfulFallbackVerified === true,
    "When native WebMCP is unavailable, the manual Reader/map path remains usable and cannot appear as native proof.",
    "Verify the unavailable/error status and absence of native callback success events; do not imply that a fallback mentor ran.",
  );

  const productScope = readText(judge.productScopePath ?? "");
  const productRequirements = readText(judge.productRequirementsPath ?? "");
  const technicalSpecification = readText(judge.technicalSpecificationPath ?? "");
  const productDocs = `${productScope}\n${productRequirements}\n${technicalSpecification}`;
  const requiredSelectionKinds = [
    "spatial-exact-text",
    "page-region",
    "whole-figure",
    "figure-region",
    "whole-paper-knowledge-map",
  ];
  const requiredWebMcpCapabilities = [
    "read-bounded-spatial-focus",
    "read-source-grounded-knowledge-graph",
    "navigate-pdf-annotation-and-graph",
    "apply-reversible-source-grounded-graph-mutation",
    "apply-reversible-anchor-annotation",
    "stage-source-and-graph-grounded-explanation",
  ];
  const requiredToolNames = RELEASE_TOOL_NAMES;

  addResult(
    judge.requiresPaperAgnosticPdfFlow === true &&
      judge.prohibitsPaperSpecificDemoLogic === true,
    "The manifest requires a paper-agnostic PDF flow and forbids paper-specific demo logic.",
    "Keep both PaperPilot PDF scope guards enabled in devpost-requirements.json.",
  );
  addResult(
    judge.requiresCenteredSpatialPdfWorkspace === true &&
      judge.prohibitsPersistentVisibleTranscript === true,
    "The judge contract requires a centered spatial PDF and prohibits a detached transcript UI.",
    "Restore requiresCenteredSpatialPdfWorkspace and prohibitsPersistentVisibleTranscript in judgeExperience.",
  );
  addResult(
    judge.requiresAutomaticWholePaperKnowledgeMap === true &&
      judge.requiresAccessibleGraphOutline === true,
    "The judge contract requires automatic whole-paper coverage and an accessible graph equivalent.",
    "Restore the whole-paper-map and accessible-outline guards in judgeExperience.",
  );
  addResult(
    judge.requiresReversibleAgentGraphMutation === true &&
      judge.requiresReversibleAgentAnnotationMutation === true &&
      judge.requiresHumanOnlyUndoRedo === true,
    "The judge contract requires reversible agent graph/annotation edits with human-only Undo and Redo.",
    "Restore the graph/annotation mutation and human-control guards in judgeExperience.",
  );
  addResult(
    judge.prohibitsPdfExport === true &&
      judge.rejectsCrossPaperOperations === true,
    "The judge contract prohibits PDF export and foreign-paper operations.",
    "Restore prohibitsPdfExport and rejectsCrossPaperOperations in judgeExperience.",
  );
  addResult(
    /\bpaper-agnostic\b/i.test(productDocs) &&
      /\bpreviously unseen\b/i.test(productDocs) &&
      /\b(?:admitted|admission limits)\b/i.test(productDocs) &&
      /\bpaper-specific\b/i.test(productDocs),
    "The canonical Scope and PRD define the admitted, previously unseen, paper-agnostic PDF contract.",
    "Restore the approved PDF admission contract and explicit paper-specific-logic prohibition in the guided Scope and PRD.",
  );
  addResult(
    Array.isArray(judge.requiredSelectionKinds) && requiredSelectionKinds.every((kind) =>
      judge.requiredSelectionKinds?.includes(kind),
    ),
    "The judge contract requires spatial exact text, page/figure regions, whole figures, and a whole-paper knowledge map.",
    "Restore every approved selection kind under judgeExperience.requiredSelectionKinds.",
  );
  addResult(
    Array.isArray(judge.requiredWebMcpCapabilities) && requiredWebMcpCapabilities.every((capability) =>
      judge.requiredWebMcpCapabilities?.includes(capability),
    ),
    "The judge contract requires spatial and graph reads, graph/PDF navigation, reversible graph/annotation mutations, and graph-grounded explanation staging.",
    "Restore every approved redesigned Reader capability under judgeExperience.requiredWebMcpCapabilities.",
  );

  addResult(
    /\bcenter(?:ed|ing)?\b/i.test(productDocs) &&
      /\b(?:no|without)\s+(?:persistent\s+)?(?:visible\s+)?transcript\b/i.test(productDocs) &&
      /\bwhole-paper\b/i.test(productDocs) &&
      /\bGraphology\b/i.test(productDocs) &&
      /\bUndo\b/i.test(productDocs) &&
      /\bRedo\b/i.test(productDocs) &&
      /\bno PDF export\b/i.test(productDocs),
    "The canonical product documents require a centered PDF, no transcript, a whole-paper Graphology map, Undo/Redo, and no PDF export.",
    "Restore the approved spatial Reader, graph, reversibility, and no-export constraints in the canonical Scope and PRD.",
  );

  const judgeGuide = readText(judge.instructionsPath ?? "");
  addResult(
    /previously unseen[\s,-]+admitted PDF/i.test(judgeGuide) &&
      judgeGuide.includes("Local review—WebMCP was not invoked") &&
      /\b(?:centered|middle)\b[\s\S]{0,100}\bPDF\b|\bPDF\b[\s\S]{0,100}\b(?:centered|middle)\b/i.test(judgeGuide) &&
      /\bwhole-paper\b/i.test(judgeGuide) &&
      /\bUndo\b/i.test(judgeGuide) &&
      /\bRedo\b/i.test(judgeGuide) &&
      /\bno (?:annotated-)?PDF export\b|\bPDF export\b[\s\S]{0,40}\b(?:not available|no|without)\b/i.test(judgeGuide) &&
      !/\blaminography\b|source fixture|local fixture/i.test(judgeGuide),
    "The judge guide documents the redesigned PDF/graph/Undo flow and truthful non-WebMCP fallback.",
    "Align the judge guide with the redesigned Scope/PRD, including whole-paper mapping and Undo/Redo, and remove deterministic fixture instructions.",
  );

  addResult(
    isFile(judge.paperPilotToolIntegrationPath) && sourceChecks.registration,
    "Application code invokes the PaperPilot Reader WebMCP registration adapter.",
    `Mount the Reader's PaperPilot WebMCP registration adapter in ${judge.paperPilotToolIntegrationPath || "the declared integration path"}.`,
  );
  addResult(
    Array.isArray(judge.requiredWebMcpToolNames) &&
      judge.requiredWebMcpToolNames.length === requiredToolNames.length &&
      requiredToolNames.every((toolName) => judge.requiredWebMcpToolNames.includes(toolName)) && sourceChecks.exactTools,
    "The manifest and released integration contain the complete redesigned PaperPilot tool suite.",
    `Declare and register ${requiredToolNames.join(", ")} after the named-client schema spike.`,
  );

  addResult(
    sourceChecks.exactTools,
    "No WebMCP tool exposes PDF export, hard deletion, cross-paper linking, Undo, or Redo.",
    "Remove the forbidden tool operation; Undo and Redo are human-only UI controls.",
  );

  addResult(
    sourceChecks.noTranscript && activeSources.get("index.html")?.length > 0,
    "The public Reader entry has no persistent visible transcript UI.",
    "Remove the detached transcript and bind selection to the PDF text and region layers.",
  );
  addResult(
    sourceChecks.noWriter && sourceChecks.noExportUi,
    "The public Reader contains no annotated-PDF export UI or code path.",
    "Remove PDF export while retaining allowed provenance-receipt JSON export.",
  );

  addResult(
    evidenceValidation.valid && matchesRecordedReleaseClient(judge.testedClients, evidence?.client),
    "The current tested WebMCP client matches release evidence, including recorded versions or explicitly unavailable versions.",
    "Match judgeExperience.testedClients to the current structured release client record; preserve unknown versions as null with an honest note and keep historical clients in historical proof.",
  );
  addResult(
    Array.isArray(submission.webMcpClients) && submission.webMcpClients.length > 0,
    "The submission answers disclose which WebMCP clients were used.",
    "Record only clients actually used and tested in submissionAnswers.webMcpClients.",
    "submission",
  );

  addResult(
    isYouTubeUrl(artifacts.demoVideoUrl),
    "The manifest contains a public YouTube demo URL.",
    "Publish the final demo to YouTube and set publicArtifacts.demoVideoUrl.",
    "submission",
  );
  addResult(
    manual.demoVideoUnderThreeMinutes === true,
    "The final demo was manually verified to be under three minutes.",
    "Measure the public video's duration and record the manual verification.",
    "submission",
  );
  addResult(
    manual.demoVideoHasExplanatoryAudio === true,
    "The final demo was manually verified to include explanatory audio.",
    "Watch the public video with sound and record the manual verification.",
    "submission",
  );

  const changeLog = readText(project.newWorkDisclosure ?? "");
  addResult(
    changeLog.includes("## Pre-existing baseline") && changeLog.includes("## New challenge work"),
    "The change disclosure distinguishes the baseline from new challenge work.",
    "Add explicit pre-existing baseline and new challenge work sections to the disclosure.",
  );
  addResult(
    !changeLog.includes("pending PaperPilot-local repository initialization"),
    "Every challenge-work entry cites PaperPilot-local public Git evidence.",
    "Initialize the PaperPilot repository and replace pending evidence markers with public commits.",
  );
  addResult(
    manual.postDeadlineFreezePrepared === true,
    "The exact release and post-deadline freeze are prepared.",
    "Record the release commit/tag/deployment and prepare the freeze through the judging period.",
    "submission",
  );
  addResult(
    manual.submissionNotDraft === true,
    "A human verified that the Devpost entry is submitted, not a draft.",
    "Complete the final Devpost review and set this only after the site confirms submission.",
    "submission",
  );
}

const summary = summarizeReadiness(results, phase);
for (const result of results) {
  const marker = result.passed ? "PASS" : phase === "technical" && result.group !== "technical" ? "PENDING" : "FAIL";
  console.log(`${marker}  [${result.group}] ${result.requirement}`);
  if (!result.passed && result.remediation) {
    console.log(`      ${result.remediation}`);
  }
}

console.log("");
for (const [group, counts] of Object.entries(summary.groups)) console.log(`${group}: ${counts.passed}/${counts.total} controls pass; ${counts.open} remain open.`);
if (phase === "technical") {
  console.log(`Technical readiness only: ${summary.selectedOpen === 0 ? "PASS" : "FAIL"}. This is not overall release readiness or submission confirmation.`);
  console.log(`Overall readiness: ${summary.open} controls remain open across all groups; human review and submission evidence are evaluated separately.`);
} else console.log(`Devpost readiness: ${summary.passed}/${summary.total} controls pass; ${summary.open} remain open.`);
process.exitCode = summary.exitCode;
