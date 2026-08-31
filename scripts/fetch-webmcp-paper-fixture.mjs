import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, link, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const papersDirectory = path.join(repositoryRoot, "spikes", "webmcp-contract", "assets", "papers");
const manifestPath = path.join(
  papersDirectory,
  "attention-is-all-you-need-1706.03762v7.source.json",
);

const argumentsSet = new Set(process.argv.slice(2));
const supportedArguments = new Set(["--verify-only"]);
for (const argument of argumentsSet) {
  if (!supportedArguments.has(argument)) {
    throw new Error(`Unsupported argument: ${argument}`);
  }
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requirePositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function requireSha256(value, label) {
  const digest = requireString(value, label);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return digest;
}

function isArxivHost(hostname) {
  return hostname === "arxiv.org" || hostname.endsWith(".arxiv.org");
}

async function readManifest() {
  const manifest = requireObject(JSON.parse(await readFile(manifestPath, "utf8")), "manifest");
  const paper = requireObject(manifest.paper, "manifest.paper");
  const source = requireObject(manifest.source, "manifest.source");
  const fixture = requireObject(manifest.localFixture, "manifest.localFixture");
  const observation = requireObject(manifest.transportObservation, "manifest.transportObservation");

  const title = requireString(paper.title, "manifest.paper.title");
  const pageCount = requirePositiveSafeInteger(paper.pageCount, "manifest.paper.pageCount");
  const pdfUrl = new URL(requireString(source.pdfUrl, "manifest.source.pdfUrl"));
  if (pdfUrl.protocol !== "https:" || !isArxivHost(pdfUrl.hostname)) {
    throw new Error("manifest.source.pdfUrl must be an HTTPS arXiv URL.");
  }

  const filename = requireString(fixture.filename, "manifest.localFixture.filename");
  if (filename !== path.basename(filename) || !filename.toLowerCase().endsWith(".pdf")) {
    throw new Error("manifest.localFixture.filename must be a plain PDF filename.");
  }

  const expectedByteLength = requirePositiveSafeInteger(
    fixture.pdfByteLength,
    "manifest.localFixture.pdfByteLength",
  );
  const observedByteLength = requirePositiveSafeInteger(
    observation.contentLengthBytes,
    "manifest.transportObservation.contentLengthBytes",
  );
  if (expectedByteLength !== observedByteLength) {
    throw new Error("The PDF-byte length and observed transport content length must agree.");
  }

  return {
    expectedByteLength,
    expectedSha256: requireSha256(fixture.pdfByteSha256, "manifest.localFixture.pdfByteSha256"),
    filename,
    pageCount,
    pdfUrl,
    title,
  };
}

function verifyPdfBytes(bytes, fixture) {
  if (bytes.byteLength !== fixture.expectedByteLength) {
    throw new Error(
      `PDF byte length mismatch: expected ${fixture.expectedByteLength}, received ${bytes.byteLength}.`,
    );
  }
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("Downloaded bytes do not begin with a PDF signature.");
  }

  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== fixture.expectedSha256) {
    throw new Error(`PDF SHA-256 mismatch: expected ${fixture.expectedSha256}, received ${actualSha256}.`);
  }
  return actualSha256;
}

async function fileExists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function verifyLocalFile(targetPath, fixture) {
  const bytes = await readFile(targetPath);
  const sha256 = verifyPdfBytes(bytes, fixture);
  console.log(`Verified ${fixture.title} (${fixture.pageCount} expected pages).`);
  console.log(`Local PDF: ${targetPath}`);
  console.log(`Bytes: ${bytes.byteLength}`);
  console.log(`SHA-256: ${sha256}`);
}

async function fetchFixture(fixture) {
  const response = await fetch(fixture.pdfUrl, {
    headers: { Accept: "application/pdf" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`arXiv PDF fetch failed with HTTP ${response.status}.`);
  }

  const responseUrl = new URL(response.url);
  if (responseUrl.protocol !== "https:" || !isArxivHost(responseUrl.hostname)) {
    throw new Error(`arXiv PDF fetch redirected to an unexpected origin: ${responseUrl.origin}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/pdf")) {
    throw new Error(`arXiv PDF fetch returned unexpected Content-Type: ${contentType || "missing"}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  verifyPdfBytes(bytes, fixture);
  return bytes;
}

const fixture = await readManifest();
const targetPath = path.join(papersDirectory, fixture.filename);

if (await fileExists(targetPath)) {
  await verifyLocalFile(targetPath, fixture);
} else if (argumentsSet.has("--verify-only")) {
  throw new Error(`Local PDF is missing: ${targetPath}`);
} else {
  const bytes = await fetchFixture(fixture);
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.download`;
  await writeFile(temporaryPath, bytes, { flag: "wx" });
  try {
    await link(temporaryPath, targetPath);
  } finally {
    await unlink(temporaryPath);
  }
  await verifyLocalFile(targetPath, fixture);
}
