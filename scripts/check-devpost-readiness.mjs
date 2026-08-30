import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(process.cwd());
const manifestPath = resolve(repositoryRoot, "devpost-requirements.json");
const results = [];

function addResult(passed, requirement, remediation = "") {
  results.push({ passed: Boolean(passed), requirement, remediation });
}

function readText(relativePath) {
  try {
    return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
  } catch {
    return "";
  }
}

function isFile(relativePath) {
  try {
    return statSync(resolve(repositoryRoot, relativePath)).isFile();
  } catch {
    return false;
  }
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

function isPublicHttpsUrl(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLocaleLowerCase();
    return (
      url.protocol === "https:" &&
      hostname !== "localhost" &&
      hostname !== "127.0.0.1" &&
      hostname !== "::1" &&
      !hostname.endsWith(".local")
    );
  } catch {
    return false;
  }
}

function isSupportedRepositoryUrl(value) {
  if (typeof value !== "string" || value.length === 0) return false;
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

function isYouTubeUrl(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const url = new URL(value);
    return ["youtube.com", "www.youtube.com", "youtu.be"].includes(
      url.hostname.toLocaleLowerCase(),
    );
  } catch {
    return false;
  }
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  addResult(true, "The machine-readable Devpost requirements manifest parses as JSON.");
} catch (error) {
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
    "The live Reader's bounded PDF-source read and structured mentor stage were verified through WebMCP.",
    "Run the released signed-in Reader flow over public HTTPS in a supported WebMCP client and record both observed callbacks.",
  );
  addResult(
    manual.paperAgnosticPdfFlowVerified === true,
    "The released flow was verified with previously unseen admitted PDFs and no paper-specific configuration.",
    "Run the canonical born-digital, figure-rich, weak-text/scanned, and unsupported-PDF matrix without changing product code or configuration.",
  );
  addResult(
    manual.requiredSelectionKindsVerified === true,
    "Every required text, visual, and same-paper synthesis selection kind was verified in the release.",
    "Verify exact text, page region, whole figure, figure region, and same-paper synthesis against the deployed Reader.",
  );
  addResult(
    manual.observableWebMcpActivityVerified === true,
    "The released activity trail was verified to stop at events PaperPilot actually observed.",
    "Record the tools-ready, bounded-read, structured-stage, read-without-stage, and registration-failure states without claiming hidden agent activity.",
  );
  addResult(
    manual.accessibilityPrimaryFlowVerified === true,
    "The primary release flow has dated keyboard and screen-reader verification.",
    "Complete and record the keyboard-only and screen-reader walkthroughs, including the tested client and assistive-technology versions.",
  );
  addResult(
    manual.truthfulFallbackVerified === true,
    "The non-WebMCP path preserves the required local-review label and cannot appear as native proof.",
    "Verify that Local review—WebMCP was not invoked persists in status, response, trail, and saved note.",
  );

  const productScope = readText(judge.productScopePath ?? "");
  const productRequirements = readText(judge.productRequirementsPath ?? "");
  const productDocs = `${productScope}\n${productRequirements}`;
  const requiredSelectionKinds = [
    "exact-text",
    "page-region",
    "whole-figure",
    "figure-region",
    "same-paper-synthesis",
  ];
  const requiredWebMcpCapabilities = [
    "read-bounded-active-pdf-selection",
    "stage-structured-mentor-explanation",
  ];

  addResult(
    judge.requiresPaperAgnosticPdfFlow === true &&
      judge.prohibitsPaperSpecificDemoLogic === true,
    "The manifest requires a paper-agnostic PDF flow and forbids paper-specific demo logic.",
    "Keep both PaperPilot PDF scope guards enabled in devpost-requirements.json.",
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
    requiredSelectionKinds.every((kind) =>
      judge.requiredSelectionKinds?.includes(kind),
    ),
    "The judge contract requires exact text, page/figure regions, whole figures, and same-paper synthesis.",
    "Restore every approved selection kind under judgeExperience.requiredSelectionKinds.",
  );
  addResult(
    requiredWebMcpCapabilities.every((capability) =>
      judge.requiredWebMcpCapabilities?.includes(capability),
    ),
    "The judge contract requires bounded PDF-source reading and structured mentor-response staging.",
    "Restore both approved Reader WebMCP capabilities under judgeExperience.requiredWebMcpCapabilities.",
  );

  const judgeGuide = readText(judge.instructionsPath ?? "");
  addResult(
    /previously unseen[\s,-]+admitted PDF/i.test(judgeGuide) &&
      judgeGuide.includes("Local review—WebMCP was not invoked") &&
      !/\blaminography\b|source fixture|local fixture/i.test(judgeGuide),
    "The judge guide documents the current PDF flow and truthful non-WebMCP fallback.",
    "Align the judge guide with the guided Scope/PRD and remove deterministic webpage-fixture instructions.",
  );

  const integrationSource = readText(judge.paperPilotToolIntegrationPath ?? "");
  const registrationCall =
    /\bregisterPaperPilot[A-Za-z0-9]*Tools\s*\(/.test(integrationSource) ||
    /\bmodelContext\.registerTool\s*\(/.test(integrationSource);
  addResult(
    isFile(judge.paperPilotToolIntegrationPath) && registrationCall,
    "Application code invokes the PaperPilot Reader WebMCP registration adapter.",
    `Mount the Reader's PaperPilot WebMCP registration adapter in ${judge.paperPilotToolIntegrationPath || "the declared integration path"}.`,
  );

  addResult(
    Array.isArray(judge.testedClients) && judge.testedClients.length > 0,
    "At least one released WebMCP client/version is recorded as tested.",
    "After testing the public release, add the exact client and version under judgeExperience.testedClients.",
  );
  addResult(
    Array.isArray(submission.webMcpClients) && submission.webMcpClients.length > 0,
    "The submission answers disclose which WebMCP clients were used.",
    "Record only clients actually used and tested in submissionAnswers.webMcpClients.",
  );

  addResult(
    isYouTubeUrl(artifacts.demoVideoUrl),
    "The manifest contains a public YouTube demo URL.",
    "Publish the final demo to YouTube and set publicArtifacts.demoVideoUrl.",
  );
  addResult(
    manual.demoVideoUnderThreeMinutes === true,
    "The final demo was manually verified to be under three minutes.",
    "Measure the public video's duration and record the manual verification.",
  );
  addResult(
    manual.demoVideoHasExplanatoryAudio === true,
    "The final demo was manually verified to include explanatory audio.",
    "Watch the public video with sound and record the manual verification.",
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
  );
  addResult(
    manual.submissionNotDraft === true,
    "A human verified that the Devpost entry is submitted, not a draft.",
    "Complete the final Devpost review and set this only after the site confirms submission.",
  );
}

const failures = results.filter((result) => !result.passed);
for (const result of results) {
  const marker = result.passed ? "PASS" : "FAIL";
  console.log(`${marker}  ${result.requirement}`);
  if (!result.passed && result.remediation) {
    console.log(`      ${result.remediation}`);
  }
}

console.log("");
console.log(
  `Devpost readiness: ${results.length - failures.length}/${results.length} controls pass; ${failures.length} remain open.`,
);

if (failures.length > 0) {
  process.exitCode = 1;
}
